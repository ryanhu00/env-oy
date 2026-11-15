"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Discovery = exports.DEFAULT_RECENT_LIMIT = void 0;
exports.pickRecents = pickRecents;
const child_process_1 = require("child_process");
const util_1 = require("util");
const ps_1 = require("./adapters/ps");
const registry_1 = require("./adapters/registry");
const types_1 = require("./adapters/types");
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
/** Default maximum number of RECENT rows, shared by all enabled CLIs. */
exports.DEFAULT_RECENT_LIMIT = 10;
/**
 * Chooses which recent sessions to show when there is room for only `limit` of them. Slots are
 * dealt round-robin across CLIs (each CLI's newest first, the CLI with the newest session going
 * first), so a busy CLI cannot crowd every other CLI out of the list, yet unused slots still go
 * to whichever CLI has more. With a single CLI this is simply the newest `limit` sessions.
 * @param candidates Resumable sessions that passed the age and not-running filters.
 * @param limit Maximum rows to return.
 * @returns The chosen sessions, newest first.
 */
function pickRecents(candidates, limit) {
    const groups = new Map();
    for (const session of [...candidates].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
        const group = groups.get(session.adapterId);
        if (group)
            group.push(session);
        else
            groups.set(session.adapterId, [session]);
    }
    const queues = [...groups.values()]; // Map preserves insertion order, i.e. newest-first by CLI
    const picked = [];
    for (let round = 0; picked.length < limit; round++) {
        let added = false;
        for (const queue of queues) {
            if (picked.length >= limit)
                break;
            if (round < queue.length) {
                picked.push(queue[round]);
                added = true;
            }
        }
        if (!added)
            break;
    }
    return picked.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
class Discovery {
    ownedPids;
    ownedSessionKeys;
    baseDirs;
    onOwnedSessions;
    onUpdate;
    adapters;
    recentLimit;
    externals = [];
    recents = [];
    totalMemoryBytes = null;
    /** REPL memory per CLI from the last poll (for the per-CLI status-bar breakdown). */
    memoryByAdapter = new Map();
    recentFallbackActive = false;
    timer = null;
    polling = false;
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
    constructor(ownedPids, ownedSessionKeys, baseDirs, onOwnedSessions, onUpdate, adapters = (0, registry_1.createAdapters)(), recentLimit = exports.DEFAULT_RECENT_LIMIT) {
        this.ownedPids = ownedPids;
        this.ownedSessionKeys = ownedSessionKeys;
        this.baseDirs = baseDirs;
        this.onOwnedSessions = onOwnedSessions;
        this.onUpdate = onUpdate;
        this.adapters = adapters;
        this.recentLimit = recentLimit;
    }
    /**
     * Runs an immediate poll and starts the 5s refresh interval.
     * @returns Nothing.
     */
    start() {
        void this.poll();
        this.timer = setInterval(() => void this.poll(), 5000);
    }
    /**
     * Stops the refresh interval; used on quit.
     * @returns Nothing.
     */
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /**
     * Proactively drops an external row (used right after a successful adoption, before the
     * next poll would notice the pid is gone).
     * @param pid Pid of the adopted external process.
     * @returns Nothing.
     */
    removeExternal(pid) {
        this.externals = this.externals.filter((e) => e.pid !== pid);
        this.onUpdate();
    }
    /**
     * Samples REPL RSS for every adapter, maps session ids/cwds, and refreshes external and
     * recent rows.
     * @returns Promise resolved after one non-overlapping discovery cycle.
     */
    async poll() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            const ps = await execFileP('ps', ['-axo', 'pid=,rss=,command=']);
            const claimed = new Set();
            const sampled = this.adapters.map((adapter) => {
                const samples = (0, ps_1.parsePsProcesses)(ps.stdout, (command) => adapter.isReplProcess(command)).filter((sample) => !claimed.has(sample.pid));
                for (const sample of samples)
                    claimed.add(sample.pid);
                return { adapter, samples };
            });
            const memoryByPid = new Map();
            let totalMemoryBytes = 0;
            const memoryByAdapter = new Map();
            for (const { adapter, samples } of sampled) {
                for (const sample of samples) {
                    memoryByPid.set(sample.pid, sample.rssBytes);
                    memoryByAdapter.set(adapter.id, (memoryByAdapter.get(adapter.id) ?? 0) + sample.rssBytes);
                    if (totalMemoryBytes >= 0 && totalMemoryBytes > Number.MAX_SAFE_INTEGER - sample.rssBytes)
                        totalMemoryBytes = -1;
                    if (totalMemoryBytes >= 0)
                        totalMemoryBytes += sample.rssBytes;
                }
            }
            this.totalMemoryBytes = totalMemoryBytes < 0 ? null : totalMemoryBytes;
            this.memoryByAdapter = memoryByAdapter;
            const owned = this.ownedPids();
            const ownedSessions = new Map();
            for (const [pid, memoryBytes] of memoryByPid) {
                if (owned.has(pid))
                    ownedSessions.set(pid, { memoryBytes });
            }
            const externals = [];
            const runningKeys = new Set();
            for (const { adapter, samples } of sampled) {
                const info = await adapter.resolveProcesses(samples.map((sample) => sample.pid));
                for (const [pid, entry] of info) {
                    if (!entry.sessionId)
                        continue;
                    runningKeys.add((0, types_1.sessionKey)(adapter.id, entry.sessionId));
                    if (owned.has(pid)) {
                        const sample = ownedSessions.get(pid);
                        if (sample)
                            sample.sessionId = entry.sessionId;
                    }
                    else {
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
                for (const e of externals)
                    if (e.adapterId === adapter.id)
                        dirs.add(e.cwd);
                const result = await adapter.refreshCatalog(dirs);
                if (result.fallbackActive)
                    fallbackActive = true;
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
            this.recents = pickRecents(this.adapters.flatMap((adapter) => adapter.catalog()).filter((m) => {
                const key = (0, types_1.sessionKey)(m.adapterId, m.sessionId);
                return m.lastActivityAt >= cutoff && !runningKeys.has(key) && !ownedKeys.has(key);
            }), this.recentLimit);
        }
        catch {
        }
        finally {
            this.polling = false;
            this.onUpdate();
        }
    }
}
exports.Discovery = Discovery;
