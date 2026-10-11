import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, chown, copyFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { promisify } from 'node:util';
import { PRIVATE_FILE_MODE } from '../server/units.js';

const execFileAsync = promisify(execFile);
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

/** A started process vmd supervises (the jailer, which becomes Firecracker). */
export interface HostProcess {
  readonly pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

/** Everything vmd does to the host, so the VM logic can be tested without root or KVM. */
export interface HostOps {
  run(command: string, args: readonly string[]): Promise<void>;
  /** Like `run`, but failures are ignored (cleanup of things that may not exist). */
  tryRun(command: string, args: readonly string[]): Promise<void>;
  start(command: string, args: readonly string[], logFile: string): HostProcess;
  exists(file: string): Promise<boolean>;
  mkdir(dir: string): Promise<void>;
  remove(target: string): Promise<void>;
  /** Copies `from` to `to` keeping holes (the rootfs is a large sparse file). */
  copySparse(from: string, to: string): Promise<void>;
  /** Writes `content` at the start of a file of exactly `size` bytes (NUL-padded). */
  writePadded(file: string, content: Buffer, size: number): Promise<void>;
  chown(file: string, uid: number, gid: number): Promise<void>;
  /** Writes a root-only file. */
  writeFile(file: string, content: string): Promise<void>;
  /** The last `maxBytes` of a text file, or '' when it doesn't exist. */
  readTail(file: string, maxBytes: number): Promise<string>;
  /** One call to a Firecracker API socket. */
  firecracker(socket: string, method: string, path: string, body: unknown): Promise<void>;
}

class ChildHostProcess implements HostProcess {
  constructor(private readonly child: ChildProcess) {}
  get pid(): number | undefined {
    return this.child.pid;
  }
  onExit(listener: (code: number | null) => void): void {
    this.child.on('exit', listener);
  }
  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}

export const realHost: HostOps = {
  async run(command, args) {
    await execFileAsync(command, [...args]);
  },
  async tryRun(command, args) {
    await execFileAsync(command, [...args]).catch(() => undefined);
  },
  start(command, args, logFile) {
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    return new ChildHostProcess(child);
  },
  async exists(file) {
    try {
      await access(file, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async remove(target) {
    await rm(target, { recursive: true, force: true });
  },
  async copySparse(from, to) {
    await execFileAsync('cp', ['--sparse=always', from, to]).catch(() => copyFile(from, to));
  },
  async writePadded(file, content, size) {
    const handle = await open(file, 'w', PRIVATE_FILE_MODE);
    try {
      await handle.write(content, 0, content.length, 0);
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  },
  async chown(file, uid, gid) {
    await chown(file, uid, gid);
  },
  async writeFile(file, content) {
    await writeFile(file, content, { mode: PRIVATE_FILE_MODE });
  },
  async readTail(file, maxBytes) {
    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return '';
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  },
  firecracker(socket, method, path, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          method,
          path,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= HTTP_OK_MIN && status <= HTTP_OK_MAX) resolve();
            else
              reject(
                new Error(
                  `Firecracker ${method} ${path}: HTTP ${status} ${Buffer.concat(chunks).toString()}`,
                ),
              );
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  },
};
