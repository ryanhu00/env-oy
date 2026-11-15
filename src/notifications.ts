import * as fs from 'fs';
import * as path from 'path';

/** Identical hook events for the same session closer together than this are one event. */
export const EVENT_DEDUPE_WINDOW_MS = 1000;

/**
 * Collapses duplicate hook deliveries. One CLI event can run the Envoy hook more than once
 * (for example Devin also reads `~/.claude/settings.json`), so identical events for the same
 * session within a short window are treated as a single event.
 */
export class EventDeduper {
  private readonly seen = new Map<string, number>();

  /**
   * @param windowMs Maximum gap between two identical events that still counts as a duplicate.
   */
  constructor(private readonly windowMs = EVENT_DEDUPE_WINDOW_MS) {}

  /**
   * Records an event and reports whether it duplicates one seen within the window. A
   * duplicate does not extend the window, so a steady stream of events is never swallowed.
   * @param id Envoy session id the hook ran under.
   * @param event Hook event name.
   * @param payload Hook stdin payload, when it was valid JSON.
   * @param at Event time in milliseconds (the hook's own `ts`, or arrival time).
   * @returns True when the event should be dropped.
   */
  isDuplicate(id: string, event: string, payload: Record<string, unknown> | undefined, at: number): boolean {
    const key = `${id}\u0000${event}\u0000${JSON.stringify(payload ?? null)}`;
    const last = this.seen.get(key);
    if (last !== undefined && Math.abs(at - last) <= this.windowMs) return true;
    this.seen.set(key, at);
    if (this.seen.size > 64) {
      for (const [k, t] of this.seen) if (at - t > this.windowMs * 5) this.seen.delete(k);
    }
    return false;
  }
}

export class EventsTailer {
  private offset = 0;
  private carry = '';
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly deduper = new EventDeduper();

  /**
   * Tails `events.jsonl` in the conductor data dir, dispatching each appended hook event.
   * @param dir Events directory (default ~/.local/share/envoy).
   * @param onEvent Callback receiving the session id and hook event name per line.
   */
  constructor(private readonly dir: string, private readonly onEvent: (id: string, event: string, payload?: Record<string, unknown>) => void) {
    this.file = path.join(dir, 'events.jsonl');
  }

  /**
   * Creates the dir/file if missing, records the current size so pre-existing events are
   * skipped, then starts fs.watch plus a 500ms polling fallback.
   * @returns Nothing.
   */
  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
    this.offset = fs.statSync(this.file).size;
    try {
      this.watcher = fs.watch(this.dir, () => this.drain());
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => this.drain(), 500);
  }

  /**
   * Reads bytes appended since the last offset, buffers partial lines, parses each complete
   * JSON line and dispatches valid `{id, event}` records to the callback, dropping duplicate deliveries.
   * @returns Nothing.
   */
  private drain(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return;
    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const chunks = (this.carry + buf.toString('utf8')).split('\n');
    this.carry = chunks.pop() ?? '';
    for (const line of chunks) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const payload = e && typeof e.payload === 'object' && e.payload !== null && !Array.isArray(e.payload) ? (e.payload as Record<string, unknown>) : undefined;
        if (!e || typeof e.id !== 'string' || typeof e.event !== 'string') continue;
        const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
        if (this.deduper.isDuplicate(e.id, e.event, payload, at)) continue;
        this.onEvent(e.id, e.event, payload);
      } catch {}
    }
  }

  /**
   * Stops the directory watcher and the polling timer; used on quit.
   * @returns Nothing.
   */
  stop(): void {
    if (this.watcher) this.watcher.close();
    if (this.timer) clearInterval(this.timer);
    this.watcher = null;
    this.timer = null;
  }
}
