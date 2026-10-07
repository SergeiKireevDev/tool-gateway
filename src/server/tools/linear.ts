import { OperationTypeNode } from 'graphql';
import { GraphQLRequestError, inspectGraphQLRequest, type RootField } from './graphql.js';
import { isRecord } from './json.js';
import type {
  AuthzAllowed,
  AuthzDecision,
  Grant,
  PermissionDef,
  ToolProvider,
  ToolRequest,
} from './types.js';

/**
 * Linear: one GraphQL endpoint (`POST https://api.linear.app/graphql`), so authorization reads
 * the document. Every root field needs a rule. Team-restricted grants (allowlist of team keys,
 * e.g. ENG) also need every issue, comment and team a request names to be in an allowed team
 * (looked up through the API), issue lists to filter on allowed team keys, and nested reads to
 * stay within what they hang off.
 */

const API = 'https://api.linear.app';
const GRAPHQL_PATH = 'graphql';
const USER_AGENT = 'local-gateway';
const TEAM_KEY_RE = /^[A-Za-z0-9]{1,10}$/;
/** Entities looked up per request on team-restricted grants. */
const MAX_LOOKUPS = 50;

const PERM = {
  ISSUES_READ: 'issues:read',
  ISSUES_WRITE: 'issues:write',
  COMMENTS_WRITE: 'comments:write',
  PROJECTS_READ: 'projects:read',
  PROJECTS_WRITE: 'projects:write',
  WORKSPACE_READ: 'workspace:read',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.ISSUES_READ,
    label: 'Issues (read)',
    description:
      'Issues, their comments, labels and attachments. Team-restricted templates must filter issue lists on their teams.',
  },
  {
    id: PERM.ISSUES_WRITE,
    label: 'Issues (write)',
    description: 'Create, update, archive and delete issues; add or remove labels; link URLs.',
  },
  {
    id: PERM.COMMENTS_WRITE,
    label: 'Comments (write)',
    description: 'Comment on issues, edit and delete comments.',
  },
  {
    id: PERM.PROJECTS_READ,
    label: 'Projects (read)',
    description: 'Projects and their updates. Projects span teams: needs an unrestricted template.',
  },
  {
    id: PERM.PROJECTS_WRITE,
    label: 'Projects (write)',
    description: 'Create and update projects. Needs an unrestricted template.',
  },
  {
    id: PERM.WORKSPACE_READ,
    label: 'Workspace directory (read)',
    description:
      'Current user, users, teams, workflow states, labels and the organization. Not limited by the team allowlist.',
  },
];

/** What a root field names, for team-restricted grants. */
type Target = 'issue' | 'team' | 'comment';

interface Scope {
  /** Path of the argument, e.g. `id` or `input.teamId`. */
  arg: string;
  target: Target;
  optional?: boolean;
}

/**
 * `'workspace'`: directory data, fine on restricted grants. `'all-teams'`: can reach teams it
 * doesn't name, only on unrestricted grants. `'issue-list'`: a list that must filter on teams.
 */
type FieldScope = readonly Scope[] | typeof WORKSPACE | typeof ALL_TEAMS | typeof ISSUE_LIST;
const WORKSPACE = 'workspace';
const ALL_TEAMS = 'all-teams';
const ISSUE_LIST = 'issue-list';

interface FieldRule {
  permission: string;
  scope: FieldScope;
}

const rules = (permission: string, scope: FieldScope, names: readonly string[]) =>
  names.map((name) => [name, { permission, scope }] as const);

const ISSUE_ID: Scope = { arg: 'id', target: 'issue' };

const QUERY_RULES = new Map<string, FieldRule>([
  ...rules(PERM.WORKSPACE_READ, WORKSPACE, [
    'viewer',
    'users',
    'user',
    'teams',
    'organization',
    'workflowStates',
    'workflowState',
    'issueLabels',
    'issueLabel',
  ]),
  ...rules(PERM.WORKSPACE_READ, [{ arg: 'id', target: 'team' }], ['team']),
  ...rules(PERM.ISSUES_READ, [ISSUE_ID], ['issue']),
  ...rules(PERM.ISSUES_READ, ISSUE_LIST, ['issues']),
  ...rules(PERM.ISSUES_READ, [{ arg: 'id', target: 'comment' }], ['comment']),
  ...rules(PERM.ISSUES_READ, ALL_TEAMS, ['searchIssues', 'issueSearch', 'comments', 'attachments']),
  ...rules(PERM.PROJECTS_READ, ALL_TEAMS, ['project', 'projects', 'projectUpdates']),
]);

const MUTATION_RULES = new Map<string, FieldRule>([
  ...rules(PERM.ISSUES_WRITE, [{ arg: 'input.teamId', target: 'team' }], ['issueCreate']),
  ...rules(
    PERM.ISSUES_WRITE,
    [ISSUE_ID, { arg: 'input.teamId', target: 'team', optional: true }],
    ['issueUpdate'],
  ),
  ...rules(
    PERM.ISSUES_WRITE,
    [ISSUE_ID],
    ['issueArchive', 'issueUnarchive', 'issueDelete', 'issueAddLabel', 'issueRemoveLabel'],
  ),
  ...rules(PERM.ISSUES_WRITE, [{ arg: 'issueId', target: 'issue' }], ['attachmentLinkURL']),
  ...rules(PERM.ISSUES_WRITE, [{ arg: 'input.issueId', target: 'issue' }], ['attachmentCreate']),
  ...rules(PERM.COMMENTS_WRITE, [{ arg: 'input.issueId', target: 'issue' }], ['commentCreate']),
  ...rules(
    PERM.COMMENTS_WRITE,
    [{ arg: 'id', target: 'comment' }],
    ['commentUpdate', 'commentDelete'],
  ),
  ...rules(PERM.PROJECTS_WRITE, ALL_TEAMS, ['projectCreate', 'projectUpdate']),
]);

/** Harmless for any valid session: introspection and `__typename`. */
const ALWAYS_ALLOWED = new Set(['__schema', '__type', '__typename']);

/**
 * Nested object fields allowed on team-restricted grants: they stay with the issue / team they
 * hang off. Anything else that selects sub-fields (e.g. `issues`, `children`, `project`,
 * `assignedIssues`) could reach other teams and is denied there.
 */
const TRAVERSALS = new Set([
  'team',
  'state',
  'assignee',
  'creator',
  'user',
  'labels',
  'comments',
  'attachments',
  'nodes',
  'edges',
  'node',
  'pageInfo',
  'organization',
  'issue',
  'comment',
  'lastSyncId',
]);

class Denied extends Error {}

/** The value at a dotted path of the arguments (`input.teamId`). */
function argAt(args: Record<string, unknown>, path: string): unknown {
  let value: unknown = args;
  for (const key of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Team keys an `issues(filter:)` is limited to: `filter.team.key.eq` or `.in`. Top-level `or`
 * would widen it, so it is refused.
 */
function filteredTeams(args: Record<string, unknown>): string[] {
  const filter = args.filter;
  if (!isRecord(filter) || 'or' in filter) {
    throw new Denied(
      'On team-restricted templates, "issues" must filter on team.key (without "or")',
    );
  }
  const key = argAt(filter, 'team.key');
  if (isRecord(key) && typeof key.eq === 'string') return [key.eq];
  if (
    isRecord(key) &&
    Array.isArray(key.in) &&
    key.in.length > 0 &&
    key.in.every((k) => typeof k === 'string')
  ) {
    return key.in;
  }
  throw new Denied(
    'On team-restricted templates, "issues" must filter on team.key with "eq" or "in"',
  );
}

interface Targets {
  teamKeys: Set<string>;
  lookups: { target: Target; id: string }[];
}

function ruleFor(field: RootField): FieldRule {
  const table = field.operation === OperationTypeNode.MUTATION ? MUTATION_RULES : QUERY_RULES;
  const rule =
    field.operation === OperationTypeNode.SUBSCRIPTION ? undefined : table.get(field.name);
  if (!rule)
    throw new Denied(`${field.operation} "${field.name}" is not covered by any gateway permission`);
  return rule;
}

function addTargets(field: RootField, scope: FieldScope, targets: Targets): void {
  if (scope === WORKSPACE) return;
  if (scope === ALL_TEAMS) {
    throw new Denied(
      `"${field.name}" can't be limited to teams: it needs an unrestricted template`,
    );
  }
  if (scope === ISSUE_LIST) {
    for (const key of filteredTeams(field.args)) targets.teamKeys.add(key.toUpperCase());
    return;
  }
  for (const { arg, target, optional } of scope) {
    const value = argAt(field.args, arg);
    if (optional && (value === undefined || value === null)) continue;
    if (typeof value !== 'string' || value === '') {
      throw new Denied(
        `"${field.name}" must name its ${target} in "${arg}" on team-restricted templates`,
      );
    }
    targets.lookups.push({ target, id: value });
  }
}

/** On restricted grants, nested reads must be known traversals; mutation results need a read permission. */
function checkNested(field: RootField, grant: Grant, restricted: boolean): void {
  if (field.name === '__schema' || field.name === '__type') return;
  const canRead = grant.permissions.some((p) => p.endsWith(':read'));
  for (const nested of field.nested) {
    if (!nested.hasSelection) continue;
    if (field.operation === OperationTypeNode.MUTATION && !canRead) {
      throw new Denied(
        `Reading "${nested.name}" from the result of "${field.name}" needs a read permission`,
      );
    }
    if (restricted && !TRAVERSALS.has(nested.name)) {
      throw new Denied(
        `Nested field "${nested.name}" can reach other teams: not allowed on team-restricted templates`,
      );
    }
  }
}

const LOOKUP_FIELD: Record<Target, { field: string; selection: string }> = {
  issue: { field: 'issue', selection: 'team { key }' },
  team: { field: 'team', selection: 'key' },
  comment: { field: 'comment', selection: 'issue { team { key } }' },
};

/** The team key in a lookup result, for each target kind. */
function teamKeyOf(target: Target, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (target === 'team') return typeof value.key === 'string' ? value.key : undefined;
  if (target === 'issue')
    return isRecord(value.team) && typeof value.team.key === 'string' ? value.team.key : undefined;
  return teamKeyOf('issue', value.issue);
}

export function createLinearProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  const graphql = async (secret: string, query: string, variables: object = {}) => {
    const res = await fetchImpl(`${API}/${GRAPHQL_PATH}`, {
      method: 'POST',
      headers: {
        authorization: secret,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json: unknown = res.ok ? await res.json() : null;
    return { status: res.status, json };
  };

  /** Resolves every named issue / team / comment to its team key, in one aliased query. */
  const lookupTeams = async (lookups: Targets['lookups'], secret: string): Promise<string[]> => {
    if (lookups.length === 0) return [];
    if (lookups.length > MAX_LOOKUPS) {
      throw new Denied(
        `At most ${MAX_LOOKUPS} issues, comments or teams per request on team-restricted templates`,
      );
    }
    const vars = lookups.map((_, i) => `$v${String(i)}: String!`).join(', ');
    const fields = lookups
      .map(({ target }, i) => {
        const { field, selection } = LOOKUP_FIELD[target];
        return `l${String(i)}: ${field}(id: $v${String(i)}) { ${selection} }`;
      })
      .join(' ');
    const variables = Object.fromEntries(lookups.map(({ id }, i) => [`v${String(i)}`, id]));
    const { json } = await graphql(secret, `query (${vars}) { ${fields} }`, variables).catch(
      () => ({ json: null }),
    );
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    if (!data) throw new Denied('Could not check which teams the request touches');
    return lookups.map(({ target, id }, i) => {
      const key = teamKeyOf(target, data[`l${String(i)}`]);
      if (!key) throw new Denied(`${target} ${id} was not found`);
      return key.toUpperCase();
    });
  };

  const authorizeGraphQL = async (
    request: ToolRequest,
    grant: Grant,
    secret: string,
  ): Promise<AuthzAllowed> => {
    const { rootFields, body } = inspectGraphQLRequest(request.body);
    const restricted = grant.resources.length > 0;
    const targets: Targets = { teamKeys: new Set(), lookups: [] };
    const used = new Set<string>();
    for (const field of rootFields) {
      if (ALWAYS_ALLOWED.has(field.name)) continue;
      const rule = ruleFor(field);
      if (!grant.permissions.includes(rule.permission)) {
        throw new Denied(`Missing permission "${rule.permission}" (for "${field.name}")`);
      }
      used.add(rule.permission);
      checkNested(field, grant, restricted);
      if (restricted) addTargets(field, rule.scope, targets);
    }
    if (restricted) {
      const allowed = new Set(grant.resources.map((r) => r.toUpperCase()));
      for (const key of [...targets.teamKeys, ...(await lookupTeams(targets.lookups, secret))]) {
        if (!allowed.has(key)) throw new Denied(`Team ${key} is not in the allowlist`);
      }
    }
    const detail = [...new Set(rootFields.map((f) => `${f.operation} ${f.name}`))].join(', ');
    return {
      allowed: true,
      permission: used.size > 0 ? [...used].join(', ') : 'meta',
      detail,
      body,
    };
  };

  return {
    id: 'linear',
    name: 'Linear',
    credentialHelp:
      'Personal API key (Linear → Settings → Security & access → Personal API keys). The gateway can never grant more than this key allows.',
    credentialPlaceholder: 'lin_api_…',
    resourceHelp:
      'One team key per line (e.g. ENG, the prefix of its issue IDs). Leave empty to allow every team the key can reach.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: `/${GRAPHQL_PATH}`,
      body: '{"query":"query { viewer { id name } }"}',
      clientHint: 'GraphQL endpoint: POST /graphql',
    },

    validateResource(pattern) {
      return TEAM_KEY_RE.test(pattern) ? null : `Invalid team key "${pattern}"`;
    },

    async verifyCredential(secret) {
      const { status, json } = await graphql(
        secret,
        'query { viewer { id name email } organization { name urlKey } }',
      );
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      const viewer = data && isRecord(data.viewer) ? data.viewer : null;
      if (!viewer) throw new Error(`Linear rejected the key (HTTP ${status})`);
      const identity: Record<string, string> = {
        login: typeof viewer.email === 'string' ? viewer.email : 'unknown',
        userId: typeof viewer.id === 'string' ? viewer.id : '',
      };
      if (typeof viewer.name === 'string') identity.name = viewer.name;
      const org = data && isRecord(data.organization) ? data.organization : null;
      if (org && typeof org.name === 'string') identity.workspace = org.name;
      return identity;
    },

    async authorize(request, grant, { secret }): Promise<AuthzDecision> {
      const [first, ...rest] = request.segments;
      if (request.method.toUpperCase() !== 'POST' || first !== GRAPHQL_PATH || rest.length > 0) {
        return { allowed: false, reason: `Only POST /${GRAPHQL_PATH} (GraphQL) is supported` };
      }
      if (request.search !== '')
        return { allowed: false, reason: 'Pass the query in the JSON body, not the URL' };
      try {
        return await authorizeGraphQL(request, grant, secret);
      } catch (err) {
        if (err instanceof Denied || err instanceof GraphQLRequestError)
          return { allowed: false, reason: err.message };
        throw err;
      }
    },

    upstreamHeaders(secret) {
      return new Headers({
        accept: 'application/json',
        // The body is always the gateway's re-serialized JSON.
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        // Personal API keys go bare; OAuth tokens as Bearer.
        authorization: secret.startsWith('lin_') ? secret : `Bearer ${secret}`,
      });
    },
  };
}
