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
 * monday.com: one GraphQL endpoint (`POST https://api.monday.com/v2`), so authorization reads
 * the document. Every root field needs a rule; board-restricted grants additionally require
 * each field to name its boards or items, which are checked against the allowlist.
 */

const API = 'https://api.monday.com';
const GRAPHQL_PATH = 'v2';
const USER_AGENT = 'local-gateway';
const BOARD_ID_RE = /^\d{1,20}$/;
/** `items(ids:)` returns at most this many items per call. */
const MAX_ITEMS_PER_LOOKUP = 100;
/** Pagination cursors remembered per session, and sessions remembered, for restricted grants. */
const MAX_CURSORS_PER_SESSION = 500;
const MAX_TRACKED_SESSIONS = 1000;

const PERM = {
  ACCOUNT_READ: 'account:read',
  BOARDS_READ: 'boards:read',
  BOARDS_WRITE: 'boards:write',
  ITEMS_WRITE: 'items:write',
  UPDATES_WRITE: 'updates:write',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.BOARDS_READ,
    label: 'Boards (read)',
    description: 'Boards, groups, columns, items, subitems, column values and updates (comments).',
  },
  {
    id: PERM.ITEMS_WRITE,
    label: 'Items (write)',
    description:
      'Create, edit, move, duplicate, archive and delete items and subitems; change column values.',
  },
  {
    id: PERM.UPDATES_WRITE,
    label: 'Updates (write)',
    description: 'Post updates (comments) on items and clear them.',
  },
  {
    id: PERM.BOARDS_WRITE,
    label: 'Board structure (write)',
    description:
      'Rename, archive, delete and duplicate boards; manage groups and columns. Creating boards needs an unrestricted template.',
  },
  {
    id: PERM.ACCOUNT_READ,
    label: 'Account directory (read)',
    description:
      'Current user, users, teams, account, workspaces, folders and tags. Not limited by the board allowlist.',
  },
];

type ScopeKind = 'board' | 'item' | 'cursor';

interface Scope {
  arg: string;
  kind: ScopeKind;
  /** Optional arguments are only checked when present. */
  optional?: boolean;
}

/**
 * How a root field is tied to boards:
 *  - a list of arguments naming its boards / items / pagination cursor;
 *  - `'account'`: not board data, allowed on board-restricted grants;
 *  - `'all-boards'`: can reach boards it doesn't name, only allowed on unrestricted grants.
 */
type FieldScope = readonly Scope[] | typeof ACCOUNT | typeof ALL_BOARDS;
const ACCOUNT = 'account';
const ALL_BOARDS = 'all-boards';

interface FieldRule {
  permission: string;
  scope: FieldScope;
}

const BOARD_ID: Scope = { arg: 'board_id', kind: 'board' };
const ITEM_ID: Scope = { arg: 'item_id', kind: 'item' };
const CURSOR: Scope = { arg: 'cursor', kind: 'cursor' };

const rules = (permission: string, scope: FieldScope, names: readonly string[]) =>
  names.map((name) => [name, { permission, scope }] as const);

const QUERY_RULES = new Map<string, FieldRule>([
  ...rules(PERM.ACCOUNT_READ, ACCOUNT, [
    'me',
    'users',
    'teams',
    'account',
    'workspaces',
    'folders',
    'tags',
  ]),
  ...rules(PERM.BOARDS_READ, [{ arg: 'ids', kind: 'board' }], ['boards']),
  ...rules(PERM.BOARDS_READ, [{ arg: 'ids', kind: 'item' }], ['items']),
  ...rules(
    PERM.BOARDS_READ,
    [BOARD_ID, { ...CURSOR, optional: true }],
    ['items_page_by_column_values'],
  ),
  ...rules(PERM.BOARDS_READ, [CURSOR], ['next_items_page']),
  ...rules(PERM.BOARDS_READ, ALL_BOARDS, ['updates', 'assets']),
]);

const MUTATION_RULES = new Map<string, FieldRule>([
  ...rules(PERM.ITEMS_WRITE, [BOARD_ID], ['create_item']),
  ...rules(PERM.ITEMS_WRITE, [{ arg: 'parent_item_id', kind: 'item' }], ['create_subitem']),
  ...rules(
    PERM.ITEMS_WRITE,
    [BOARD_ID, ITEM_ID],
    [
      'duplicate_item',
      'move_item_to_board',
      'change_column_value',
      'change_simple_column_value',
      'change_multiple_column_values',
    ],
  ),
  ...rules(
    PERM.ITEMS_WRITE,
    [ITEM_ID],
    [
      'move_item_to_group',
      'change_item_position',
      'set_item_description_content',
      'archive_item',
      'delete_item',
    ],
  ),
  ...rules(PERM.UPDATES_WRITE, [ITEM_ID], ['create_update', 'clear_item_updates']),
  // These take an update ID: which board it is on can't be checked cheaply.
  ...rules(PERM.UPDATES_WRITE, ALL_BOARDS, [
    'edit_update',
    'delete_update',
    'like_update',
    'unlike_update',
    'pin_to_top',
    'unpin_from_top',
  ]),
  ...rules(PERM.BOARDS_WRITE, ALL_BOARDS, ['create_board']),
  ...rules(
    PERM.BOARDS_WRITE,
    [BOARD_ID],
    [
      'duplicate_board',
      'update_board',
      'archive_board',
      'delete_board',
      'create_group',
      'update_group',
      'duplicate_group',
      'archive_group',
      'delete_group',
      'create_column',
      'change_column_title',
      'change_column_metadata',
      'update_column',
      'delete_column',
    ],
  ),
]);

/** Harmless for any valid session: query cost, API versions, introspection. */
const ALWAYS_ALLOWED = new Set([
  'complexity',
  'version',
  'versions',
  '__schema',
  '__type',
  '__typename',
]);
const INTROSPECTION = new Set(['__schema', '__type']);

/**
 * Nested object fields that stay within the board (or user) they hang off. Anything else
 * returning an object is denied: new schema fields must be reviewed before they are allowed.
 */
const TRAVERSALS = new Set([
  // boards, groups, items
  'items_page',
  'items',
  'groups',
  'group',
  'top_group',
  'columns',
  'column',
  'column_values',
  'capabilities',
  'views',
  'board',
  'subitems',
  'parent_item',
  'description',
  'blocks',
  'workspace',
  'folder',
  'tags',
  'activity_logs',
  // updates and files
  'updates',
  'replies',
  'assets',
  'likes',
  'viewers',
  'pinned_to_top',
  'item',
  'uploaded_by',
  // people
  'creator',
  'owners',
  'subscribers',
  'team_owners',
  'team_subscribers',
  'owners_subscribers',
  'users_subscribers',
  'teams_subscribers',
  'team_owners_subscribers',
  'user',
  'users',
  'teams',
  'account',
  'plan',
  'products',
  'out_of_office',
  'settings',
  'icon',
  'account_product',
]);

/** Nested fields that lead to other boards: only for unrestricted grants with boards:read. */
const CROSS_BOARD_TRAVERSALS = new Set([
  'linked_items',
  'mirrored_items',
  'linked_board',
  'children',
]);

/** Pagination cursors a restricted session was given, so it can only page through those. */
class CursorMemory {
  private readonly bySession = new Map<string, Set<string>>();

  remember(sessionId: string, cursors: readonly string[]): void {
    if (cursors.length === 0) return;
    const set = this.bySession.get(sessionId) ?? new Set();
    this.bySession.delete(sessionId); // re-insert: Map order doubles as least-recently-used
    this.bySession.set(sessionId, set);
    for (const cursor of cursors) set.add(cursor);
    for (const old of set) {
      if (set.size <= MAX_CURSORS_PER_SESSION) break;
      set.delete(old);
    }
    for (const old of this.bySession.keys()) {
      if (this.bySession.size <= MAX_TRACKED_SESSIONS) break;
      this.bySession.delete(old);
    }
  }

  knows(sessionId: string, cursor: string): boolean {
    return this.bySession.get(sessionId)?.has(cursor) ?? false;
  }
}

/** Every string under a `cursor` key in the response's `data`. */
function cursorsIn(json: unknown): string[] {
  const out: string[] = [];
  const pending: unknown[] = [isRecord(json) ? json.data : undefined];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
    } else if (isRecord(next)) {
      for (const [key, value] of Object.entries(next)) {
        if (key === 'cursor' && typeof value === 'string') out.push(value);
        else if (typeof value === 'object' && value !== null) pending.push(value);
      }
    }
  }
  return out;
}

/** Board / item IDs from an argument value (`123`, `"123"` or a list of them); null if unusable. */
function idList(value: unknown): string[] | null {
  const values = Array.isArray(value) ? (value as unknown[]) : [value];
  const ids: string[] = [];
  for (const v of values) {
    const id = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
    if (typeof id !== 'string' || !BOARD_ID_RE.test(id)) return null;
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

class Denied extends Error {}

/** What a board-restricted request touches, gathered before checking it against the grant. */
interface Targets {
  boards: Set<string>;
  items: Set<string>;
  cursors: Set<string>;
}

function ruleFor(field: RootField): FieldRule {
  const table = field.operation === OperationTypeNode.MUTATION ? MUTATION_RULES : QUERY_RULES;
  const rule =
    field.operation === OperationTypeNode.SUBSCRIPTION ? undefined : table.get(field.name);
  if (!rule) {
    throw new Denied(`${field.operation} "${field.name}" is not covered by any gateway permission`);
  }
  return rule;
}

/** Nested traversals must be known, and must not leave the board unless the grant allows it. */
function checkNested(field: RootField, grant: Grant): void {
  if (INTROSPECTION.has(field.name)) return;
  const canRead = grant.permissions.includes(PERM.BOARDS_READ);
  const crossBoardOk = canRead && grant.resources.length === 0;
  for (const nested of field.nested) {
    if (!nested.hasSelection) continue;
    if (field.operation === OperationTypeNode.MUTATION && !canRead) {
      throw new Denied(
        `Reading "${nested.name}" from the result of "${field.name}" needs "${PERM.BOARDS_READ}"`,
      );
    }
    if (CROSS_BOARD_TRAVERSALS.has(nested.name)) {
      if (crossBoardOk) continue;
      throw new Denied(
        `"${nested.name}" reaches other boards: it needs "${PERM.BOARDS_READ}" on an unrestricted template`,
      );
    }
    if (!TRAVERSALS.has(nested.name)) {
      throw new Denied(`Nested field "${nested.name}" is not supported by the gateway`);
    }
  }
}

function addTargets(field: RootField, scope: FieldScope, targets: Targets): void {
  if (scope === ACCOUNT) return;
  if (scope === ALL_BOARDS) {
    throw new Denied(
      `"${field.name}" can't be limited to boards: it needs an unrestricted template`,
    );
  }
  for (const { arg, kind, optional } of scope) {
    const value = field.args[arg];
    if (optional && (value === undefined || value === null)) continue;
    if (kind === 'cursor') {
      if (typeof value !== 'string') throw new Denied(`"${field.name}" needs a "${arg}"`);
      targets.cursors.add(value);
      continue;
    }
    const ids = idList(value);
    if (!ids) {
      throw new Denied(
        `"${field.name}" must name its ${kind}s in "${arg}" on board-restricted templates`,
      );
    }
    for (const id of ids) targets[kind === 'board' ? 'boards' : 'items'].add(id);
  }
  addNestedCursors(field, targets);
}

/** Nested `items_page(cursor:)` pages through whatever board the cursor was issued for. */
function addNestedCursors(field: RootField, targets: Targets): void {
  for (const nested of field.nested) {
    const cursor = nested.args.cursor;
    if (cursor === undefined || cursor === null) continue;
    if (typeof cursor !== 'string') throw new Denied(`"${nested.name}" has an invalid cursor`);
    targets.cursors.add(cursor);
  }
}

/** Shape of the gateway's own item lookup (IDs come back as strings, but don't rely on it). */
interface ItemBoards {
  id: string | number;
  board?: { id?: string | number } | null;
  parent_item?: { board?: { id?: string | number } | null } | null;
}

/** A string (or number) field of an untyped GraphQL result, else undefined. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : undefined;
}

export function createMondayProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  const cursors = new CursorMemory();

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

  /** Subitems live on their own board: they count as part of their parent's board. */
  const checkItems = async (items: Set<string>, allowed: Set<string>, secret: string) => {
    if (items.size === 0) return;
    if (items.size > MAX_ITEMS_PER_LOOKUP) {
      throw new Denied(
        `At most ${MAX_ITEMS_PER_LOOKUP} items per request on board-restricted templates`,
      );
    }
    const { json } = await graphql(
      secret,
      'query ($ids: [ID!], $limit: Int) { items(ids: $ids, limit: $limit) { id board { id } parent_item { board { id } } } }',
      { ids: [...items], limit: items.size },
    ).catch(() => ({ json: null }));
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    if (!data || !Array.isArray(data.items)) {
      throw new Denied('Could not check which boards the items are on');
    }
    const found = new Map((data.items as ItemBoards[]).map((i) => [String(i.id), i]));
    for (const id of items) {
      const item = found.get(id);
      if (!item) throw new Denied(`Item ${id} was not found`);
      const boards = [item.board?.id, item.parent_item?.board?.id];
      if (!boards.some((b) => b !== undefined && allowed.has(String(b)))) {
        throw new Denied(`Item ${id} is not on an allowed board`);
      }
    }
  };

  /** Board-restricted grants: everything the request names must be on an allowed board. */
  const checkTargets = async (
    targets: Targets,
    grant: Grant,
    sessionId: string,
    secret: string,
  ) => {
    const allowed = new Set(grant.resources);
    for (const board of targets.boards) {
      if (!allowed.has(board)) throw new Denied(`Board ${board} is not in the allowlist`);
    }
    for (const cursor of targets.cursors) {
      if (!cursors.knows(sessionId, cursor)) {
        throw new Denied('Unknown cursor: only cursors returned to this session can be used');
      }
    }
    await checkItems(targets.items, allowed, secret);
  };

  const authorizeGraphQL = async (
    request: ToolRequest,
    grant: Grant,
    sessionId: string,
    secret: string,
  ): Promise<AuthzAllowed> => {
    const { rootFields, body } = inspectGraphQLRequest(request.body);
    const restricted = grant.resources.length > 0;
    const targets: Targets = { boards: new Set(), items: new Set(), cursors: new Set() };
    const used = new Set<string>();
    for (const field of rootFields) {
      if (ALWAYS_ALLOWED.has(field.name)) continue;
      const rule = ruleFor(field);
      if (!grant.permissions.includes(rule.permission)) {
        throw new Denied(`Missing permission "${rule.permission}" (for "${field.name}")`);
      }
      used.add(rule.permission);
      checkNested(field, grant);
      if (restricted) addTargets(field, rule.scope, targets);
    }
    if (restricted) await checkTargets(targets, grant, sessionId, secret);
    const detail = [...new Set(rootFields.map((f) => `${f.operation} ${f.name}`))].join(', ');
    return {
      allowed: true,
      permission: used.size > 0 ? [...used].join(', ') : 'meta',
      detail,
      body,
      ...(restricted && {
        observeResponse: (json: unknown) => {
          cursors.remember(sessionId, cursorsIn(json));
        },
      }),
    };
  };

  return {
    id: 'monday',
    name: 'monday.com',
    credentialHelp:
      'Personal API token (avatar → Developers → My access tokens). The gateway can never grant more than this token allows.',
    credentialPlaceholder: 'eyJhbGciOiJIUzI1NiJ9…',
    resourceHelp:
      'One board ID per line (the number in the board URL). Subitems of these boards are included. Leave empty to allow every board the token can reach.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: `/${GRAPHQL_PATH}`,
      body: '{"query":"query { me { id name } }"}',
      clientHint: 'GraphQL endpoint: POST /v2',
    },

    validateResource(pattern) {
      return BOARD_ID_RE.test(pattern) ? null : `Invalid board ID "${pattern}"`;
    },

    async verifyCredential(secret) {
      const { status, json } = await graphql(
        secret,
        'query { me { id name email account { id name slug } } }',
      );
      const me =
        isRecord(json) && isRecord(json.data) && isRecord(json.data.me) ? json.data.me : null;
      if (!me) throw new Error(`monday.com rejected the token (HTTP ${status})`);
      const account = isRecord(me.account) ? me.account : {};
      const identity: Record<string, string> = {
        login: text(me.email) ?? text(me.name) ?? 'unknown',
        userId: text(me.id) ?? '',
      };
      if (typeof me.name === 'string') identity.name = me.name;
      if (typeof account.name === 'string') identity.account = account.name;
      if (typeof account.slug === 'string') identity.accountSlug = account.slug;
      return identity;
    },

    async authorize(request, grant, { sessionId, secret }): Promise<AuthzDecision> {
      const [first, ...rest] = request.segments;
      if (request.method.toUpperCase() !== 'POST' || first !== GRAPHQL_PATH || rest.length > 0) {
        return { allowed: false, reason: `Only POST /${GRAPHQL_PATH} (GraphQL) is supported` };
      }
      if (request.search !== '') {
        return { allowed: false, reason: 'Pass the query in the JSON body, not the URL' };
      }
      try {
        return await authorizeGraphQL(request, grant, sessionId, secret);
      } catch (err) {
        if (err instanceof Denied || err instanceof GraphQLRequestError) {
          return { allowed: false, reason: err.message };
        }
        throw err;
      }
    },

    upstreamHeaders(secret, incoming) {
      const out = new Headers();
      const version = incoming.get('api-version');
      if (version) out.set('api-version', version);
      out.set('accept', 'application/json');
      // The body is always the gateway's re-serialized JSON.
      out.set('content-type', 'application/json');
      out.set('user-agent', USER_AGENT);
      out.set('authorization', secret);
      return out;
    },
  };
}
