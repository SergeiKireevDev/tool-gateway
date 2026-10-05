import { emptyState, type Member, type Session, type StoreState, type Template } from './types.js';

/** Version 1: templates and sessions covered a single tool. */
interface SingleToolV1 {
  tool: string;
  permissions: string[];
  resources: string[];
}
type TemplateV1 = Omit<Template, 'grants'> & SingleToolV1;
type SessionV1 = Omit<Session, 'grants'> & SingleToolV1 & { accountId: string };

/** Version 2: members had no key generation counter. */
type MemberV2 = Omit<Member, 'keyGeneration'> & { keyGeneration?: number };

type PersistedState = Omit<
  Partial<StoreState>,
  'version' | 'templates' | 'sessions' | 'members'
> & {
  version?: number;
  templates?: (Template | TemplateV1)[];
  sessions?: (Session | SessionV1)[];
  members?: MemberV2[];
};

/** Brings a decrypted store up to the current shape. Already-current entries are kept as-is. */
export function migrate(persisted: PersistedState): StoreState {
  const { templates = [], sessions = [], members = [], ...rest } = persisted;
  return {
    ...emptyState(),
    ...rest,
    version: emptyState().version,
    templates: templates.map(migrateTemplate),
    sessions: sessions.map(migrateSession),
    members: members.map((m) => ({ ...m, keyGeneration: m.keyGeneration ?? 0 })),
  };
}

function migrateTemplate(t: Template | TemplateV1): Template {
  if ('grants' in t) return t;
  const { tool, permissions, resources, ...rest } = t;
  return { ...rest, grants: [{ tool, permissions, resources }] };
}

function migrateSession(s: Session | SessionV1): Session {
  if ('grants' in s) return s;
  const { tool, accountId, permissions, resources, ...rest } = s;
  return { ...rest, grants: [{ tool, accountId, permissions, resources }] };
}
