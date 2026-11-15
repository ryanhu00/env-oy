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
exports.EventsTailer = exports.EventDeduper = exports.EVENT_DEDUPE_WINDOW_MS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Identical hook events for the same session closer together than this are one event. */
exports.EVENT_DEDUPE_WINDOW_MS = 1000;
/**
 * Collapses duplicate hook deliveries. One CLI event can run the Envoy hook more than once
 * (for example Devin also reads `~/.claude/settings.json`), so identical events for the same
 * session within a short window are treated as a single event.
 */
class EventDeduper {
    windowMs;
    seen = new Map();
    /**
     * @param windowMs Maximum gap between two identical events that still counts as a duplicate.
     */
    constructor(windowMs = exports.EVENT_DEDUPE_WINDOW_MS) {
        this.windowMs = windowMs;
    }
    /**
     * Records an event and reports whether it duplicates one seen within the window. A
     * duplicate does not extend the window, so a steady stream of events is never swallowed.
     * @param id Envoy session id the hook ran under.
     * @param event Hook event name.
     * @param payload Hook stdin payload, when it was valid JSON.
     * @param at Event time in milliseconds (the hook's own `ts`, or arrival time).
     * @returns True when the event should be dropped.
     */
    isDuplicate(id, event, payload, at) {
        const key = `${id}\u0000${event}\u0000${JSON.stringify(payload ?? null)}`;
        const last = this.seen.get(key);
        if (last !== undefined && Math.abs(at - last) <= this.windowMs)
            return true;
        this.seen.set(key, at);
        if (this.seen.size > 64) {
            for (const [k, t] of this.seen)
                if (at - t > this.windowMs * 5)
                    this.seen.delete(k);
        }
        return false;
    }
}
exports.EventDeduper = EventDeduper;
class EventsTailer {
    dir;
    onEvent;
    offset = 0;
    carry = '';
    watcher = null;
    timer = null;
    file;
    deduper = new EventDeduper();
    /**
     * Tails `events.jsonl` in the conductor data dir, dispatching each appended hook event.
     * @param dir Events directory (default ~/.local/share/envoy).
     * @param onEvent Callback receiving the session id and hook event name per line.
     */
    constructor(dir, onEvent) {
        this.dir = dir;
        this.onEvent = onEvent;
        this.file = path.join(dir, 'events.jsonl');
    }
    /**
     * Creates the dir/file if missing, records the current size so pre-existing events are
     * skipped, then starts fs.watch plus a 500ms polling fallback.
     * @returns Nothing.
     */
    start() {
        fs.mkdirSync(this.dir, { recursive: true });
        if (!fs.existsSync(this.file))
            fs.writeFileSync(this.file, '');
        this.offset = fs.statSync(this.file).size;
        try {
            this.watcher = fs.watch(this.dir, () => this.drain());
        }
        catch {
            this.watcher = null;
        }
        this.timer = setInterval(() => this.drain(), 500);
    }
    /**
     * Reads bytes appended since the last offset, buffers partial lines, parses each complete
     * JSON line and dispatches valid `{id, event}` records to the callback, dropping duplicate deliveries.
     * @returns Nothing.
     */
    drain() {
        let size;
        try {
            size = fs.statSync(this.file).size;
        }
        catch {
            return;
        }
        if (size < this.offset) {
            this.offset = 0;
            this.carry = '';
        }
        if (size === this.offset)
            return;
        const buf = Buffer.alloc(size - this.offset);
        const fd = fs.openSync(this.file, 'r');
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        fs.closeSync(fd);
        this.offset = size;
        const chunks = (this.carry + buf.toString('utf8')).split('\n');
        this.carry = chunks.pop() ?? '';
        for (const line of chunks) {
            if (!line.trim())
                continue;
            try {
                const e = JSON.parse(line);
                const payload = e && typeof e.payload === 'object' && e.payload !== null && !Array.isArray(e.payload) ? e.payload : undefined;
                if (!e || typeof e.id !== 'string' || typeof e.event !== 'string')
                    continue;
                const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
                if (this.deduper.isDuplicate(e.id, e.event, payload, at))
                    continue;
                this.onEvent(e.id, e.event, payload);
            }
            catch { }
        }
    }
    /**
     * Stops the directory watcher and the polling timer; used on quit.
     * @returns Nothing.
     */
    stop() {
        if (this.watcher)
            this.watcher.close();
        if (this.timer)
            clearInterval(this.timer);
        this.watcher = null;
        this.timer = null;
    }
}
exports.EventsTailer = EventsTailer;
