import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSafeSessionId } from '../hooks/payload';
import { envoyEnv } from '../paths';
import { agoLabel } from './time';
import type { CliAdapter, ProcessInfo, RecentSession } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_BYTES = 64 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024;
const STAT_BATCH = 64;
const TITLE_MAX = 80;

/** First-argument subcommands that never start an interactive REPL. */
const NON_REPL_SUBCOMMANDS = new Set([
  'mcp', 'update', 'upgrade', 'config', 'doctor', 'install', 'migrate-installer', 'setup-token',
  'plugin', 'plugins', 'agents', 'auth', 'project', 'api-key', 'completion',
]);

/** Flags that mean a headless, helper or informational run rather than an interactive REPL. */
const NON_INTERACTIVE_FLAGS = new Set(['-p', '--print', '--chrome-native-host', '--version', '-v', '--help', '-h']);

/**
 * Splits a `ps` command into the arguments passed to Claude Code, accepting a direct binary
 * (`claude ...`, any directory), the native installer's versioned binary
 * (`.../claude/versions/<version>`, which is what the `claude` symlink resolves to), or an npm
 * install run through node.
 * @param command Command text from ps.
 * @returns Arguments after the executable, or null when this is not Claude Code at all.
 */
function claudeArgs(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/);
  const base = (token: string | undefined): string => (token ? path.basename(token) : '');
  if (base(tokens[0]) === 'claude' || /\/claude\/versions\/[^/\s]+$/.test(tokens[0])) return tokens.slice(1);
  if (base(tokens[0]) === 'node' && tokens[1] && (base(tokens[1]) === 'claude' || /\/@anthropic-ai\/claude-code\/[^\s]*\.m?js$/.test(tokens[1]))) return tokens.slice(2);
  return null;
}

/**
 * Checks whether a command is an interactive Claude Code REPL. Headless (`-p`), the browser
 * native host, and management subcommands are excluded. Flags are matched anywhere in the
 * argument list because `ps` does not preserve quoting.
 * @param command Command text from ps.
 * @returns True for interactive Claude Code processes.
 */
export function isClaudeReplCommand(command: string): boolean {
  const args = claudeArgs(command);
  if (!args) return false;
  if (NON_REPL_SUBCOMMANDS.has(args[0] ?? '')) return false;
  return !args.some((arg) => NON_INTERACTIVE_FLAGS.has(arg) || arg.startsWith('--print='));
}

/**
 * Reads field 22 (process start time) of `/proc/<pid>/stat` on Linux.
 * @param pid Process id to inspect.
 * @returns The start-time token, or null where `/proc` is unavailable (macOS).
 */
export function readProcStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export interface ClaudeAdapterOptions {
  /** Claude config root; defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string;
  /** Overrides `/proc` process start lookup, for tests. */
  procStart?: (pid: number) => string | null;
  /** Executable to spawn when `ENVOY_CLAUDE_CMD` is unset (from `adapter_commands` in the config). */
  command?: string;
}

/**
 * Reads and validates one live-session registry record. The registry is last-known state, not
 * liveness: callers only pass pids that `ps` showed as running Claude REPLs, and a record is
 * rejected when its pid disagrees with the file name, when it describes a background or parked
 * job, or when its `procStart` shows the pid was reused (verifiable where `/proc` exists).
 * @param dir Registry directory.
 * @param pid Process id whose record is wanted.
 * @param procStart Process start lookup.
 * @returns Session id, cwd and name, or null when there is no trustworthy record.
 */
async function readRegistryRecord(dir: string, pid: number, procStart: (pid: number) => string | null): Promise<ProcessInfo | null> {
  const file = path.join(dir, `${pid}.json`);
  let record: unknown;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) return null;
    record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  if (Number(r.pid) !== pid || !isSafeSessionId(r.sessionId)) return null;
  if (r.kind === 'bg' || r.parkedJobId) return null;
  if (r.procStart !== undefined && r.procStart !== null) {
    const actual = procStart(pid);
    if (actual !== null && actual !== String(r.procStart)) return null;
  }
  const info: ProcessInfo = { sessionId: r.sessionId };
  if (typeof r.cwd === 'string' && path.isAbsolute(r.cwd)) info.cwd = r.cwd;
  if (typeof r.name === 'string' && r.name.trim()) info.title = r.name.trim().slice(0, 120);
  return info;
}

/**
 * Reads the head and tail of a transcript as JSON lines. Titles are rewritten as the session
 * goes on, so the tail matters; `cwd` and the first prompt live at the head. Partial lines at
 * chunk boundaries are dropped.
 * @param file Transcript path.
 * @param size File size in bytes.
 * @returns Parsed records in file order.
 */
async function readTranscriptSample(file: string, size: number): Promise<Array<Record<string, unknown>>> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const read = async (length: number, position: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.toString('utf8', 0, bytesRead);
    };
    let lines: string[];
    if (size <= SAMPLE_BYTES * 2) {
      lines = (await read(size, 0)).split('\n');
    } else {
      const head = await read(SAMPLE_BYTES, 0);
      const tail = await read(SAMPLE_BYTES, size - SAMPLE_BYTES);
      lines = [...head.slice(0, head.lastIndexOf('\n')).split('\n'), ...tail.slice(tail.indexOf('\n') + 1).split('\n')];
    }
    const records: Array<Record<string, unknown>> = [];
    for (const line of lines) {
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
 * Extracts the plain text of a user prompt record.
 * @param record Transcript record of type `user`.
 * @returns Single-line prompt text, or '' for tool results, meta records and command wrappers.
 */
function promptText(record: Record<string, unknown>): string {
  if (record.isSidechain === true || record.isMeta === true) return '';
  const content = (record.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((block) => (block && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.startsWith('<') ? '' : text;
}

/**
 * Derives a resumable session from a transcript sample, or null when it cannot be resumed
 * (no recorded cwd) or is a headless SDK run.
 * @param sessionId Session id taken from the file name.
 * @param records Parsed head/tail records.
 * @returns The session without its relative age, which the caller fills in.
 */
function sessionFromRecords(sessionId: string, records: Array<Record<string, unknown>>): Omit<RecentSession, 'lastAgo' | 'lastActivityAt'> | null {
  let cwd = '';
  let entrypoint = '';
  let customTitle = '';
  let aiTitle = '';
  let firstPrompt = '';
  for (const record of records) {
    if (!cwd && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) cwd = record.cwd;
    if (!entrypoint && typeof record.entrypoint === 'string') entrypoint = record.entrypoint;
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) customTitle = record.customTitle.trim();
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) aiTitle = record.aiTitle.trim();
    if (!firstPrompt && record.type === 'user') firstPrompt = promptText(record);
  }
  if (!cwd || entrypoint === 'sdk-cli') return null;
  const title = (customTitle || aiTitle || firstPrompt).replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  return { adapterId: 'claude', sessionId, cwd, title };
}

interface CachedTranscript {
  mtimeMs: number;
  size: number;
  session: Omit<RecentSession, 'lastAgo' | 'lastActivityAt'> | null;
}

/**
 * Creates the Claude Code adapter. Each instance owns its own transcript cache.
 * @param options Optional config root and `/proc` override, primarily for tests.
 * @returns A CliAdapter for `claude`.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): CliAdapter {
  const configDir = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const procStart = options.procStart ?? readProcStart;
  const cache = new Map<string, CachedTranscript>();
  let sessions: RecentSession[] = [];

  return {
    id: 'claude',
    label: 'Claude',
    badge: 'CL',
    sessionIdChanges: true,
    command: () => envoyEnv('CLAUDE_CMD') || options.command || 'claude',
    freshArgs: () => [],
    resumeArgs: (sessionId) => ['--resume', sessionId],
    isReplProcess: isClaudeReplCommand,

    async resolveProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
      const result = new Map<number, ProcessInfo>();
      const dir = path.join(configDir, 'sessions');
      for (const pid of pids) {
        const info = await readRegistryRecord(dir, pid, procStart);
        if (info) result.set(pid, info);
      }
      return result;
    },

    async refreshCatalog(): Promise<{ fallbackActive: boolean }> {
      const root = path.join(configDir, 'projects');
      const now = Date.now();
      const cutoffMs = now - DAY_MS;
      let projectDirs: string[] = [];
      try {
        projectDirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
      } catch {
        cache.clear();
        sessions = [];
        return { fallbackActive: false };
      }
      const files = (await Promise.all(projectDirs.map(async (dir) => {
        try {
          return (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      }))).flat();
      const seen = new Set<string>();
      const next: RecentSession[] = [];
      for (let i = 0; i < files.length; i += STAT_BATCH) {
        await Promise.all(files.slice(i, i + STAT_BATCH).map(async (file) => {
          try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile() || stat.mtimeMs < cutoffMs) return;
            const sessionId = path.basename(file, '.jsonl');
            if (!isSafeSessionId(sessionId)) return;
            seen.add(file);
            let entry = cache.get(file);
            if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
              entry = { mtimeMs: stat.mtimeMs, size: stat.size, session: sessionFromRecords(sessionId, await readTranscriptSample(file, stat.size)) };
              cache.set(file, entry);
            }
            if (entry.session) next.push({ ...entry.session, lastAgo: agoLabel((now - stat.mtimeMs) / 1000), lastActivityAt: stat.mtimeMs / 1000 });
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
