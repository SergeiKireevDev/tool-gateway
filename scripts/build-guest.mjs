// Bundles the code that runs inside agent VMs into self-contained CommonJS files:
//   runner.js        the run supervisor (root)
//   mcp.js           the gateway MCP server (stdio) for MCP harnesses
//   pi-extension.mjs the gateway tools as a pi extension (ES module)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const outdir = path.resolve(process.argv[2] ?? 'guest/dist');
await mkdir(outdir, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node22', logLevel: 'warning' };
await build({
  ...common,
  entryPoints: { runner: 'src/guest/runner.ts', mcp: 'src/guest/mcpServer.ts' },
  outdir,
  format: 'cjs',
});
// pi loads extensions as ES modules with a default-exported factory.
await build({
  ...common,
  entryPoints: ['src/guest/piExtension.ts'],
  outfile: path.join(outdir, 'pi-extension.mjs'),
  format: 'esm',
});
// The bundles are CommonJS whatever package.json is above them.
await writeFile(path.join(outdir, 'package.json'), '{ "type": "commonjs" }\n');
console.info(`guest bundles written to ${outdir}`);
