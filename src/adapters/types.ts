/** Identifiers of the agent CLIs Envoy knows how to drive. */
export type AdapterId = 'devin' | 'claude' | 'codex';

export const ADAPTER_IDS: readonly AdapterId[] = ['devin', 'claude', 'codex'];

export const DEFAULT_ADAPTER_ID: AdapterId = 'devin';

/**
 * Builds the persistence key for a CLI session so ids from different CLIs never collide.
 * Devin ids are stored bare; every other adapter is prefixed with `<adapter>:`.
 * @param adapterId Adapter that owns the session.
 * @param sessionId Real session id reported by that CLI.
 * @returns Key used for aliases, saved order, tag assignment and resume bookkeeping.
 */
export function sessionKey(adapterId: AdapterId, sessionId: string): string {
  return adapterId === 'devin' ? sessionId : `${adapterId}:${sessionId}`;
}

/** A REPL process sampled from `ps`. */
export interface ProcessSample {
  pid: number;
  rssBytes: number;
}

/** Memory (and optional real session id) for a process this app owns. */
export interface OwnedSessionSample {
  sessionId?: string;
  memoryBytes: number;
}

/** What an adapter could learn about a running REPL process. */
export interface ProcessInfo {
  sessionId?: string;
  cwd?: string;
  /** Display name the CLI itself reports for a live session; used until the catalog has a title. */
  title?: string;
}

/** A live REPL running in another terminal window. */
export interface ExternalSession {
  adapterId: AdapterId;
  pid: number;
  sessionId: string;
  cwd: string;
  title: string;
  lastAgo: string;
  memoryBytes: number | null;
}

/** A recently active session that is not running anywhere and can be resumed. */
export interface RecentSession {
  adapterId: AdapterId;
  sessionId: string;
  cwd: string;
  title: string;
  lastAgo: string;
  lastActivityAt: number;
}

/**
 * Everything Envoy needs to know about one agent CLI. The core (PTYs, sidebar, input,
 * refresh) depends only on this interface and never on a specific CLI.
 */
export interface CliAdapter {
  readonly id: AdapterId;
  /** Human-readable name, e.g. "Devin". */
  readonly label: string;
  /** Short badge shown next to sessions of this CLI, e.g. "DV". */
  readonly badge: string;
  /**
   * True when a running REPL can switch to a different session id (Claude after `/clear`).
   * Hook events then re-key the session; otherwise the first id learned is final.
   */
  readonly sessionIdChanges: boolean;
  /** Executable spawned for a session of this CLI. */
  command(): string;
  /** Arguments for a brand-new session. */
  freshArgs(): string[];
  /** Arguments that resume an existing session by real id. */
  resumeArgs(sessionId: string): string[];
  /** True when a `ps` command line is an interactive REPL of this CLI. */
  isReplProcess(psCommand: string): boolean;
  /** Maps REPL pids to their real session id and cwd (lock files, registry, ...). */
  resolveProcesses(pids: number[]): Promise<Map<number, ProcessInfo>>;
  /**
   * Refreshes this adapter's catalog of known sessions (cached across polls).
   * @param dirs Directories that should be scanned when the CLI lists sessions per directory.
   * @returns Whether a degraded fallback source was used for this refresh.
   */
  refreshCatalog(dirs: ReadonlySet<string>): Promise<{ fallbackActive: boolean }>;
  /** All sessions currently cached in the catalog. */
  catalog(): readonly RecentSession[];
  /** Looks up one cached session by real id. */
  catalogEntry(sessionId: string): RecentSession | undefined;
}
