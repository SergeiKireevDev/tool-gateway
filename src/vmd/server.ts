import { chmod, chown, rm } from 'node:fs/promises';
import http from 'node:http';
import { z } from 'zod';
import { HTTP } from '../server/httpStatus.js';
import { BYTES_PER_MIB } from '../server/units.js';
import { HARNESSES, LLM_PROVIDERS } from '../server/launchpad/protocol.js';
import type { VmSpec } from '../server/launchpad/vmDriver.js';
import { VmdError, type VmManager } from './vmManager.js';

const SOCKET_MODE = 0o660;
const MAX_BODY_MIB = 2;
const MAX_BODY_BYTES = MAX_BODY_MIB * BYTES_PER_MIB;
const MAX_ID_LENGTH = 100;
const MAX_VCPUS = 16;
const MIN_MEM_MIB = 256;
const MAX_MEM_MIB = 65_536;
const specSchema = z.object({
  runId: z.string().min(1).max(MAX_ID_LENGTH),
  vcpus: z.number().int().min(1).max(MAX_VCPUS),
  memMib: z.number().int().min(MIN_MEM_MIB).max(MAX_MEM_MIB),
  killAt: z.iso.datetime({ offset: true }),
  config: z.looseObject({
    runId: z.string(),
    runToken: z.string(),
    gatewayUrl: z.string(),
    sessionKey: z.string(),
    harness: z.enum(HARNESSES),
    llm: z.object({ provider: z.enum(LLM_PROVIDERS), model: z.string().nullable() }),
    gatewayTools: z.array(z.string()),
    prompt: z.string(),
    systemPrompt: z.string(),
    memory: z.string().nullable(),
    deadline: z.string(),
  }),
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new VmdError(HTTP.PAYLOAD_TOO_LARGE, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function route(
  vms: VmManager,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? '/';
  const match = /^\/vms\/([A-Za-z0-9-]+)$/.exec(url);
  if (req.method === 'GET' && url === '/vms') {
    send(res, HTTP.OK, vms.list());
    return;
  }
  if (req.method === 'POST' && url === '/vms') {
    const spec: VmSpec = specSchema.parse(JSON.parse(await readBody(req)));
    send(res, HTTP.CREATED, await vms.create(spec));
    return;
  }
  if (req.method === 'DELETE' && match?.[1]) {
    send(res, (await vms.destroy(match[1])) ? HTTP.NO_CONTENT : HTTP.NOT_FOUND);
    return;
  }
  send(res, HTTP.NOT_FOUND, { error: 'Not found' });
}

/** The vmd API over a unix socket only reachable by root and the gateway's group. */
export function createVmdServer(vms: VmManager): http.Server {
  return http.createServer((req, res) => {
    route(vms, req, res).catch((err: unknown) => {
      if (err instanceof z.ZodError || err instanceof SyntaxError) {
        send(res, HTTP.BAD_REQUEST, { error: err.message });
        return;
      }
      const status = err instanceof VmdError ? err.status : HTTP.INTERNAL_SERVER_ERROR;
      console.error('vmd:', err);
      send(res, status, { error: (err as Error).message });
    });
  });
}

export async function listenOnSocket(
  server: http.Server,
  socket: string,
  gid: number | null,
): Promise<void> {
  await rm(socket, { force: true });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, SOCKET_MODE);
  if (gid !== null) await chown(socket, 0, gid);
}
