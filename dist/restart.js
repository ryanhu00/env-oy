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
exports.RESTART_CHANNEL_PREFIX = exports.RESTART_STATE_VERSION = void 0;
exports.validateRestartState = validateRestartState;
exports.validateRestartChannelPath = validateRestartChannelPath;
exports.writeRestartState = writeRestartState;
exports.consumeRestartState = consumeRestartState;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
exports.RESTART_STATE_VERSION = 1;
exports.RESTART_CHANNEL_PREFIX = 'restart-channel-';
const NOTIFICATION_TYPES = new Set(['stop', 'permission', 'exit']);
const RESTORABLE_STATUSES = new Set(['working', 'waiting', 'needs-permission']);
/**
 * Validates one unread notification from a handoff record.
 * @param value Parsed JSON value checked for a known type and finite timestamp.
 * @returns A copied notification, or null when invalid.
 */
function validateNotification(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.type !== 'string' || !NOTIFICATION_TYPES.has(record.type))
        return null;
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts) || record.ts < 0)
        return null;
    return { type: record.type, ts: record.ts };
}
/**
 * Validates one resumable ACTIVE-session record against current tags.
 * @param value Parsed JSON value to inspect.
 * @param tags Current canonical tags allowed during restore.
 * @returns A safe copied record, or null when any field is invalid.
 */
function validateSession(value, tags) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.devinSessionId !== 'string' || !record.devinSessionId.trim() || record.devinSessionId !== record.devinSessionId.trim())
        return null;
    if (typeof record.cwd !== 'string' || !record.cwd.trim())
        return null;
    if (typeof record.name !== 'string' || !record.name.trim())
        return null;
    if (typeof record.tag !== 'string' || !record.tag.trim() || !tags.has(record.tag))
        return null;
    if (typeof record.status !== 'string' || !RESTORABLE_STATUSES.has(record.status))
        return null;
    if (record.markedDone !== undefined && typeof record.markedDone !== 'boolean')
        return null;
    if (!Array.isArray(record.unread))
        return null;
    const unread = record.unread.map(validateNotification);
    if (unread.some((entry) => entry === null))
        return null;
    return {
        devinSessionId: record.devinSessionId,
        cwd: record.cwd,
        name: record.name,
        tag: record.tag,
        unread: unread,
        status: record.status,
        // absent stays absent so version-1 handoffs round-trip byte-identically
        ...(record.markedDone === undefined ? {} : { markedDone: record.markedDone }),
    };
}
/**
 * Validates a complete versioned handoff while skipping malformed session records.
 * @param value Parsed JSON value to inspect.
 * @param tags Current canonical tags allowed during restore.
 * @returns Sanitized state, or null when the top-level schema/version is invalid.
 */
function validateRestartState(value, tags) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    if (record.version !== exports.RESTART_STATE_VERSION || !Array.isArray(record.sessions))
        return null;
    const selectedSessionId = record.selectedSessionId === null
        ? null
        : typeof record.selectedSessionId === 'string' && record.selectedSessionId.trim() && record.selectedSessionId === record.selectedSessionId.trim()
            ? record.selectedSessionId
            : null;
    const seen = new Set();
    const sessions = [];
    const allowedTags = new Set(tags);
    for (const value of record.sessions) {
        const session = validateSession(value, allowedTags);
        if (!session || seen.has(session.devinSessionId))
            continue;
        seen.add(session.devinSessionId);
        sessions.push(session);
    }
    const lastPromptAt = typeof record.lastPromptAt === 'number' && Number.isFinite(record.lastPromptAt) && record.lastPromptAt >= 0 ? record.lastPromptAt : undefined;
    return {
        version: exports.RESTART_STATE_VERSION,
        selectedSessionId,
        sessions,
        // absent stays absent so version-1 handoffs round-trip byte-identically
        ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
    };
}
/**
 * Validates a launcher channel as a direct child of the private conductor data directory.
 * @param filePath Untrusted channel path from the process environment.
 * @param dataDir Expected private data directory; tests may provide an isolated directory.
 * @returns Normalized absolute channel path, or null when unavailable or unsafe.
 */
function validateRestartChannelPath(filePath, dataDir = path.join(os.homedir(), '.local', 'share', 'devin-conductor')) {
    if (!filePath || !path.isAbsolute(filePath))
        return null;
    const root = path.resolve(dataDir);
    const target = path.resolve(filePath);
    if (target !== filePath || path.dirname(target) !== root || !path.basename(target).startsWith(exports.RESTART_CHANNEL_PREFIX))
        return null;
    return target;
}
/**
 * Atomically writes validated handoff state to an exact private launcher channel.
 * @param state Complete restart snapshot containing only resumable session metadata.
 * @param target Absolute launcher channel path to replace atomically.
 * @param dataDir Expected private data directory; tests may provide an isolated directory.
 * @returns The validated absolute target path.
 */
function writeRestartState(state, target, dataDir = path.join(os.homedir(), '.local', 'share', 'devin-conductor')) {
    const channel = validateRestartChannelPath(target, dataDir);
    if (!channel)
        throw new Error('Invalid restart channel');
    const validated = validateRestartState(state, [...new Set(state.sessions.map((session) => session.tag))]);
    if (!validated || validated.sessions.length !== state.sessions.length)
        throw new Error('Invalid restart state');
    const parent = path.dirname(channel);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    let temp = `${channel}.tmp-${process.pid}-${Date.now()}`;
    let suffix = 0;
    while (fs.existsSync(temp))
        temp = `${channel}.tmp-${process.pid}-${Date.now()}-${++suffix}`;
    try {
        fs.writeFileSync(temp, JSON.stringify(validated) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, channel);
        fs.chmodSync(channel, 0o600);
        return channel;
    }
    finally {
        try {
            fs.unlinkSync(temp);
        }
        catch { }
    }
}
/**
 * Reads and immediately deletes one launcher channel before parsing and validation.
 * @param filePath Validated channel path received through DEVIN_CONDUCTOR_RESTART_CHANNEL.
 * @param tags Current canonical tags allowed during restore.
 * @returns Sanitized state, or null after read, parse, or schema failure.
 */
function consumeRestartState(filePath, tags) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        try {
            fs.unlinkSync(filePath);
        }
        catch { }
        return null;
    }
    try {
        fs.unlinkSync(filePath);
    }
    catch { }
    try {
        return validateRestartState(JSON.parse(raw), tags);
    }
    catch {
        return null;
    }
}
