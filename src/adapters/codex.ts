import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { envoyEnv } from '../paths';
import { parseLsofLocks, parsePsProcesses } from './ps';
import { agoLabel } from './time';
import type { CliAdapter, ProcessInfo, RecentSession } from './types';

const execFileP = promisify(execFile);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Resumed sessions append to the rollout of the day they started, so recent day folders are scanned. */
const SCAN_DAYS = 14;
const HEAD_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const STAT_BATCH = 64;
const TITLE_MAX = 80;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ROLLOUT_FILE = new RegExp(`^rollout-.*?(${UUID})\\.jsonl$`);
const ROLLOUT_OPEN_PATTERN = new RegExp(`/rollout-[^/]*?(${UUID})\\.jsonl$`);

/** First positional arguments that mean a helper, management or non-interactive run. */
const NON_REPL_SUBCOMMANDS = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control',
  'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'exec-server',
  'features', 'help',
]);

/** Top-level options that consume the next argument when written as `--flag value`. */
const VALUE_FLAGS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '-a', '--ask-for-approval',
]);

const INFO_FLAGS = new Set(['-h', '--help', '-V', '--version']);

/**
 * Checks whether a command is an interactive Codex TUI. The first positional argument decides:
 * none, `resume`, `fork` or a prompt are interactive, while management subcommands and the
 * app/exec servers (including the editor extension's `app-server`) are not.
 * @param command Command text from ps.
 * @returns True for interactive Codex processes.
 */
export function isCodexReplCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (!tokens[0] || path.basename(tokens[0]) !== 'codex') return false;
  const args = tokens.slice(1);
  if (args.some((arg) => INFO_FLAGS.has(arg))) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return true;
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return !NON_REPL_SUBCOMMANDS.has(arg);
  }
  return true;
}

/**
 * Parses batched lsof output into per-pid cwd and session id from the open rollout file.
 * @param output Raw lsof -Fn stdout.
 * @returns Map from pid to its discovered cwd and/or session id.
 */
export function parseLsofCodexSessions(output: string): Map<number, ProcessInfo> {
  return parseLsofLocks(output, ROLLOUT_OPEN_PATTERN);
}

export interface CodexAdapterOptions {
  /** Codex home; defaults to `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  /** Executable to spawn when `ENVOY_CODEX_CMD` is unset (from `adapter_commands` in the config). */
  command?: string;
}

/**
 * Reads the start of a rollout file as JSON lines. The first records can be large (they embed
 * instructions), so a generous head is read and a partial trailing line is dropped.
 * @param file Rollout path.
 * @param size File size in bytes.
 * @returns Parsed records in file order.
 */
async function readRolloutHead(file: string, size: number): Promise<Array<Record<string, unknown>>> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const length = Math.min(size, HEAD_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    let text = buffer.toString('utf8', 0, bytesRead);
    if (size > HEAD_BYTES) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
    const records: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) records.push(value as Record<string, unknown>);
      } catch {}
    }
    return records;
  } finally {
    await handle.close();
  }
}

/**
 * Derives a resumable session from the head of a rollout, or null when it is not an
 * interactive session (exec runs, sub-agent threads) or has no usable cwd.
 * @param sessionId Session id taken from the file name.
 * @param records Parsed head records.
 * @returns The session without its relative age, which the caller fills in.
 */
function sessionFromRecords(sessionId: string, records: Array<Record<string, unknown>>): Omit<RecentSession, 'lastAgo' | 'lastActivityAt'> | null {
  let cwd = '';
  let firstPrompt = '';
  for (const record of records) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    if (record.type === 'session_meta') {
      if (payload.source === 'exec' || (typeof payload.source === 'object' && payload.source !== null)) return null;
      if (typeof payload.thread_source === 'string' && payload.thread_source !== 'user') return null;
      if (typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)) cwd = payload.cwd;
    } else if (!cwd && record.type === 'turn_context' && typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)) {
      cwd = payload.cwd;
    } else if (!firstPrompt && record.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      firstPrompt = payload.message.replace(/\s+/g, ' ').trim();
    }
  }
  if (!cwd) return null;
  return { adapterId: 'codex', sessionId, cwd, title: firstPrompt.slice(0, TITLE_MAX) };
}

interface CachedRollout {
  mtimeMs: number;
  size: number;
  session: Omit<RecentSession, 'lastAgo' | 'lastActivityAt'> | null;
}

/**
 * Creates the Codex CLI adapter. Each instance owns its own rollout and index caches.
 * @param options Optional Codex home override, primarily for tests.
 * @returns A CliAdapter for `codex`.
 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): CliAdapter {
  const home = options.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const cache = new Map<string, CachedRollout>();
  let sessions: RecentSession[] = [];
  let indexCache: { mtimeMs: number; size: number; names: Map<string, string> } | null = null;

  /** Reads `session_index.jsonl` (id -> thread name); later lines win. Cached by mtime and size. */
  const readIndex = async (): Promise<Map<string, string>> => {
    const file = path.join(home, 'session_index.jsonl');
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return new Map();
      if (indexCache && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) return indexCache.names;
      const names = new Map<string, string>();
      for (const line of (await fs.promises.readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) {
            names.set(row.id, row.thread_name.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX));
          }
        } catch {}
      }
      indexCache = { mtimeMs: stat.mtimeMs, size: stat.size, names };
      return names;
    } catch {
      return new Map();
    }
  };

  /** Lists rollout files in day folders no older than SCAN_DAYS. */
  const listRolloutFiles = async (): Promise<string[]> => {
    const root = path.join(home, 'sessions');
    const oldest = Date.now() - (SCAN_DAYS + 1) * DAY_MS;
    const subdirs = async (dir: string): Promise<string[]> => {
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name);
      } catch {
        return [];
      }
    };
    const files: string[] = [];
    for (const year of await subdirs(root)) {
      for (const month of await subdirs(path.join(root, year))) {
        for (const day of await subdirs(path.join(root, year, month))) {
          if (new Date(Number(year), Number(month) - 1, Number(day) + 1).getTime() < oldest) continue;
          const dir = path.join(root, year, month, day);
          try {
            for (const name of await fs.promises.readdir(dir)) if (ROLLOUT_FILE.test(name)) files.push(path.join(dir, name));
          } catch {}
        }
      }
    }
    return files;
  };

  return {
    id: 'codex',
    label: 'Codex',
    badge: 'CX',
    sessionIdChanges: true,
    command: () => envoyEnv('CODEX_CMD') || options.command || 'codex',
    freshArgs: () => [],
    resumeArgs: (sessionId) => ['resume', sessionId],
    isReplProcess: isCodexReplCommand,

    async resolveProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
      if (pids.length === 0) return new Map();
      let out = '';
      try {
        out = (await execFileP('lsof', ['-a', '-p', pids.join(','), '-Fn'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? '';
      }
      const resolved = parseLsofCodexSessions(out);
      const names = await readIndex();
      for (const info of resolved.values()) {
        const name = info.sessionId ? names.get(info.sessionId) : undefined;
        if (name) info.title = name;
      }
      return resolved;
    },

    async refreshCatalog(): Promise<{ fallbackActive: boolean }> {
      const now = Date.now();
      const cutoffMs = now - DAY_MS;
      const files = await listRolloutFiles();
      const names = await readIndex();
      const seen = new Set<string>();
      const next: RecentSession[] = [];
      for (let i = 0; i < files.length; i += STAT_BATCH) {
        await Promise.all(files.slice(i, i + STAT_BATCH).map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile() || stat.mtimeMs < cutoffMs) return;
            const match = path.basename(file).match(ROLLOUT_FILE);
            if (!match) return;
            seen.add(file);
            let entry = cache.get(file);
            if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
              entry = { mtimeMs: stat.mtimeMs, size: stat.size, session: sessionFromRecords(match[1], await readRolloutHead(file, stat.size)) };
              cache.set(file, entry);
            }
            if (entry.session) {
              next.push({ ...entry.session, title: names.get(entry.session.sessionId) || entry.session.title, lastAgo: agoLabel((now - stat.mtimeMs) / 1000), lastActivityAt: stat.mtimeMs / 1000 });
            }
          } catch {}
        }));
      }
      for (const file of [...cache.keys()]) if (!seen.has(file)) cache.delete(file);
      sessions = next;
      return { fallbackActive: false };
    },

    catalog: () => sessions,
    catalogEntry: (sessionId) => sessions.find((entry) => entry.sessionId === sessionId),
  };
}
