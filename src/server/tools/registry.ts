import type { ToolProvider } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolProvider>();

  constructor(providers: readonly ToolProvider[]) {
    for (const p of providers) this.tools.set(p.id, p);
  }

  get(id: string): ToolProvider | undefined {
    return this.tools.get(id);
  }

  list(): ToolProvider[] {
    return [...this.tools.values()];
  }
}
