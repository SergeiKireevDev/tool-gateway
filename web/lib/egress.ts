/** Package registries offered as presets for a template's internet access (agents). */
export const EGRESS_PRESETS: Record<string, readonly string[]> = {
  npm: ['registry.npmjs.org'],
  PyPI: ['pypi.org', 'files.pythonhosted.org'],
  'crates.io': ['crates.io', 'index.crates.io', 'static.crates.io'],
  'Go modules': ['proxy.golang.org', 'sum.golang.org'],
  'Debian packages': ['deb.debian.org', 'security.debian.org'],
};

/** Domains from the editor's text (one per line, or comma-separated). */
export const parseDomains = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);
