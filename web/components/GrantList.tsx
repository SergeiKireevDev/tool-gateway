import { permissionLabel, toolName } from '@/lib/grants';
import type { Tool, ToolGrant } from '@/lib/types';
import { Badge } from './ui';

/** What a template grants, one row per tool: permissions and resource allowlist. */
export function GrantList({ grants, tools }: { grants: ToolGrant[]; tools: Tool[] }) {
  return (
    <div className="divide-y divide-slate-100">
      {grants.map((g) => (
        <div key={g.tool} className="grid gap-3 py-3 text-sm first:pt-0 last:pb-0 md:grid-cols-3">
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
              Resources
            </p>
            {g.resources.length === 0 ? (
              <span className="text-amber-700">Unrestricted</span>
            ) : (
              <ul className="font-mono text-xs text-slate-700">
                {g.resources.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
