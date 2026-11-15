import * as fs from 'fs';
import * as path from 'path';

export class EventsTailer {
  private offset = 0;
  private carry = '';
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;

  /**
   * Tails `events.jsonl` in the conductor data dir, dispatching each appended hook event.
   * @param dir Events directory (default ~/.local/share/devin-conductor).
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
   * JSON line and dispatches valid `{id, event}` records to the callback.
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
        if (e && typeof e.id === 'string' && typeof e.event === 'string') this.onEvent(e.id, e.event, payload);
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
