import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chownSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONFIG_DRIVE_BYTES,
  RUNNER_LIMITS,
  type RunnerConfig,
  type RunnerOutcome,
} from '../server/launchpad/protocol.js';
import { HARNESS_ADAPTERS, type HarnessState, newState } from './harnesses.js';
import { Reporter } from './reporter.js';

/**
 * Runs inside the agent VM as root (PID 1's child): reads the run's config from the config drive,
 * starts the harness as the unprivileged `agent` user, streams its transcript to the gateway,
 * stops it at the deadline, uploads `/home/agent/out` and `MEMORY.md`, reports the result and
 * powers the VM off.
 */

const CONFIG_DEVICE = '/dev/vdb';
const AGENT_USER = 'agent';
const STOP_GRACE_MS = 10_000;
const MAX_STDERR_EVENTS = 200;
const MAX_STDERR_LINE = 2000;
const NUL = 0;

interface Args {
  configFile: string | null;
  home: string;
  poweroff: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  return {
    configFile: value('--config'),
    home: value('--home') ?? '/home/agent',
    poweroff: argv.includes('--poweroff'),
  };
}

/** The config drive holds the JSON config, NUL-padded. */
function readConfig(file: string | null): RunnerConfig {
  if (file) return JSON.parse(readFileSync(file, 'utf8')) as RunnerConfig;
  const fd = openSync(CONFIG_DEVICE, 'r');
  const buf = Buffer.alloc(CONFIG_DRIVE_BYTES);
  const n = readSync(fd, buf, 0, buf.length, 0);
  const end = buf.subarray(0, n).indexOf(NUL);
  return JSON.parse(buf.subarray(0, end < 0 ? n : end).toString('utf8')) as RunnerConfig;
}

const isRoot = (): boolean => process.getuid?.() === 0;

function agentIds(): { uid: number; gid: number } | null {
  if (!isRoot()) return null;
  const id = (flag: string): number =>
    Number(execFileSync('id', [flag, AGENT_USER]).toString().trim());
  return { uid: id('-u'), gid: id('-g') };
}

/** Configures eth0 when the kernel command line didn't (best effort). */
function setupNetwork(config: RunnerConfig): void {
  const { address, prefixLength } = config.network;
  if (!isRoot() || !address) return;
  const run = (...args: string[]): void => {
    try {
      execFileSync('ip', args, { stdio: 'ignore' });
    } catch {
      // Already configured.
    }
  };
  run('link', 'set', 'lo', 'up');
  run('addr', 'add', `${address}/${prefixLength}`, 'dev', 'eth0');
  run('link', 'set', 'eth0', 'up');
}

function writeOwned(file: string, content: string, ids: { uid: number; gid: number } | null): void {
  makeDir(path.dirname(file), ids);
  writeFileSync(file, content, { mode: 0o600 });
  if (ids) chownSync(file, ids.uid, ids.gid);
}

/** Creates a directory (and missing parents), all owned by the agent when running as root. */
function makeDir(dir: string, ids: { uid: number; gid: number } | null): void {
  const first = mkdirSync(dir, { recursive: true });
  if (!ids) return;
  if (first === undefined) {
    chownSync(dir, ids.uid, ids.gid);
    return;
  }
  for (let d = dir; d.startsWith(first); d = path.dirname(d)) chownSync(d, ids.uid, ids.gid);
}

async function* walk(dir: string, base = dir): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield path.relative(base, full);
  }
}

async function uploadOutputs(outDir: string, reporter: Reporter): Promise<string[]> {
  const problems: string[] = [];
  let total = 0;
  let count = 0;
  for await (const rel of walk(outDir)) {
    const size = (await stat(path.join(outDir, rel))).size;
    if (
      count >= RUNNER_LIMITS.outputFiles ||
      size > RUNNER_LIMITS.outputFileBytes ||
      total + size > RUNNER_LIMITS.outputTotalBytes
    ) {
      problems.push(`skipped ${rel} (output limits)`);
      continue;
    }
    try {
      await reporter.uploadOutput(rel, await readFile(path.join(outDir, rel)));
      total += size;
      count += 1;
    } catch (err) {
      problems.push(`could not upload ${rel}: ${(err as Error).message}`);
    }
  }
  return problems;
}

function readMemory(file: string): string | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return text.slice(0, RUNNER_LIMITS.memory);
}

const GITHUB_TOOL = 'gateway_github';

/**
 * git config for the agent: github.com URLs go to the gateway's git endpoint, which takes the
 * session key and holds the real GitHub credential.
 */
function gitConfig(config: RunnerConfig): string {
  const base = `${config.gatewayUrl}/proxy/github/git/`;
  return [
    '[user]',
    '\tname = Launchpad agent',
    '\temail = agent@launchpad.invalid',
    `[url "${base}"]`,
    '\tinsteadOf = https://github.com/',
    '\tinsteadOf = git@github.com:',
    `[http "${base}"]`,
    `\textraHeader = Authorization: Bearer ${config.sessionKey}`,
    '',
  ].join('\n');
}

/**
 * Proxy settings for the agent when its run may reach some HTTPS domains: the gateway's egress
 * proxy, authenticated by the session key. The gateway itself is reached directly.
 */
export function proxyEnv(config: RunnerConfig): Record<string, string> {
  if (!config.egressDomains?.length) return {};
  const gateway = new URL(config.gatewayUrl);
  const url = `${gateway.protocol}//agent:${encodeURIComponent(config.sessionKey)}@${gateway.host}`;
  const noProxy = `${gateway.hostname},localhost,127.0.0.1`;
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node's built-in fetch only honors the variables above with this set (Node >= 22.21).
    NODE_USE_ENV_PROXY: '1',
  };
}

/** Starts the harness and resolves when it exits (or was stopped at the deadline). */
function runHarness(
  config: RunnerConfig,
  home: string,
  reporter: Reporter,
  state: HarnessState,
): Promise<{ code: number | null; timedOut: boolean }> {
  const ids = agentIds();
  const adapter = HARNESS_ADAPTERS[config.harness];
  const launch = adapter.launch({
    config,
    home,
    guestDir: path.dirname(process.argv[1] ?? '.'),
    nodeBin: process.execPath,
    extraPath: process.env.LAUNCHPAD_HARNESS_PATH ?? null,
  });
  for (const dir of launch.dirs) makeDir(dir, ids);
  for (const file of launch.files) writeOwned(file.path, file.content, ids);
  const workDir = path.join(home, 'work');
  const child: ChildProcess = spawn(launch.command, launch.args, {
    cwd: workDir,
    env: { NODE_ENV: 'production', ...proxyEnv(config), ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(ids ? { uid: ids.uid, gid: ids.gid } : {}),
  });
  reporter.push({ type: 'status', text: `Started ${config.harness}` });

  let stderrEvents = 0;
  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const event of adapter.parse(line, state)) reporter.push(event);
    });
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (stderrEvents >= MAX_STDERR_EVENTS || !line.trim()) return;
      stderrEvents += 1;
      reporter.push({ type: 'log', text: line.slice(0, MAX_STDERR_LINE) });
    });
  }

  return new Promise((resolve) => {
    let timedOut = false;
    const msLeft = Math.max(0, Date.parse(config.deadline) - Date.now());
    const deadline = setTimeout(() => {
      timedOut = true;
      reporter.push({ type: 'error', text: 'Time limit reached: stopping the agent' });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    }, msLeft);
    child.on('error', (err) => {
      state.error = `Could not start ${launch.command}: ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({ code, timedOut });
    });
  });
}

function outcomeOf(
  result: { code: number | null; timedOut: boolean },
  state: HarnessState,
): RunnerOutcome {
  if (result.timedOut) return 'timed_out';
  return result.code === 0 && state.error === null ? 'succeeded' : 'failed';
}

function powerOff(): void {
  try {
    execFileSync('sync');
    // Immediate reboot: Firecracker exits when the guest resets.
    writeFileSync('/proc/sysrq-trigger', 'b');
  } catch (err) {
    console.error('runner: could not power off', err);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = readConfig(args.configFile);
  setupNetwork(config);
  const reporter = new Reporter(config.gatewayUrl, config.runToken);
  reporter.start();
  const ids = agentIds();
  const home = args.home;
  for (const dir of [home, path.join(home, 'work'), path.join(home, 'out')]) makeDir(dir, ids);
  if (config.gatewayTools.includes(GITHUB_TOOL)) {
    writeOwned(path.join(home, '.gitconfig'), gitConfig(config), ids);
  }
  const memoryFile = path.join(home, 'MEMORY.md');
  if (config.memory !== null) writeOwned(memoryFile, config.memory, ids);

  const state = newState();
  let result: { code: number | null; timedOut: boolean } = { code: null, timedOut: false };
  try {
    result = await runHarness(config, home, reporter, state);
  } catch (err) {
    state.error = (err as Error).message;
  }
  const problems = await uploadOutputs(path.join(home, 'out'), reporter);
  for (const problem of problems) reporter.push({ type: 'log', text: problem });
  const outcome = outcomeOf(result, state);
  const exitNote =
    result.code !== null && result.code !== 0
      ? `${config.harness} exited with code ${result.code}`
      : null;
  try {
    await reporter.finish({
      outcome,
      finalMessage: state.finalMessage,
      memory: readMemory(memoryFile),
      error: outcome === 'succeeded' ? null : (state.error ?? exitNote),
    });
  } catch (err) {
    console.error('runner: could not report the result', err);
  }
  if (args.poweroff) powerOff();
}

if (process.argv[1]?.endsWith('runner.js')) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error('runner: fatal', err);
    process.exitCode = 1;
  });
}
