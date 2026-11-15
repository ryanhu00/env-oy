import { execFile } from 'child_process';
import { promisify } from 'util';
import { parsePsProcesses } from './adapters/ps';
import { createAdapters } from './adapters/registry';
import { sessionKey } from './adapters/types';
import type { AdapterId, CliAdapter, ExternalSession, OwnedSessionSample, RecentSession } from './adapters/types';

export type { ExternalSession, OwnedSessionSample, RecentSession } from './adapters/types';

const execFileP = promisify(execFile);

/** Default maximum number of RECENT rows, shared by all enabled CLIs. */
export const DEFAULT_RECENT_LIMIT = 10;

/**
 * Chooses which recent sessions to show when there is room for only `limit` of them. Slots are
 * dealt round-robin across CLIs (each CLI's newest first, the CLI with the newest session going
 * first), so a busy CLI cannot crowd every other CLI out of the list, yet unused slots still go
 * to whichever CLI has more. With a single CLI this is simply the newest `limit` sessions.
 * @param candidates Resumable sessions that passed the age and not-running filters.
 * @param limit Maximum rows to return.
 * @returns The chosen sessions, newest first.
 */
export function pickRecents(candidates: readonly RecentSession[], limit: number): RecentSession[] {
  const groups = new Map<AdapterId, RecentSession[]>();
  for (const session of [...candidates].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    const group = groups.get(session.adapterId);
    if (group) group.push(session);
    else groups.set(session.adapterId, [session]);
  }
  const queues = [...groups.values()]; // Map preserves insertion order, i.e. newest-first by CLI
  const picked: RecentSession[] = [];
  for (let round = 0; picked.length < limit; round++) {
    let added = false;
    for (const queue of queues) {
      if (picked.length >= limit) break;
      if (round < queue.length) {
        picked.push(queue[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export class Discovery {
  externals: ExternalSession[] = [];
  recents: RecentSession[] = [];
  totalMemoryBytes: number | null = null;
  /** REPL memory per CLI from the last poll (for the per-CLI status-bar breakdown). */
  memoryByAdapter = new Map<AdapterId, number>();
  recentFallbackActive = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  /**
   * Discovers agent REPLs running in other terminals plus recently active resumable
   * sessions, refreshing every 5s without blocking rendering (all execs are async).
   * Everything CLI-specific is delegated to the supplied adapters.
   * @param ownedPids Returns pids of PTY children spawned by this app (never listed as external).
   * @param ownedSessionKeys Returns session keys (see `sessionKey`) this app has resumed/adopted.
   * @param baseDirs Directories always scanned when a CLI lists sessions per directory.
   * @param onOwnedSessions Reports owned pid memory plus optional real session ids.
   * @param onUpdate Invoked after each poll or removal to schedule a redraw.
   * @param adapters CLI adapters to poll; defaults to the registry's enabled adapters.
   * @param recentLimit Maximum RECENT rows across all CLIs (see `pickRecents`).
   */
  constructor(
    private readonly ownedPids: () => Set<number>,
    private readonly ownedSessionKeys: () => Set<string>,
    private baseDirs: string[],
    private readonly onOwnedSessions: (sessions: Map<number, OwnedSessionSample>) => void,
    private readonly onUpdate: () => void,
    private readonly adapters: readonly CliAdapter[] = createAdapters(),
    /** Maximum RECENT rows; the settings screen may change it while running. */
    public recentLimit = DEFAULT_RECENT_LIMIT
  ) {}

  /**
   * Replaces the always-scanned directories (used when the default directory changes).
   * @param dirs New base directories.
   * @returns Nothing; applied from the next poll.
   */
  setBaseDirs(dirs: string[]): void {
    this.baseDirs = [...dirs];
  }

  /**
   * Starts an immediate poll (a no-op while one is already running).
   * @returns Nothing.
   */
  refresh(): void {
    void this.poll();
  }

  /**
   * Runs an immediate poll and starts the 5s refresh interval.
   * @returns Nothing.
   */
  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5000);
  }

  /**
   * Stops the refresh interval; used on quit.
   * @returns Nothing.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Proactively drops an external row (used right after a successful adoption, before the
   * next poll would notice the pid is gone).
   * @param pid Pid of the adopted external process.
   * @returns Nothing.
   */
  removeExternal(pid: number): void {
    this.externals = this.externals.filter((e) => e.pid !== pid);
    this.onUpdate();
  }

  /**
   * Samples REPL RSS for every adapter, maps session ids/cwds, and refreshes external and
   * recent rows.
   * @returns Promise resolved after one non-overlapping discovery cycle.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const ps = await execFileP('ps', ['-axo', 'pid=,rss=,command=']);
      const claimed = new Set<number>();
      const sampled = this.adapters.map((adapter) => {
        const samples = parsePsProcesses(ps.stdout, (command) => adapter.isReplProcess(command)).filter((sample) => !claimed.has(sample.pid));
        for (const sample of samples) claimed.add(sample.pid);
        return { adapter, samples };
      });
      const memoryByPid = new Map<number, number>();
      let totalMemoryBytes = 0;
      const memoryByAdapter = new Map<AdapterId, number>();
      for (const { adapter, samples } of sampled) {
        for (const sample of samples) {
          memoryByPid.set(sample.pid, sample.rssBytes);
          memoryByAdapter.set(adapter.id, (memoryByAdapter.get(adapter.id) ?? 0) + sample.rssBytes);
          if (totalMemoryBytes >= 0 && totalMemoryBytes > Number.MAX_SAFE_INTEGER - sample.rssBytes) totalMemoryBytes = -1;
          if (totalMemoryBytes >= 0) totalMemoryBytes += sample.rssBytes;
        }
      }
      this.totalMemoryBytes = totalMemoryBytes < 0 ? null : totalMemoryBytes;
      this.memoryByAdapter = memoryByAdapter;

      const owned = this.ownedPids();
      const ownedSessions = new Map<number, OwnedSessionSample>();
      for (const [pid, memoryBytes] of memoryByPid) {
        if (owned.has(pid)) ownedSessions.set(pid, { memoryBytes });
      }
      const externals: ExternalSession[] = [];
      const runningKeys = new Set<string>();
      for (const { adapter, samples } of sampled) {
        const info = await adapter.resolveProcesses(samples.map((sample) => sample.pid));
        for (const [pid, entry] of info) {
          if (!entry.sessionId) continue;
          runningKeys.add(sessionKey(adapter.id, entry.sessionId));
          if (owned.has(pid)) {
            const sample = ownedSessions.get(pid);
            if (sample) sample.sessionId = entry.sessionId;
          } else {
            externals.push({
              adapterId: adapter.id,
              pid,
              sessionId: entry.sessionId,
              cwd: entry.cwd || process.cwd(),
              title: entry.title ?? '',
              lastAgo: '',
              memoryBytes: memoryByPid.get(pid) ?? null,
            });
          }
        }
      }
      this.onOwnedSessions(ownedSessions);

      let fallbackActive = false;
      for (const adapter of this.adapters) {
        const dirs = new Set(this.baseDirs);
        for (const e of externals) if (e.adapterId === adapter.id) dirs.add(e.cwd);
        const result = await adapter.refreshCatalog(dirs);
        if (result.fallbackActive) fallbackActive = true;
      }
      this.recentFallbackActive = fallbackActive;

      const adaptersById = new Map(this.adapters.map((adapter) => [adapter.id, adapter]));
      for (const e of externals) {
        const m = adaptersById.get(e.adapterId)?.catalogEntry(e.sessionId);
        if (m) {
          e.title = m.title || e.title;
          e.lastAgo = m.lastAgo;
        }
      }
      const ownedKeys = this.ownedSessionKeys();
      const cutoff = Date.now() / 1000 - 86400;
      this.externals = externals;
      this.recents = pickRecents(
        this.adapters.flatMap((adapter) => adapter.catalog()).filter((m) => {
          const key = sessionKey(m.adapterId, m.sessionId);
          return m.lastActivityAt >= cutoff && !runningKeys.has(key) && !ownedKeys.has(key);
        }),
        this.recentLimit
      );
    } catch {
    } finally {
      this.polling = false;
      this.onUpdate();
    }
  }
}
