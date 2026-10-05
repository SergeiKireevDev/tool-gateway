// Bundles the code that runs inside agent VMs into self-contained CommonJS files:
//   runner.js        the run supervisor (root)
//   mcp.js           the gateway MCP server (stdio) for MCP harnesses
//   pi-extension.js  the gateway tools as a pi extension
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const outdir = path.resolve(process.argv[2] ?? 'guest/dist');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    runner: 'src/guest/runner.ts',
    mcp: 'src/guest/mcpServer.ts',
    'pi-extension': 'src/guest/piExtension.ts',
  },
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
});
// The bundles are CommonJS whatever package.json is above them.
await writeFile(path.join(outdir, 'package.json'), '{ "type": "commonjs" }\n');
console.info(`guest bundles written to ${outdir}`);
