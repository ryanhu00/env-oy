import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import type { IMarker } from '@xterm/headless';

export type SessionStatus = 'working' | 'waiting' | 'needs-permission' | 'exited';

const PROMPT_TURN_LIMIT = 200;

const PROMPT_TEXT_LIMIT = 500;

interface PromptTurn {
  marker: IMarker;
  text: string;
}

export type NotificationType = 'stop' | 'permission' | 'exit';

export interface Notification {
  type: NotificationType;
  ts: number;
}

export interface SessionOptions {
  extraArgs?: string[];
  command?: readonly string[];
  status?: Exclude<SessionStatus, 'exited'>;
  unread?: Notification[];
  markedDone?: boolean;
  onExit?: (pid: number) => void;
}

export class Session {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly tag: string;
  readonly term: Terminal;
  devinSessionId: string | null;
  memoryBytes: number | null = null;
  status: SessionStatus = 'waiting';
  unread: Notification[] = [];
  markedDone = false;
  suppressNotifications = false;
  exited = false;
  scrollOffset = 0;
  private readonly proc: pty.IPty;
  private pendingPromptMarker: IMarker | null = null;
  private lastPromptMarker: IMarker | null = null;
  private readonly turns: PromptTurn[] = [];

  /**
   * Spawns the session command (DEVIN_CONDUCTOR_CMD, default `devin`) in a fresh PTY and
   * mirrors its output into a headless terminal used for rendering.
   * @param id Unique conductor id exported to the child as DEVIN_CONDUCTOR_ID.
   * @param name Display name shown in the sidebar.
   * @param cwd Directory the PTY is spawned in.
   * @param tag Ordered ACTIVE group assigned before the PTY starts.
   * @param devinSessionId Real Devin session id when resuming/adopting, otherwise null until discovery.
   * @param cols Initial width of the PTY and mirror terminal.
   * @param rows Initial height of the PTY and mirror terminal.
   * @param eventsDir Directory exported as DEVIN_CONDUCTOR_EVENTS_DIR for hook scripts.
   * @param onOutput Invoked after PTY output is parsed into the mirror terminal; the caller
   *   may skip redraws when this session is not visible.
   * @param onUpdate Invoked when the process exits, to always schedule a redraw (sidebar changes).
   * @param onNotify Invoked only when notify() actually pushes an unread entry (user detached).
   * @param options Optional argv and restored status/unread state applied without notification side effects.
   */
  constructor(id: string, name: string, cwd: string, tag: string, devinSessionId: string | null, cols: number, rows: number, eventsDir: string, onOutput: () => void, onUpdate: () => void, private readonly onNotify: (type: NotificationType) => void, options: SessionOptions = {}) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.tag = tag;
    this.devinSessionId = devinSessionId;
    this.status = options.status ?? 'waiting';
    this.unread = options.unread?.map((entry) => ({ ...entry })) ?? [];
    this.markedDone = options.markedDone ?? false;
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const command = options.command;
    if (command && command.length === 0) throw new Error('Session command must include an executable');
    this.proc = pty.spawn(command?.[0] ?? (process.env.DEVIN_CONDUCTOR_CMD || 'devin'), command ? [...command.slice(1)] : options.extraArgs ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, DEVIN_CONDUCTOR_ID: id, DEVIN_CONDUCTOR_EVENTS_DIR: eventsDir } as { [key: string]: string },
    });
    this.proc.onData((d) => this.term.write(d, onOutput));
    this.proc.onExit(() => {
      this.exited = true;
      this.status = 'exited';
      this.memoryBytes = null;
      this.notify('exit');
      options.onExit?.(this.proc.pid);
      onUpdate();
    });
  }

  /**
   * OS pid of the spawned child; used to exclude owned processes from external discovery.
   * @returns The PTY child's pid.
   */
  get pid(): number {
    return this.proc.pid;
  }

  /**
   * Records an unread notification for the sidebar badge, collapsing consecutive duplicates
   * of the same type and skipping entirely while the user is attached to this session;
   * fires the onNotify callback (desktop banner + bell) only when an entry is pushed.
   * @param type Notification kind derived from hook events or PTY exit.
   * @returns Nothing.
   */
  notify(type: NotificationType): void {
    if (this.suppressNotifications) return;
    const last = this.unread[this.unread.length - 1];
    if (!last || last.type !== type) {
      this.unread.push({ type, ts: Date.now() });
      this.onNotify(type);
    }
  }

  /**
   * Tracks prompt markers, resolves permission interaction, and forwards input without inferring prompts.
   * @param data Raw utf8 input forwarded to the child.
   * @param bracketedPaste Whether data is paste insertion rather than submission.
   * @returns Nothing.
   */
  input(data: string, bracketedPaste = false): void {
    if (this.exited || data.length === 0) return;
    this.scrollOffset = 0;
    if (this.pendingPromptMarker?.isDisposed || (this.pendingPromptMarker && this.pendingPromptMarker.line < 0)) this.pendingPromptMarker = null;
    if (!this.pendingPromptMarker) this.pendingPromptMarker = this.term.registerMarker(0) ?? null;
    if (!bracketedPaste && data.includes('\r')) {
      const submittedMarker = this.pendingPromptMarker ?? this.term.registerMarker(0) ?? null;
      const previousMarker = this.lastPromptMarker;
      this.pendingPromptMarker = null;
      this.lastPromptMarker = submittedMarker;
      if (previousMarker && previousMarker !== submittedMarker && !previousMarker.isDisposed) previousMarker.dispose();
    }
    if (this.status === 'needs-permission') this.status = 'working';
    this.proc.write(data);
  }

  /**
   * Jumps the viewport so the last submitted prompt starts at the pane top.
   * @returns True when a live marker was applied; false when unavailable.
   */
  jumpToLastPrompt(): boolean {
    const marker = this.lastPromptMarker;
    if (!marker || marker.isDisposed || marker.line < 0) {
      this.lastPromptMarker = null;
      return false;
    }
    const baseY = this.term.buffer.active.baseY;
    this.scrollOffset = Math.max(0, Math.min(baseY, baseY - marker.line));
    return true;
  }

  noteSubmittedPrompt(text: string): void {
    const normalized = text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_TEXT_LIMIT);
    if (!normalized) return;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.turns.push({ marker, text: normalized });
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const dead = this.turns[i].marker;
      if (dead.isDisposed || dead.line < 0) this.turns.splice(i, 1);
    }
    while (this.turns.length > PROMPT_TURN_LIMIT) {
      const oldest = this.turns.shift();
      if (oldest && !oldest.marker.isDisposed) oldest.marker.dispose();
    }
  }

  promptForOffset(offset: number): string | null {
    const topLine = this.term.buffer.active.baseY - offset;
    let text: string | null = null;
    for (const turn of this.turns) {
      if (turn.marker.isDisposed || turn.marker.line < 0) continue;
      if (turn.marker.line > topLine) break;
      text = turn.text;
    }
    return text;
  }

  /**
   * Resizes both the PTY and the mirror terminal to the current right-pane dimensions.
   * @param cols New width in columns.
   * @param rows New height in rows.
   * @returns Nothing.
   */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    if (!this.exited) this.proc.resize(cols, rows);
  }

  /**
   * Disposes prompt markers and terminates the PTY when still running.
   * @returns Nothing.
   */
  kill(): void {
    const pendingMarker = this.pendingPromptMarker;
    const lastMarker = this.lastPromptMarker;
    this.pendingPromptMarker = null;
    this.lastPromptMarker = null;
    if (pendingMarker && !pendingMarker.isDisposed) pendingMarker.dispose();
    if (lastMarker && lastMarker !== pendingMarker && !lastMarker.isDisposed) lastMarker.dispose();
    for (const turn of this.turns.splice(0)) if (!turn.marker.isDisposed) turn.marker.dispose();
    this.memoryBytes = null;
    if (this.exited) return;
    this.exited = true;
    this.proc.kill();
  }
}
