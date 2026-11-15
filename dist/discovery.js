"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Discovery = void 0;
exports.parsePsDevinProcesses = parsePsDevinProcesses;
exports.parsePsDevinPids = parsePsDevinPids;
exports.parseLsofSessions = parseLsofSessions;
const child_process_1 = require("child_process");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
const RECENT_FALLBACK_SQL = "SELECT id, working_directory, last_activity_at, title FROM sessions NOT INDEXED WHERE hidden = 0 AND last_activity_at >= unixepoch('now') - 86400 ORDER BY last_activity_at DESC;";
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
function isDevinReplCommand(command) {
    if (command !== 'devin' && !command.startsWith('devin '))
        return false;
    return !EXCLUDED_SUBCOMMANDS.has(command.split(/\s+/)[1] || '');
}
/**
 * Parses validated Devin REPL RSS samples from `ps -axo pid=,rss=,command=` output.
 * @param output Raw ps stdout with RSS in KiB.
 * @returns Deduplicated process samples with byte counts.
 */
function parsePsDevinProcesses(output) {
    const processes = [];
    const seen = new Set();
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!match || !isDevinReplCommand(match[3]))
            continue;
        const pid = Number(match[1]);
        const rssKiB = Number(match[2]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid))
            continue;
        if (!Number.isSafeInteger(rssKiB) || rssKiB < 0 || rssKiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024))
            continue;
        seen.add(pid);
        processes.push({ pid, rssBytes: rssKiB * 1024 });
    }
    return processes;
}
/**
 * Extracts Devin REPL pids from legacy pid/command or current pid/RSS/command ps output.
 * @param output Raw ps stdout.
 * @returns Array of REPL pids for compatibility callers.
 */
function parsePsDevinPids(output) {
    const pids = [];
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match)
            continue;
        const rssCommand = match[2].match(/^\d+\s+(.*)$/);
        const command = rssCommand && isDevinReplCommand(rssCommand[1]) ? rssCommand[1] : match[2];
        const pid = Number(match[1]);
        if (isDevinReplCommand(command) && Number.isSafeInteger(pid) && pid > 0)
            pids.push(pid);
    }
    return pids;
}
/**
 * Parses batched `lsof -a -p pid1,pid2 -Fn` output into per-pid cwd and devin session id,
 * using `p<pid>` marker lines, the `n` line following `fcwd`, and any open
 * `session_locks/<id>.lock` path.
 * @param output Raw lsof -Fn stdout.
 * @returns Map from pid to its discovered cwd and/or session id.
 */
function parseLsofSessions(output) {
    const map = new Map();
    let pid = 0;
    let awaitingCwd = false;
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) {
            pid = parseInt(line.slice(1), 10);
            if (!map.has(pid))
                map.set(pid, {});
            awaitingCwd = false;
        }
        else if (line === 'fcwd') {
            awaitingCwd = true;
        }
        else if (line.startsWith('f')) {
            awaitingCwd = false;
        }
        else if (line.startsWith('n') && pid) {
            const entry = map.get(pid);
            if (awaitingCwd) {
                entry.cwd = line.slice(1);
                awaitingCwd = false;
            }
            const m = line.match(/\/session_locks\/([^/]+)\.lock$/);
            if (m)
                entry.sessionId = m[1];
        }
    }
    return map;
}
class Discovery {
    ownedPids;
    ownedSessionIds;
    baseDirs;
    onOwnedSessions;
    onUpdate;
    sessionsDbPath;
    externals = [];
    recents = [];
    totalMemoryBytes = null;
    recentFallbackActive = false;
    timer = null;
    polling = false;
    meta = new Map();
    /**
     * Discovers devin REPLs running in other terminals plus recently active resumable
     * sessions, refreshing every 5s without blocking rendering (all execs are async).
     * @param ownedPids Returns pids of PTY children spawned by this app (never listed as external).
     * @param ownedSessionIds Returns devin session ids this app has resumed/adopted.
     * @param baseDirs Directories always scanned with `devin list` (default cwd, launch cwd).
     * @param onOwnedSessions Reports owned pid memory plus optional real-id lock mappings.
     * @param onUpdate Invoked after each poll or removal to schedule a redraw.
     * @param sessionsDbPath Read-only Devin sessions database used when primary listing fails.
     */
    constructor(ownedPids, ownedSessionIds, baseDirs, onOwnedSessions, onUpdate, sessionsDbPath = path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db')) {
        this.ownedPids = ownedPids;
        this.ownedSessionIds = ownedSessionIds;
        this.baseDirs = baseDirs;
        this.onOwnedSessions = onOwnedSessions;
        this.onUpdate = onUpdate;
        this.sessionsDbPath = sessionsDbPath;
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
     * Samples Devin REPL RSS, maps lock ids/cwds, and refreshes external and recent rows.
     * @returns Promise resolved after one non-overlapping discovery cycle.
     */
    async poll() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            const ps = await execFileP('ps', ['-axo', 'pid=,rss=,command=']);
            const processes = parsePsDevinProcesses(ps.stdout);
            const allPids = processes.map((processSample) => processSample.pid);
            const memoryByPid = new Map(processes.map((processSample) => [processSample.pid, processSample.rssBytes]));
            let totalMemoryBytes = 0;
            for (const processSample of processes) {
                if (totalMemoryBytes > Number.MAX_SAFE_INTEGER - processSample.rssBytes) {
                    totalMemoryBytes = -1;
                    break;
                }
                totalMemoryBytes += processSample.rssBytes;
            }
            this.totalMemoryBytes = totalMemoryBytes < 0 ? null : totalMemoryBytes;
            let lockMap = new Map();
            if (allPids.length > 0) {
                let out = '';
                try {
                    out = (await execFileP('lsof', ['-a', '-p', allPids.join(','), '-Fn'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
                }
                catch (e) {
                    out = e.stdout ?? '';
                }
                lockMap = parseLsofSessions(out);
            }
            const owned = this.ownedPids();
            const ownedSessions = new Map();
            for (const [pid, memoryBytes] of memoryByPid) {
                if (owned.has(pid))
                    ownedSessions.set(pid, { memoryBytes });
            }
            const externals = [];
            const runningIds = new Set();
            for (const [pid, info] of lockMap) {
                if (!info.sessionId)
                    continue;
                runningIds.add(info.sessionId);
                if (owned.has(pid)) {
                    const sample = ownedSessions.get(pid);
                    if (sample)
                        sample.sessionId = info.sessionId;
                }
                else {
                    externals.push({ pid, sessionId: info.sessionId, cwd: info.cwd || process.cwd(), title: '', lastAgo: '', memoryBytes: memoryByPid.get(pid) ?? null });
                }
            }
            this.onOwnedSessions(ownedSessions);
            const dirs = new Set(this.baseDirs);
            for (const e of externals)
                dirs.add(e.cwd);
            const failedDirs = new Set((await Promise.all([...dirs].map(async (dir) => {
                try {
                    const res = await execFileP('devin', ['list', '--format', 'json'], { cwd: dir, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
                    for (const row of JSON.parse(res.stdout)) {
                        if (!row || typeof row.id !== 'string')
                            continue;
                        this.meta.set(row.id, {
                            sessionId: row.id,
                            cwd: String(row.working_directory || dir),
                            title: String(row.title || ''),
                            lastAgo: String(row.last_activity_ago || ''),
                            lastActivityAt: Number(row.last_activity_at) || 0,
                        });
                    }
                    return null;
                }
                catch {
                    return dir;
                }
            }))).filter((dir) => dir !== null));
            this.recentFallbackActive = false;
            if (failedDirs.size > 0) {
                try {
                    const result = await execFileP('sqlite3', ['-readonly', '-json', this.sessionsDbPath, RECENT_FALLBACK_SQL], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
                    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
                    if (!Array.isArray(parsed))
                        throw new Error('Invalid sqlite3 JSON output');
                    const now = Date.now() / 1000;
                    const cutoff = now - 86400;
                    for (const value of parsed) {
                        if (!value || typeof value !== 'object')
                            continue;
                        const row = value;
                        const sessionId = typeof row.id === 'string' ? row.id.trim() : '';
                        const cwd = typeof row.working_directory === 'string' ? row.working_directory.trim() : '';
                        const lastActivityAt = Number(row.last_activity_at);
                        if (!sessionId || !cwd || !failedDirs.has(cwd) || !Number.isFinite(lastActivityAt) || lastActivityAt < cutoff)
                            continue;
                        if (row.title !== null && row.title !== undefined && typeof row.title !== 'string')
                            continue;
                        const elapsed = Math.max(0, Math.floor(now - lastActivityAt));
                        const lastAgo = elapsed < 60 ? 'just now' : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ago` : `${Math.floor(elapsed / 3600)}h ago`;
                        this.meta.set(sessionId, { sessionId, cwd, title: row.title ?? '', lastAgo, lastActivityAt });
                    }
                    this.recentFallbackActive = true;
                }
                catch { }
            }
            for (const e of externals) {
                const m = this.meta.get(e.sessionId);
                if (m) {
                    e.title = m.title;
                    e.lastAgo = m.lastAgo;
                }
            }
            const ownedIds = this.ownedSessionIds();
            const cutoff = Date.now() / 1000 - 86400;
            this.externals = externals;
            this.recents = [...this.meta.values()]
                .filter((m) => m.lastActivityAt >= cutoff && !runningIds.has(m.sessionId) && !ownedIds.has(m.sessionId))
                .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                .slice(0, 10);
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
