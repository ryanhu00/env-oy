import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { envoyEnv } from '../paths';
import { parseLsofLocks, parsePsProcesses } from './ps';
import { agoLabel } from './time';
import type { CliAdapter, ProcessInfo, ProcessSample, RecentSession } from './types';

const execFileP = promisify(execFile);

const RECENT_FALLBACK_SQL = "SELECT id, working_directory, last_activity_at, title FROM sessions NOT INDEXED WHERE hidden = 0 AND last_activity_at >= unixepoch('now') - 86400 ORDER BY last_activity_at DESC;";

const DEVIN_LOCK_PATTERN = /\/session_locks\/([^/]+)\.lock$/;

const EXCLUDED_SUBCOMMANDS = new Set([
  'list',
  'auth',
  'mcp',
  'rules',
  'skills',
  'acp',
  'update',
  'shell',
  'sandbox',
  'setup',
  'uninstall',
  'version',
]);

/**
 * Checks whether a command is a Devin REPL rather than a known non-interactive subcommand.
 * @param command Command text from ps.
 * @returns True for allowed bare or flagged Devin commands.
 */
export function isDevinReplCommand(command: string): boolean {
  if (command !== 'devin' && !command.startsWith('devin ')) return false;
  return !EXCLUDED_SUBCOMMANDS.has(command.split(/\s+/)[1] || '');
}

/**
 * Parses validated Devin REPL RSS samples from `ps -axo pid=,rss=,command=` output.
 * @param output Raw ps stdout with RSS in KiB.
 * @returns Deduplicated process samples with byte counts.
 */
export function parsePsDevinProcesses(output: string): ProcessSample[] {
  return parsePsProcesses(output, isDevinReplCommand);
}

/**
 * Extracts Devin REPL pids from legacy pid/command or current pid/RSS/command ps output.
 * @param output Raw ps stdout.
 * @returns Array of REPL pids for compatibility callers.
 */
export function parsePsDevinPids(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const rssCommand = match[2].match(/^\d+\s+(.*)$/);
    const command = rssCommand && isDevinReplCommand(rssCommand[1]) ? rssCommand[1] : match[2];
    const pid = Number(match[1]);
    if (isDevinReplCommand(command) && Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Parses batched lsof output into per-pid cwd and Devin session id from `session_locks`.
 * @param output Raw lsof -Fn stdout.
 * @returns Map from pid to its discovered cwd and/or session id.
 */
export function parseLsofSessions(output: string): Map<number, ProcessInfo> {
  return parseLsofLocks(output, DEVIN_LOCK_PATTERN);
}

export interface DevinAdapterOptions {
  /** Read-only Devin sessions database used when `devin list` fails. */
  sessionsDbPath?: string;
  /** Executable to spawn when `ENVOY_CMD` is unset (from `adapter_commands` in the config). */
  command?: string;
}

/**
 * Creates the Devin CLI adapter. Each instance owns its own session catalog cache.
 * @param options Optional overrides, primarily for tests.
 * @returns A CliAdapter for `devin`.
 */
export function createDevinAdapter(options: DevinAdapterOptions = {}): CliAdapter {
  const sessionsDbPath = options.sessionsDbPath ?? path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db');
  const meta = new Map<string, RecentSession>();

  return {
    id: 'devin',
    label: 'Devin',
    badge: 'DV',
    sessionIdChanges: false,
    command: () => envoyEnv('CMD') || options.command || 'devin',
    freshArgs: () => [],
    resumeArgs: (sessionId) => ['-r', sessionId],
    isReplProcess: isDevinReplCommand,

    async resolveProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
      if (pids.length === 0) return new Map();
      let out = '';
      try {
        out = (await execFileP('lsof', ['-a', '-p', pids.join(','), '-Fn'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? '';
      }
      return parseLsofSessions(out);
    },

    async refreshCatalog(dirs: ReadonlySet<string>): Promise<{ fallbackActive: boolean }> {
      const failedDirs = new Set((await Promise.all(
        [...dirs].map(async (dir): Promise<string | null> => {
          try {
            const res = await execFileP('devin', ['list', '--format', 'json'], { cwd: dir, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
            for (const row of JSON.parse(res.stdout)) {
              if (!row || typeof row.id !== 'string') continue;
              meta.set(row.id, {
                adapterId: 'devin',
                sessionId: row.id,
                cwd: String(row.working_directory || dir),
                title: String(row.title || ''),
                lastAgo: String(row.last_activity_ago || ''),
                lastActivityAt: Number(row.last_activity_at) || 0,
              });
            }
            return null;
          } catch {
            return dir;
          }
        })
      )).filter((dir): dir is string => dir !== null));
      let fallbackActive = false;
      if (failedDirs.size > 0) {
        try {
          const result = await execFileP('sqlite3', ['-readonly', '-json', sessionsDbPath, RECENT_FALLBACK_SQL], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
          const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
          if (!Array.isArray(parsed)) throw new Error('Invalid sqlite3 JSON output');
          const now = Date.now() / 1000;
          const cutoff = now - 86400;
          for (const value of parsed) {
            if (!value || typeof value !== 'object') continue;
            const row = value as Record<string, unknown>;
            const sessionId = typeof row.id === 'string' ? row.id.trim() : '';
            const cwd = typeof row.working_directory === 'string' ? row.working_directory.trim() : '';
            const lastActivityAt = Number(row.last_activity_at);
            if (!sessionId || !cwd || !failedDirs.has(cwd) || !Number.isFinite(lastActivityAt) || lastActivityAt < cutoff) continue;
            if (row.title !== null && row.title !== undefined && typeof row.title !== 'string') continue;
            meta.set(sessionId, { adapterId: 'devin', sessionId, cwd, title: row.title ?? '', lastAgo: agoLabel(now - lastActivityAt), lastActivityAt });
          }
          fallbackActive = true;
        } catch {}
      }
      return { fallbackActive };
    },

    catalog: () => [...meta.values()],
    catalogEntry: (sessionId) => meta.get(sessionId),
  };
}
