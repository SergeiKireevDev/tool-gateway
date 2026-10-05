import { kindOf, permissionLabel, splitGrants, toolName } from '@/lib/grants';
import type { Tool, ToolGrant } from '@/lib/types';
import { Badge } from './ui';

function GrantRow({ grant: g, tools }: { grant: ToolGrant; tools: Tool[] }) {
  const model = kindOf(tools, g.tool) === 'llm';
  return (
    <div className="grid gap-3 py-3 text-sm first:pt-0 last:pb-0 md:grid-cols-3">
      <div className="md:col-span-2">
        <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
          {toolName(tools, g.tool)} permissions
        </p>
        <div className="flex flex-wrap gap-1.5">
          {g.permissions.map((p) => (
            <Badge key={p} tone={p.endsWith(':read') ? 'slate' : 'amber'}>
              {permissionLabel(tools, g.tool, p)}
            </Badge>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
          {model ? 'Models' : 'Resources'}
        </p>
        {g.resources.length === 0 ? (
          <span className="text-amber-700">{model ? 'Any model' : 'Unrestricted'}</span>
        ) : (
          <ul className="font-mono text-xs text-slate-700">
            {g.resources.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GrantGroup({
  title,
  grants,
  tools,
}: {
  title: string;
  grants: ToolGrant[];
  tools: Tool[];
}) {
  if (grants.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-slate-700">{title}</p>
      <div className="divide-y divide-slate-100">
        {grants.map((g) => (
          <GrantRow key={g.tool} grant={g} tools={tools} />
        ))}
      </div>
    </div>
  );
}

/** What a template grants: tool access, then model access (one row per tool / provider). */
export function GrantList({ grants, tools }: { grants: ToolGrant[]; tools: Tool[] }) {
  const split = splitGrants(grants, tools);
  return (
    <div className="space-y-4">
      <GrantGroup title="Tool access" grants={split.tools} tools={tools} />
      <GrantGroup title="Model access" grants={split.models} tools={tools} />
    </div>
  );
}
