import * as path from 'path';
import type { IBufferCell, Terminal } from '@xterm/headless';
import { SessionManager } from '../sessionManager';
import { InputHandler } from '../input';
import { ACCENT, BG, BG_BAR, BG_SELECT, BG_UNREAD, BOLD, CURSOR, DIM, ERROR, EXTERNAL, FG, FG_BRIGHT, OK, RECENT, RESET, RULE, SEPARATOR, WARN, backgroundRgb, currentAppearance } from './theme';
import { KoiPond, paintPond } from './koi';

/** Koi are skipped below this size, where they would cover the whole screen. */
const KOI_MIN_COLS = 60;
const KOI_MIN_ROWS = 12;
/** Pond animation cadence (~10 fps keeps CPU and terminal output low). */
const KOI_FRAME_MS = 100;

export const SIDEBAR_W = 34;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Truncates (with ellipsis) or pads plain text to an exact visible width; used to keep
 * sidebar and status-bar lines aligned to fixed column budgets.
 * @param s Plain text without escape sequences.
 * @param w Target visible width.
 * @returns String of exactly `w` visible columns.
 */
function fit(s: string, w: number): string {
  if (w <= 0) return '';
  if (s.length > w) return w <= 1 ? s.slice(0, w) : s.slice(0, w - 1) + '…';
  return s + ' '.repeat(w - s.length);
}

/**
 * Formats a byte sample as compact binary MB/GB text for sidebar and status displays.
 * @param bytes Byte count, or null before a successful sample.
 * @returns Em dash for null, rounded MB below 1 GiB, otherwise one-decimal GB.
 */
export function formatMemory(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null || !Number.isFinite(ts) || ts < 0) return '—';
  const elapsed = Math.max(0, Math.floor((now - ts) / 1000));
  if (elapsed < 60) return 'just now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
}

/**
 * Fits a styled status label and message into one fixed visible width.
 * @param label Leading mode label including its spacing.
 * @param message Remaining status text.
 * @param width Total visible width available.
 * @param labelStyle ANSI style for the label.
 * @param messageStyle ANSI style for the message.
 * @returns Styled status segment occupying exactly the requested non-negative width.
 */
function statusSegment(label: string, message: string, width: number, labelStyle = ACCENT, messageStyle = FG): string {
  if (width <= 0) return '';
  if (label.length >= width) return labelStyle + fit(label, width);
  return labelStyle + label + messageStyle + fit(message, width - label.length);
}

/**
 * Word-wraps plain text into lines, breaking on spaces where possible and hard-breaking
 * words longer than the line width; used by sidebarLines to expand full entry names
 * (every ACTIVE entry plus the selected entry of other sections). Output is capped at
 * `maxLines`, with any overflow refolded into the last line so fit() can end it with
 * an ellipsis.
 * @param s Plain text without escape sequences.
 * @param firstW Width of the first line in columns (may be reduced by a badge).
 * @param restW Width of continuation lines in columns.
 * @param maxLines Maximum number of lines to emit.
 * @returns 1..maxLines lines, each within its width (unpadded).
 */
function wrap(s: string, firstW: number, restW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let w = Math.max(1, firstW);
  for (let word of s.split(' ')) {
    while (word.length > 0) {
      if (cur.length === 0) {
        cur = word.slice(0, w);
        word = word.slice(w);
      } else if (cur.length + 1 + word.length <= w) {
        cur = cur + ' ' + word;
        word = '';
      }
      if (word.length > 0) {
        lines.push(cur);
        cur = '';
        w = Math.max(1, restW);
      }
    }
  }
  if (cur.length > 0 || lines.length === 0) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(kept[maxLines - 1] + ' ' + lines.slice(maxLines).join(' '), w);
    return kept;
  }
  return lines;
}

/**
 * Abbreviates a working directory for the sidebar: ~-prefix for home paths, falling back
 * to the basename (then a truncated basename) when the budget is too small.
 * @param cwd Absolute working directory.
 * @param max Width budget in columns.
 * @param home User home directory for ~ abbreviation.
 * @returns Short directory label within the budget.
 */
function shortDir(cwd: string, max: number, home: string): string {
  if (max <= 0) return '';
  const abbr = cwd === home ? '~' : cwd.startsWith(home + path.sep) ? '~' + cwd.slice(home.length) : cwd;
  if (abbr.length <= max) return abbr;
  const base = path.basename(cwd);
  if (base.length <= max) return base;
  return max === 1 ? '…' : base.slice(0, max - 1) + '…';
}

/**
 * Computes the SGR escape sequence for a buffer cell's attributes and colors, covering
 * bold/dim/italic/underline/blink/inverse/invisible/strikethrough plus palette and RGB
 * foreground/background; applied by paneRow as an override on top of the Nord baseline
 * when re-emitting a headless terminal's screen.
 * @param c Buffer cell being rendered.
 * @returns SGR escape string, or '' for a fully default cell (baseline colors apply).
 */
function cellSgr(c: IBufferCell): string {
  const p: string[] = [];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (c.isInverse()) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  if (c.isFgRGB()) {
    const v = c.getFgColor();
    p.push(`38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
  } else if (c.isFgPalette()) {
    p.push(`38;5;${c.getFgColor()}`);
  }
  if (c.isBgRGB()) {
    const v = c.getBgColor();
    p.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
  } else if (c.isBgPalette()) {
    p.push(`48;5;${c.getBgColor()}`);
  }
  return p.length ? `\x1b[${p.join(';')}m` : '';
}

/**
 * Renders one visible row of a headless terminal's screen as an ANSI string, offset
 * `scrollOffset` lines up from the bottom of scrollback, starting from a Nord baseline
 * (nord0 background, nord4 foreground) so default-colored cells never show the host
 * terminal's theme, emitting SGR changes only when attributes differ from the previous
 * cell (each change re-applies the baseline before the cell's explicit overrides) and
 * handling wide characters (including a wide char clipped at the pane edge).
 * @param term Headless terminal mirroring a session PTY.
 * @param y Row index within the visible screen.
 * @param width Right-pane width; cells beyond it are clipped.
 * @param scrollOffset Lines above the live bottom (0 = live view).
 * @returns ANSI string for the row (no trailing clear).
 */
function paneRow(term: Terminal, y: number, width: number, scrollOffset: number): string {
  const buf = term.buffer.active;
  const line = buf.getLine(buf.baseY - scrollOffset + y);
  if (!line) return '';
  const cell = buf.getNullCell();
  let out = '\x1b[0m' + BG + FG;
  let lastSgr = '';
  let x = 0;
  const limit = Math.min(width, line.length);
  while (x < limit) {
    const c = line.getCell(x, cell);
    if (!c) break;
    const w = c.getWidth();
    if (w === 0) {
      x++;
      continue;
    }
    const sgr = cellSgr(c);
    if (sgr !== lastSgr) {
      out += '\x1b[0m' + BG + FG + sgr;
      lastSgr = sgr;
    }
    if (w === 2 && x === width - 1) {
      out += ' ';
      x++;
      continue;
    }
    out += c.getChars() || ' ';
    x += w;
  }
  return out;
}

/**
 * Produces the welcome/help screen lines shown in the right pane when no owned session
 * is selected (empty list or an external/recent row under the cursor).
 * @param width Right-pane width used to clip each line.
 * @returns Array of ANSI strings (shorter than pane height; caller pads).
 */
function helpLines(width: number): string[] {
  const raw: [string, string][][] = [
    [],
    [[BOLD + ACCENT, '  Envoy']],
    [[FG, '  Run and switch between multiple agent CLI sessions (Devin, Claude, Codex).']],
    [],
    [[ACCENT, '  n          '], [FG, 'create a new session (←/→ picks the CLI), then its tag']],
    [[ACCENT, '  j / k      '], [FG, 'move selection down / up (across all sections)']],
    [[ACCENT, '  gg / G     '], [FG, 'jump to top / bottom']],
    [[ACCENT, '  Ctrl-u/d   '], [FG, 'half page up / down']],
    [[ACCENT, '  Enter      '], [FG, 'ACTIVE attach · TERMINAL adopt/tag · RECENT resume/tag']],
    [[ACCENT, '  m          '], [FG, 'reorder the selected ACTIVE session within its tag']],
    [[ACCENT, '  r          '], [FG, 'set a persistent Envoy-only alias on any selected row']],
    [[ACCENT, '  H          '], [FG, 'toggle RECENT rows for this Envoy run']],
    [[ACCENT, '  R          '], [FG, 'refresh Envoy and reconnect all idle ACTIVE sessions']],
    [[ACCENT, '  d          '], [FG, 'flag selected ACTIVE session as DONE — NEEDS YOU']],
    [[ACCENT, '  x          '], [FG, 'kill selected session (ACTIVE only)']],
    [[ACCENT, '  ,          '], [FG, 'settings (theme, default dir/CLI, CLIs, RECENT rows…)']],
    [[ACCENT, '  q          '], [FG, 'quit']],
    [],
    [[DIM, '  Attached NORMAL (default): j/k or Ctrl-d/u scroll half page ·']],
    [[DIM, '  gg/G top/bottom · p last prompt · i/a INSERT · Ctrl-q sidebar.']],
    [[DIM, '  Attached INSERT: every key (incl. Esc) goes to the session ·']],
    [[DIM, '  Ctrl-q back to NORMAL. Sessions created via n start in INSERT.']],
    [],
    [[DIM, '  Sections: ACTIVE sessions are grouped by ordered tags · RECENT']],
    [[DIM, '  sessions from the last 24h, resumable via each CLI · TERMINAL']],
    [[DIM, '  REPLs running in other windows (⇄, read-only until adopted).']],
    [[DIM, '  ACTIVE/TERMINAL memory is main-process RSS, refreshed every 5s.']],
    [[DIM, '  The bottom AGENTS total excludes child processes and Envoy itself.']],
    [[DIM, '  Creating, resuming and adopting always asks for a required tag.']],
    [[DIM, '  Hiding RECENT is run-local; Envoy restart/refresh shows it again.']],
    [[DIM, '  MOVE: j/k one slot · gg/G first/last · Enter save · Esc cancel.']],
    [[DIM, '  Saved order uses real session ids and survives Envoy restarts.']],
    [[DIM, '  RENAME is Envoy-only, persists by real id, and blank clears it.']],
    [[DIM, '  REFRESH always confirms, requires every live ACTIVE session to be']],
    [[DIM, '  idle with a session ID, and loses drafts plus local scrollback.']],
    [],
    [[DIM, '  Adopting a TERMINAL session closes it in its own window']],
    [[DIM, '  (SIGTERM), then resumes it here with exclusive ownership.']],
    [],
    [[FG, '  Status:  '], [BOLD + ACCENT, '⠋ '], [FG, 'WORKING   '], [DIM, '○ '], [FG, 'IDLE']],
    [[FG, '           '], [BOLD + WARN, '◆ '], [FG, 'DONE — NEEDS YOU   '], [BOLD + ERROR, '! '], [FG, 'PERMISSION NEEDED']],
    [[FG, '           '], [DIM, '× '], [FG, 'EXITED   '], [DIM, '× '], [FG, 'EXITED — NEEDS YOU']],
    [[DIM, '  WORKING starts only after the CLI submits a prompt, not on keyboard input.']],
    [],
    [[DIM, '  Unread badges (●N) and highlighted rows appear when a session']],
    [[DIM, '  finishes a turn, requests permission, or exits while you are away.']],
    [],
    [[DIM, '  New-session dir defaults to "default_cwd" from']],
    [[DIM, '  ~/.config/envoy/config.json (fallback: launch dir).']],
    [[DIM, '  Config keys: "enabled_adapters", "default_adapter",']],
    [[DIM, '  "adapter_commands", "recent_limit" (CLIs on PATH are enabled']],
    [[DIM, '  by default; RECENT slots are shared fairly across CLIs).']],
  ];
  return raw.map((segs) => {
    let out = '';
    let left = width;
    for (const [sgr, text] of segs) {
      if (left <= 0) break;
      out += sgr + text.slice(0, left);
      left -= text.length;
    }
    return out + RESET;
  });
}

export class Renderer {
  private scroll = 0;
  private renderTimer: NodeJS.Timeout | null = null;
  private animationTimer: NodeJS.Timeout | null = null;
  private freshnessTimer: NodeJS.Timeout | null = null;
  private koi: KoiPond | null = null;
  private koiCount: number | undefined;
  private koiTimer: NodeJS.Timeout | null = null;
  private koiLastAt = 0;
  private spinnerFrame = 0;
  private lastFrameAt = 0;
  private prevRows: string[] = [];
  private prevCols = 0;
  private prevTermRows = 0;
  private stopped = false;

  /**
   * Full-screen ANSI renderer drawing the sidebar, separator, right pane and status bar.
   * @param manager Source of sessions, selection and attachment state.
   * @param input Source of the current mode plus form/confirm state.
   * @param home User home directory for ~ abbreviation in the sidebar.
   */
  constructor(private readonly manager: SessionManager, private readonly input: InputHandler, private readonly home: string) {}

  /**
   * Turns the swimming-koi background on or off (off by default until the app enables it).
   * @param enabled True to animate koi behind blank cells.
   * @param repaint False at startup, before the first frame is allowed to draw.
   * @returns Nothing; repaints everything unless `repaint` is false.
   */
  setKoi(enabled: boolean, repaint = true): void {
    if (enabled && !this.koi) {
      this.koi = new KoiPond({ count: this.koiCount });
      this.koiLastAt = Date.now();
    } else if (!enabled) {
      this.koi = null;
      if (this.koiTimer) clearTimeout(this.koiTimer);
      this.koiTimer = null;
    }
    if (!repaint) return;
    this.invalidate();
    this.schedule();
  }

  /**
   * Fixes how many koi swim, or restores the automatic count.
   * @param count Whole number of fish, or undefined for automatic.
   * @param repaint False at startup, before the first frame is allowed to draw.
   * @returns Nothing.
   */
  setKoiCount(count: number | undefined, repaint = true): void {
    this.koiCount = count;
    this.koi?.setCount(count);
    if (repaint) this.schedule();
  }

  /**
   * Schedules a line-diff redraw at up to ~30fps and starts or settles working animation.
   * @returns Nothing; state and PTY updates call this to coalesce output.
   */
  schedule(): void {
    if (this.stopped) return;
    if (!this.freshnessTimer) {
      // unref'd so the relative PROMPT label repaints on an idle app without holding the event loop open
      this.freshnessTimer = setInterval(() => this.schedule(), 15000);
      this.freshnessTimer.unref();
    }
    if (this.renderTimer) return;
    const wait = Math.max(0, 33 - (Date.now() - this.lastFrameAt));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.stopped) return;
      this.lastFrameAt = Date.now();
      process.stdout.write(this.frame());
      if (this.koi && !this.koiTimer) {
        this.koiTimer = setTimeout(() => {
          this.koiTimer = null;
          this.schedule();
        }, KOI_FRAME_MS);
        this.koiTimer.unref();
      }
      const working = this.manager.sessions.some((session) => session.status === 'working');
      if (!working) {
        if (this.animationTimer) clearTimeout(this.animationTimer);
        this.animationTimer = null;
      } else if (!this.animationTimer) {
        this.animationTimer = setTimeout(() => {
          this.animationTimer = null;
          if (this.stopped || !this.manager.sessions.some((session) => session.status === 'working')) return;
          this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
          this.schedule();
        }, 120);
      }
    }, wait);
  }

  /**
   * Clears pending render/animation work and permanently prevents later terminal writes.
   * @returns Nothing; shutdown paths call this before restoring the host terminal.
   */
  stop(): void {
    this.stopped = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.animationTimer) clearTimeout(this.animationTimer);
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    if (this.koiTimer) clearTimeout(this.koiTimer);
    this.koiTimer = null;
    this.renderTimer = null;
    this.animationTimer = null;
    this.freshnessTimer = null;
  }

  /**
   * Drops the cached previous-frame rows so the next frame repaints every row; called
   * when the host terminal's contents can no longer be trusted (e.g. on resize).
   * @returns Nothing.
   */
  invalidate(): void {
    this.prevRows = [];
  }

  /**
   * Builds the next frame and emits only rows that differ from the previous frame: each
   * screen row (sidebar + separator + right pane content — session screen at the session's
   * scroll offset, form or help — ending in a clear-to-EOL with the nord0 background
   * active) plus the bottom status/hint bar are rendered as per-row ANSI strings, diffed
   * against the cached previous rows and prefixed with an absolute cursor move when
   * changed; every row is emitted when the dimensions changed, on the first frame or
   * after invalidate(). Cursor hide/placement (DECTCEM, shown only when attached in
   * insert mode at the live bottom) is re-emitted every frame after the row writes.
   * @returns ANSI string updating the host terminal to the new frame.
   */
  private frame(): string {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const paneW = Math.max(2, cols - SIDEBAR_W - 1);
    const paneH = Math.max(2, rows - 1);
    const side = this.sidebarLines(paneH);
    const att = this.manager.attachedSession;
    const shown = this.input.mode === 'attached' && att ? att : this.manager.selectedSession;
    let paneText: string[] | null = null;
    if (this.input.mode === 'form' && this.input.form) paneText = this.formLines(paneW);
    else if (this.input.mode === 'rename' && this.input.rename) paneText = this.renameLines(paneW);
    else if (this.input.mode === 'tag-picker' && this.input.tagPicker) paneText = this.tagPickerLines(paneW);
    else if (this.input.mode === 'tag-name' && this.input.tagName) paneText = this.tagNameLines(paneW);
    else if (this.input.mode === 'tag-position' && this.input.tagPosition) paneText = this.tagPositionLines(paneW);
    else if (this.input.mode === 'settings' && this.input.settings && this.input.settingsBackend) paneText = this.settingsLines(paneW);
    else if (!shown) paneText = helpLines(paneW);
    const offset = shown ? Math.max(0, Math.min(shown.scrollOffset, shown.term.buffer.active.baseY)) : 0;
    const pinnedPrompt = this.input.mode === 'attached' && att && !paneText && offset > 0 ? att.promptForOffset(offset) : null;
    const header = pinnedPrompt ? BG_BAR + ACCENT + '▌ ' + FG_BRIGHT + fit(pinnedPrompt, paneW - 2) : null;
    const newRows: string[] = [];
    const pond = this.koi && cols >= KOI_MIN_COLS && paneH >= KOI_MIN_ROWS ? this.koi : null;
    if (pond) {
      // one pond pixel = 1 column x half a row (half-block glyphs), so pixels are small and square
      const now = Date.now();
      pond.setAppearance(currentAppearance());
      pond.resize(cols, paneH * 2);
      pond.step(Math.min(0.25, Math.max(0, (now - this.koiLastAt) / 1000)));
      this.koiLastAt = now;
    }
    const water = backgroundRgb();
    for (let y = 0; y < paneH; y++) {
      // the pinned prompt takes screen row 0, pushing the scrolled view down one row
      const pane = paneText ? paneText[y] ?? '' : header && y === 0 ? header : paneRow(shown!.term, header ? y - 1 : y, paneW, offset);
      const row = side[y] + RESET + BG + SEPARATOR + '│' + pane + RESET + BG + '\x1b[K';
      newRows.push(pond ? paintPond(row, y, pond, water, cols) : row);
    }
    let bar: string;
    const sel = this.manager.entries[this.manager.selected];
    const recentHiddenLabel = ` RECENT HIDDEN (${this.manager.discovery.recents.length})`;
    const totalMemory = formatMemory(this.manager.discovery.totalMemoryBytes);
    const lastPrompt = formatAgo(this.manager.lastPromptAt);
    // with several CLIs enabled, break the total down per CLI (only CLIs with live REPLs);
    // the breakdown is dropped when it would crowd out the mode hints
    const perCli = this.manager.adapters.length > 1
      ? this.manager.adapters
        .filter((adapter) => (this.manager.discovery.memoryByAdapter.get(adapter.id) ?? 0) > 0)
        .map((adapter) => `${adapter.badge} ${formatMemory(this.manager.discovery.memoryByAdapter.get(adapter.id)!)}`)
      : [];
    const baseSuffix = `PROMPT ${lastPrompt} · AGENTS ${totalMemory}`;
    const breakdown = perCli.length > 0 && baseSuffix.length + 3 + perCli.join(' · ').length <= cols * 0.5 ? ` (${perCli.join(' · ')})` : '';
    const suffixPlain = baseSuffix + breakdown;
    const suffixWidth = Math.min(cols, suffixPlain.length);
    const barWidth = Math.max(0, cols - suffixWidth);
    const suffix = suffixWidth === suffixPlain.length
      ? DIM + 'PROMPT ' + ACCENT + lastPrompt + DIM + ' · AGENTS ' + ACCENT + totalMemory + (breakdown ? DIM + breakdown : '')
      : DIM + fit(suffixPlain, suffixWidth);
    if (this.input.mode === 'confirm' && this.input.confirm) bar = WARN + fit(` ${this.input.confirm.question} [y/n]`, barWidth);
    else if (this.input.mode === 'move' && this.manager.moveState)
      bar = statusSegment(' MOVE', ` · #${this.manager.moveState.tag} · j/k reorder · gg/G first/last · Enter save · Esc cancel`, barWidth);
    else if (this.input.mode === 'attached' && att && this.input.attachedMode === 'insert')
      bar = statusSegment(' INSERT', ` · ${this.manager.displayName(att)} · ${att.status} · Ctrl-q normal`, barWidth);
    else if (this.input.mode === 'attached' && att)
      bar = this.input.notice
        ? ERROR + fit(` ${this.input.notice}`, barWidth)
        : statusSegment(' NORMAL', `${offset > 0 ? ` · ↑${offset}` : ''} · ${this.manager.displayName(att)} · ${att.status} · j/k scroll · gg/G top/bottom · p last prompt · i insert · Ctrl-q sidebar`, barWidth);
    else if (this.input.mode === 'form') bar = statusSegment(' NEW SESSION', ` · Enter next/tag · Tab switch field${this.manager.adapters.length > 1 ? ' · ←/→ CLI' : ''} · Esc cancel`, barWidth);
    else if (this.input.mode === 'settings')
      bar = statusSegment(' SETTINGS', this.input.settings?.editing ? ' · type · Enter save · Ctrl-u clear · Esc cancel' : ' · j/k move · ←/→ or Enter change · Enter edits text · Esc close', barWidth);
    else if (this.input.mode === 'rename') bar = statusSegment(' RENAME', ' · type or paste · Enter save (blank clears) · Esc cancel', barWidth);
    else if (this.input.mode === 'tag-picker') bar = statusSegment(' TAG', ' · j/k or arrows move · gg/G top/bottom · Enter select · n new · Esc cancel action', barWidth);
    else if (this.input.mode === 'tag-name') bar = statusSegment(' TAG NAME', ' · type or paste · Enter choose position · Esc tags', barWidth);
    else if (this.input.mode === 'tag-position') bar = statusSegment(' TAG POSITION', ' · j/k or arrows move · gg/G top/bottom · Enter insert/select · Esc name', barWidth);
    else if (this.input.notice) bar = ERROR + fit(` ${this.input.notice}`, barWidth);
    else if (!this.manager.recentVisible) bar = statusSegment(recentHiddenLabel, ' · H show · j/k move · Enter select · r rename · R refresh · q quit', barWidth, BOLD + WARN);
    else if (sel?.kind === 'external') bar = statusSegment(' TERMINAL', ' · Enter adopt · r rename · H hide recent · R refresh · j/k move · q quit', barWidth);
    else if (sel?.kind === 'recent') bar = statusSegment(' RECENT', ' · Enter resume · r rename · H hide recent · R refresh · j/k move · q quit', barWidth);
    else bar = statusSegment(' SIDEBAR', ' · j/k move · Enter attach · r rename · H hide recent · R refresh · m move · n new · d flag · x kill · , settings · q quit', barWidth);
    newRows.push(BG_BAR + bar + suffix + RESET);
    const full = cols !== this.prevCols || rows !== this.prevTermRows || this.prevRows.length === 0;
    let out = '\x1b[?25l';
    for (let y = 0; y < paneH; y++) {
      if (full || newRows[y] !== this.prevRows[y]) out += `\x1b[${y + 1};1H` + newRows[y];
    }
    if (full || newRows[paneH] !== this.prevRows[paneH]) out += `\x1b[${rows};1H` + newRows[paneH];
    this.prevRows = newRows;
    this.prevCols = cols;
    this.prevTermRows = rows;
    if (this.input.mode === 'attached' && att && !att.exited && this.input.attachedMode === 'insert' && offset === 0) {
      const b = att.term.buffer.active;
      if (b.cursorY >= 0 && b.cursorY < paneH) out += `\x1b[${b.cursorY + 1};${SIDEBAR_W + 2 + Math.min(b.cursorX, paneW - 1)}H\x1b[?25h`;
    }
    return out;
  }

  /**
   * Builds the sidebar as exactly `height` ANSI strings of SIDEBAR_W visible columns:
   * a title, a rule, then section headers (ACTIVE/RECENT/TERMINAL, only when non-empty),
   * visible ordered tag subheaders before non-empty ACTIVE groups, and a line block per
   * selectable entry. ACTIVE names always wrap over up to 4 rows; selected RECENT/TERMINAL
   * names wrap identically. ACTIVE and TERMINAL add memory plus status detail rows while
   * RECENT remains unchanged; scrolling keeps each variable-height selected block visible.
   * @param height Number of sidebar rows available (pane height).
   * @returns Array of `height` fixed-width ANSI strings.
   */
  private sidebarLines(height: number): string[] {
    const lines: string[] = [
      BG + BOLD + ACCENT + fit(' Envoy', SIDEBAR_W) + RESET,
      BG + RULE + '─'.repeat(SIDEBAR_W) + RESET,
    ];
    const entries = this.manager.entries;
    const body: string[] = [];
    let selStart = 0;
    let selLen = 3;
    let prevKind = '';
    let prevTag = '';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind !== prevKind) {
        prevKind = e.kind;
        const label = e.kind === 'active' ? 'ACTIVE' : e.kind === 'external' ? 'TERMINAL' : 'RECENT';
        body.push(BG + BOLD + DIM + fit(` ${label}`, SIDEBAR_W) + RESET);
      }
      if (e.kind === 'active' && e.session.tag !== prevTag) {
        prevTag = e.session.tag;
        body.push(BG + BOLD + ACCENT + fit(`  # ${e.session.tag}`, SIDEBAR_W) + RESET);
      }
      const selected = i === this.manager.selected;
      const unread = e.kind === 'active' && e.session.unread.length > 0;
      const flagged = e.kind === 'active' && e.session.markedDone;
      const bg = selected ? BG_SELECT : unread || flagged ? BG_UNREAD : BG;
      const text = selected ? FG_BRIGHT : FG;
      let marker = selected ? ACCENT + '›' : ' ';
      let icon: string;
      let name: string;
      let nameStyle = text;
      let badge = '';
      let badgeStyle = BOLD + ERROR;
      let details: string[];
      if (e.kind === 'active') {
        const s = e.session;
        if (this.input.mode === 'move' && this.manager.moveState?.session === s) marker = ACCENT + '↕';
        else if (s.id === this.manager.attachedId) marker = OK + '▶';
        let sprite: string;
        let label: string;
        let statusStyle: string;
        if (s.status === 'working') {
          sprite = SPINNER_FRAMES[this.spinnerFrame];
          label = 'WORKING';
          statusStyle = BOLD + ACCENT;
        } else if (s.status === 'waiting' && (unread || flagged)) {
          sprite = '◆';
          label = 'DONE — NEEDS YOU';
          statusStyle = BOLD + WARN;
        } else if (s.status === 'waiting') {
          sprite = '○';
          label = 'IDLE';
          statusStyle = DIM;
        } else if (s.status === 'needs-permission') {
          sprite = '!';
          label = 'PERMISSION NEEDED';
          statusStyle = BOLD + ERROR;
        } else {
          sprite = '×';
          label = unread || flagged ? 'EXITED — NEEDS YOU' : 'EXITED';
          statusStyle = DIM;
        }
        const statusText = `${sprite} ${label}`;
        const memory = formatMemory(s.memoryBytes);
        const cli = this.manager.badgeFor(s.adapterId) ? ` · ${this.manager.badgeFor(s.adapterId)}` : '';
        const dir = shortDir(s.cwd, SIDEBAR_W - 7 - memory.length - cli.length, this.home);
        icon = statusStyle + sprite;
        name = this.manager.displayName(s);
        if (unread || flagged) {
          nameStyle = BOLD + FG_BRIGHT;
          badge = unread ? `●${s.unread.length}` : '◆';
          if (!unread) badgeStyle = BOLD + WARN;
        } else if (s.status === 'exited') nameStyle = DIM;
        details = [
          DIM + fit(`    ${dir} · ${memory}${cli}`, SIDEBAR_W),
          DIM + '    ' + statusStyle + statusText + ' '.repeat(Math.max(0, SIDEBAR_W - 4 - statusText.length)),
        ];
      } else if (e.kind === 'external') {
        const memory = formatMemory(e.external.memoryBytes);
        const cli = this.manager.badgeFor(e.external.adapterId) ? ` · ${this.manager.badgeFor(e.external.adapterId)}` : '';
        icon = EXTERNAL + '⇄';
        name = this.manager.displayName(e);
        details = [
          DIM + fit(`    ${shortDir(e.external.cwd, SIDEBAR_W - 7 - memory.length - cli.length, this.home)} · ${memory}${cli}`, SIDEBAR_W),
          DIM + fit('    terminal', SIDEBAR_W),
        ];
      } else {
        const cli = this.manager.badgeFor(e.recent.adapterId) ? ` · ${this.manager.badgeFor(e.recent.adapterId)}` : '';
        icon = RECENT + '↺';
        name = this.manager.displayName(e);
        details = [DIM + fit(`    ${shortDir(e.recent.cwd, SIDEBAR_W - 7 - e.recent.lastAgo.length - cli.length, this.home)} · ${e.recent.lastAgo}${cli}`, SIDEBAR_W)];
      }
      const nameW = SIDEBAR_W - 4 - (badge ? badge.length + 1 : 0);
      const nameLines = selected || e.kind === 'active' ? wrap(name, nameW, SIDEBAR_W - 4, 4) : [name];
      if (selected) {
        selStart = body.length;
        selLen = nameLines.length + details.length + 1;
      }
      body.push(bg + marker + ' ' + icon + ' ' + nameStyle + fit(nameLines[0], nameW) + (badge ? ' ' + badgeStyle + badge : '') + RESET);
      for (const cont of nameLines.slice(1)) body.push(bg + '    ' + nameStyle + fit(cont, SIDEBAR_W - 4) + RESET);
      for (const detail of details) body.push(bg + detail + RESET);
      body.push(BG + ' '.repeat(SIDEBAR_W) + RESET);
    }
    const avail = Math.max(1, height - 2);
    if (selStart + selLen > this.scroll + avail) this.scroll = selStart + selLen - avail;
    if (selStart - 1 < this.scroll) this.scroll = Math.max(0, selStart - 1);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - avail)));
    lines.push(...body.slice(this.scroll, this.scroll + avail));
    while (lines.length < height) lines.push(BG + ' '.repeat(SIDEBAR_W) + RESET);
    return lines.slice(0, height);
  }

  /**
   * Renders envoy alias editing with stable target/original context and validation feedback.
   * @param width Right-pane width used to tail-clip the field and clip hints.
   * @returns ANSI rows for the rename pane.
   */
  private renameLines(width: number): string[] {
    const state = this.input.rename!;
    const budget = Math.max(4, width - 8);
    const shown = state.value.length > budget ? '…' + state.value.slice(-(budget - 1)) : state.value;
    return [
      '',
      '  ' + BOLD + ACCENT + 'Rename session' + RESET,
      '',
      '  ' + DIM + fit(`${state.section} · ${state.target.kind === 'active' ? state.target.session.cliSessionId ?? 'Session ID pending' : state.target.sessionId}`, Math.max(0, width - 2)) + RESET,
      '  ' + DIM + fit(`Original: ${state.original}`, Math.max(0, width - 2)) + RESET,
      '',
      '  ' + DIM + 'Envoy alias (maximum 120 characters):' + RESET,
      '  ' + ACCENT + '❯ ' + FG_BRIGHT + shown + CURSOR + ' ' + RESET,
      '',
      '  ' + DIM + fit('Blank saves no alias and shows the CLI title/session ID.', Math.max(0, width - 2)) + RESET,
      '',
      state.error ? '  ' + ERROR + state.error.slice(0, Math.max(0, width - 3)) + RESET : '',
    ];
  }

  /**
   * Renders the ordered existing-tag picker with Nord selection styling.
   * @param width Right-pane width used to clip list rows.
   * @returns ANSI rows for the tag picker pane.
   */
  private tagPickerLines(width: number): string[] {
    const selected = this.input.tagPicker!.selected;
    const lines = [
      '',
      '  ' + BOLD + ACCENT + 'Choose a session tag' + RESET,
      '',
      '  ' + DIM + 'Every ACTIVE session belongs to one ordered tag.' + RESET,
      '',
    ];
    for (let i = 0; i < this.manager.tagStore.tags.length; i++) {
      const active = i === selected;
      const text = `${i + 1}. ${this.manager.tagStore.tags[i]}`;
      lines.push((active ? BG_SELECT + ACCENT + '  › ' + FG_BRIGHT : '    ' + FG) + fit(text, Math.max(1, width - 4)) + RESET);
    }
    return lines;
  }

  /**
   * Renders custom tag-name text entry, cursor and validation feedback.
   * @param width Right-pane width used to tail-clip the value and error.
   * @returns ANSI rows for the tag-name pane.
   */
  private tagNameLines(width: number): string[] {
    const state = this.input.tagName!;
    const budget = Math.max(4, width - 8);
    const shown = state.value.length > budget ? '…' + state.value.slice(-(budget - 1)) : state.value;
    return [
      '',
      '  ' + BOLD + ACCENT + 'Create a tag' + RESET,
      '',
      '  ' + DIM + 'Name (1–30 characters, unique ignoring case):' + RESET,
      '  ' + ACCENT + '❯ ' + FG_BRIGHT + shown + CURSOR + ' ' + RESET,
      '',
      state.error ? '  ' + ERROR + state.error.slice(0, Math.max(0, width - 3)) + RESET : '',
    ];
  }

  /**
   * Renders every human-readable insertion slot around the current ordered tags.
   * @param width Right-pane width used to clip slot labels.
   * @returns ANSI rows for the tag-position pane.
   */
  private tagPositionLines(width: number): string[] {
    const state = this.input.tagPosition!;
    const tags = this.manager.tagStore.tags;
    const lines = [
      '',
      '  ' + BOLD + ACCENT + `Position #${state.name}` + RESET,
      '',
      '  ' + DIM + 'Choose where the new tag belongs:' + RESET,
      '',
    ];
    for (let i = 0; i <= tags.length; i++) {
      const label = i === 0 ? `before ${tags[0]}` : i === tags.length ? `after ${tags[tags.length - 1]}` : `between ${tags[i - 1]} and ${tags[i]}`;
      const active = i === state.selected;
      const text = `${i + 1}. ${label}`;
      lines.push((active ? BG_SELECT + ACCENT + '  › ' + FG_BRIGHT : '    ' + FG) + fit(text, Math.max(1, width - 4)) + RESET);
    }
    lines.push('', state.error ? '  ' + ERROR + state.error.slice(0, Math.max(0, width - 3)) + RESET : '');
    return lines;
  }

  /**
   * Renders the settings screen: one row per setting (label, value, dimmed note), the
   * highlighted row, an inline text editor for typed values, and the last result message.
   * @param width Right-pane width used to clip rows.
   * @returns ANSI rows for the settings pane.
   */
  private settingsLines(width: number): string[] {
    const state = this.input.settings!;
    const rows = this.input.settingsBackend!.rows();
    const labelW = Math.min(24, Math.max(10, rows.reduce((max, row) => Math.max(max, row.label.length), 0) + 2));
    const budget = Math.max(4, width - 8);
    const lines = ['', '  ' + BOLD + ACCENT + 'Settings' + RESET, '', '  ' + DIM + fit('Changes apply immediately and are saved to ~/.config/envoy/config.json.', Math.max(0, width - 2)) + RESET, ''];
    rows.forEach((row, i) => {
      const active = i === state.selected;
      const editing = active && state.editing ? state.editing : null;
      const valueText = editing ? (editing.value.length > budget ? '…' + editing.value.slice(-(budget - 1)) : editing.value) : row.value;
      const prefix = active ? BG_SELECT + ACCENT + '  › ' + FG_BRIGHT : '    ' + FG;
      const arrows = !editing && active && (row.kind === 'cycle' || row.kind === 'toggle' || row.kind === 'number') ? '◂ ▸ ' : '';
      const body = fit(row.label, labelW) + arrows + (editing ? '' : valueText);
      lines.push(prefix + fit(body, Math.max(1, width - 4)) + RESET);
      if (editing) lines.push('      ' + ACCENT + '❯ ' + FG_BRIGHT + valueText + CURSOR + ' ' + RESET);
      else if (active && row.note) lines.push('      ' + DIM + fit(row.note, Math.max(0, width - 6)) + RESET);
    });
    lines.push('', state.message ? '  ' + (state.error ? ERROR : OK) + fit(state.message, Math.max(0, width - 3)) + RESET : '');
    return lines;
  }

  /**
   * Renders the new-session form for the right pane: labeled cwd/name fields with a
   * block cursor on the active field, tail-truncated values and an error line.
   * @param width Right-pane width used to clip values.
   * @returns Array of ANSI strings (shorter than pane height; caller pads).
   */
  private formLines(width: number): string[] {
    const f = this.input.form!;
    const budget = Math.max(4, width - 8);
    const cwdShown = f.cwd.length > budget ? '…' + f.cwd.slice(-(budget - 1)) : f.cwd;
    const nameShown = f.name.length > budget ? '…' + f.name.slice(-(budget - 1)) : f.name;
    const cliRows = this.manager.adapters.length > 1
      ? [
        '  ' + DIM + 'CLI (← / → to change):' + RESET,
        '  ' + this.manager.adapters.map((adapter) => (adapter.id === f.adapterId ? BOLD + ACCENT + `[${adapter.label}]` : DIM + ` ${adapter.label} `) + RESET).join(' '),
        '',
      ]
      : [];
    return [
      '',
      '  ' + BOLD + ACCENT + 'New session' + RESET,
      '',
      ...cliRows,
      '  ' + DIM + 'Working directory (~ ok):' + RESET,
      '  ' + (f.field === 0 ? ACCENT + '❯ ' : '  ') + FG_BRIGHT + cwdShown + (f.field === 0 ? CURSOR + ' ' : '') + RESET,
      '',
      '  ' + DIM + 'Session name (optional):' + RESET,
      '  ' + (f.field === 1 ? ACCENT + '❯ ' : '  ') + FG_BRIGHT + nameShown + (f.field === 1 ? CURSOR + ' ' : '') + RESET,
      '',
      f.error ? '  ' + ERROR + f.error.slice(0, Math.max(0, width - 3)) + RESET : '',
    ];
  }
}
