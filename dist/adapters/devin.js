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
exports.isDevinReplCommand = isDevinReplCommand;
exports.parsePsDevinProcesses = parsePsDevinProcesses;
exports.parsePsDevinPids = parsePsDevinPids;
exports.parseLsofSessions = parseLsofSessions;
exports.createDevinAdapter = createDevinAdapter;
const child_process_1 = require("child_process");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const paths_1 = require("../paths");
const ps_1 = require("./ps");
const time_1 = require("./time");
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
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
    return (0, ps_1.parsePsProcesses)(output, isDevinReplCommand);
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
 * Parses batched lsof output into per-pid cwd and Devin session id from `session_locks`.
 * @param output Raw lsof -Fn stdout.
 * @returns Map from pid to its discovered cwd and/or session id.
 */
function parseLsofSessions(output) {
    return (0, ps_1.parseLsofLocks)(output, DEVIN_LOCK_PATTERN);
}
/**
 * Creates the Devin CLI adapter. Each instance owns its own session catalog cache.
 * @param options Optional overrides, primarily for tests.
 * @returns A CliAdapter for `devin`.
 */
function createDevinAdapter(options = {}) {
    const sessionsDbPath = options.sessionsDbPath ?? path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db');
    const meta = new Map();
    return {
        id: 'devin',
        label: 'Devin',
        badge: 'DV',
        sessionIdChanges: false,
        command: () => (0, paths_1.envoyEnv)('CMD') || options.command || 'devin',
        freshArgs: () => [],
        resumeArgs: (sessionId) => ['-r', sessionId],
        isReplProcess: isDevinReplCommand,
        async resolveProcesses(pids) {
            if (pids.length === 0)
                return new Map();
            let out = '';
            try {
                out = (await execFileP('lsof', ['-a', '-p', pids.join(','), '-Fn'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
            }
            catch (e) {
                out = e.stdout ?? '';
            }
            return parseLsofSessions(out);
        },
        async refreshCatalog(dirs) {
            const failedDirs = new Set((await Promise.all([...dirs].map(async (dir) => {
                try {
                    const res = await execFileP('devin', ['list', '--format', 'json'], { cwd: dir, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
                    for (const row of JSON.parse(res.stdout)) {
                        if (!row || typeof row.id !== 'string')
                            continue;
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
                }
                catch {
                    return dir;
                }
            }))).filter((dir) => dir !== null));
            let fallbackActive = false;
            if (failedDirs.size > 0) {
                try {
                    const result = await execFileP('sqlite3', ['-readonly', '-json', sessionsDbPath, RECENT_FALLBACK_SQL], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
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
                        meta.set(sessionId, { adapterId: 'devin', sessionId, cwd, title: row.title ?? '', lastAgo: (0, time_1.agoLabel)(now - lastActivityAt), lastActivityAt });
                    }
                    fallbackActive = true;
                }
                catch { }
            }
            return { fallbackActive };
        },
        catalog: () => [...meta.values()],
        catalogEntry: (sessionId) => meta.get(sessionId),
    };
}
