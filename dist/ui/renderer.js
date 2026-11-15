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
exports.Renderer = exports.SIDEBAR_W = void 0;
exports.formatMemory = formatMemory;
exports.formatAgo = formatAgo;
const path = __importStar(require("path"));
const theme_1 = require("./theme");
const koi_1 = require("./koi");
/** Koi are skipped below this size, where they would cover the whole screen. */
const KOI_MIN_COLS = 60;
const KOI_MIN_ROWS = 12;
/** Pond animation cadence (~10 fps keeps CPU and terminal output low). */
const KOI_FRAME_MS = 100;
exports.SIDEBAR_W = 34;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/**
 * Truncates (with ellipsis) or pads plain text to an exact visible width; used to keep
 * sidebar and status-bar lines aligned to fixed column budgets.
 * @param s Plain text without escape sequences.
 * @param w Target visible width.
 * @returns String of exactly `w` visible columns.
 */
function fit(s, w) {
    if (w <= 0)
        return '';
    if (s.length > w)
        return w <= 1 ? s.slice(0, w) : s.slice(0, w - 1) + '…';
    return s + ' '.repeat(w - s.length);
}
/**
 * Formats a byte sample as compact binary MB/GB text for sidebar and status displays.
 * @param bytes Byte count, or null before a successful sample.
 * @returns Em dash for null, rounded MB below 1 GiB, otherwise one-decimal GB.
 */
function formatMemory(bytes) {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0)
        return '—';
    if (bytes < 1024 ** 3)
        return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function formatAgo(ts, now = Date.now()) {
    if (ts === null || !Number.isFinite(ts) || ts < 0)
        return '—';
    const elapsed = Math.max(0, Math.floor((now - ts) / 1000));
    if (elapsed < 60)
        return 'just now';
    if (elapsed < 3600)
        return `${Math.floor(elapsed / 60)}m ago`;
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
function statusSegment(label, message, width, labelStyle = theme_1.ACCENT, messageStyle = theme_1.FG) {
    if (width <= 0)
        return '';
    if (label.length >= width)
        return labelStyle + fit(label, width);
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
function wrap(s, firstW, restW, maxLines) {
    const lines = [];
    let cur = '';
    let w = Math.max(1, firstW);
    for (let word of s.split(' ')) {
        while (word.length > 0) {
            if (cur.length === 0) {
                cur = word.slice(0, w);
                word = word.slice(w);
            }
            else if (cur.length + 1 + word.length <= w) {
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
    if (cur.length > 0 || lines.length === 0)
        lines.push(cur);
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
function shortDir(cwd, max, home) {
    if (max <= 0)
        return '';
    const abbr = cwd === home ? '~' : cwd.startsWith(home + path.sep) ? '~' + cwd.slice(home.length) : cwd;
    if (abbr.length <= max)
        return abbr;
    const base = path.basename(cwd);
    if (base.length <= max)
        return base;
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
function cellSgr(c) {
    const p = [];
    if (c.isBold())
        p.push('1');
    if (c.isDim())
        p.push('2');
    if (c.isItalic())
        p.push('3');
    if (c.isUnderline())
        p.push('4');
    if (c.isBlink())
        p.push('5');
    if (c.isInverse())
        p.push('7');
    if (c.isInvisible())
        p.push('8');
    if (c.isStrikethrough())
        p.push('9');
    if (c.isFgRGB()) {
        const v = c.getFgColor();
        p.push(`38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
    }
    else if (c.isFgPalette()) {
        p.push(`38;5;${c.getFgColor()}`);
    }
    if (c.isBgRGB()) {
        const v = c.getBgColor();
        p.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
    }
    else if (c.isBgPalette()) {
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
function paneRow(term, y, width, scrollOffset) {
    const buf = term.buffer.active;
    const line = buf.getLine(buf.baseY - scrollOffset + y);
    if (!line)
        return '';
    const cell = buf.getNullCell();
    let out = '\x1b[0m' + theme_1.BG + theme_1.FG;
    let lastSgr = '';
    let x = 0;
    const limit = Math.min(width, line.length);
    while (x < limit) {
        const c = line.getCell(x, cell);
        if (!c)
            break;
        const w = c.getWidth();
        if (w === 0) {
            x++;
            continue;
        }
        const sgr = cellSgr(c);
        if (sgr !== lastSgr) {
            out += '\x1b[0m' + theme_1.BG + theme_1.FG + sgr;
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
function helpLines(width) {
    const raw = [
        [],
        [[theme_1.BOLD + theme_1.ACCENT, '  Envoy']],
        [[theme_1.FG, '  Run and switch between multiple agent CLI sessions (Devin, Claude, Codex).']],
        [],
        [[theme_1.ACCENT, '  n          '], [theme_1.FG, 'create a new session (←/→ picks the CLI), then its tag']],
        [[theme_1.ACCENT, '  j / k      '], [theme_1.FG, 'move selection down / up (across all sections)']],
        [[theme_1.ACCENT, '  gg / G     '], [theme_1.FG, 'jump to top / bottom']],
        [[theme_1.ACCENT, '  Ctrl-u/d   '], [theme_1.FG, 'half page up / down']],
        [[theme_1.ACCENT, '  Enter      '], [theme_1.FG, 'ACTIVE attach · TERMINAL adopt/tag · RECENT resume/tag']],
        [[theme_1.ACCENT, '  m          '], [theme_1.FG, 'reorder the selected ACTIVE session within its tag']],
        [[theme_1.ACCENT, '  r          '], [theme_1.FG, 'set a persistent Envoy-only alias on any selected row']],
        [[theme_1.ACCENT, '  H          '], [theme_1.FG, 'toggle RECENT rows for this Envoy run']],
        [[theme_1.ACCENT, '  R          '], [theme_1.FG, 'refresh Envoy and reconnect all idle ACTIVE sessions']],
        [[theme_1.ACCENT, '  d          '], [theme_1.FG, 'flag selected ACTIVE session as DONE — NEEDS YOU']],
        [[theme_1.ACCENT, '  x          '], [theme_1.FG, 'kill selected session (ACTIVE only)']],
        [[theme_1.ACCENT, '  ,          '], [theme_1.FG, 'settings (theme, default dir/CLI, CLIs, RECENT rows…)']],
        [[theme_1.ACCENT, '  q          '], [theme_1.FG, 'quit']],
        [],
        [[theme_1.DIM, '  Attached NORMAL (default): j/k or Ctrl-d/u scroll half page ·']],
        [[theme_1.DIM, '  gg/G top/bottom · p last prompt · i/a INSERT · Ctrl-q sidebar.']],
        [[theme_1.DIM, '  Attached INSERT: every key (incl. Esc) goes to the session ·']],
        [[theme_1.DIM, '  Ctrl-q back to NORMAL. Sessions created via n start in INSERT.']],
        [],
        [[theme_1.DIM, '  Sections: ACTIVE sessions are grouped by ordered tags · RECENT']],
        [[theme_1.DIM, '  sessions from the last 24h, resumable via each CLI · TERMINAL']],
        [[theme_1.DIM, '  REPLs running in other windows (⇄, read-only until adopted).']],
        [[theme_1.DIM, '  ACTIVE/TERMINAL memory is main-process RSS, refreshed every 5s.']],
        [[theme_1.DIM, '  The bottom AGENTS total excludes child processes and Envoy itself.']],
        [[theme_1.DIM, '  Creating, resuming and adopting always asks for a required tag.']],
        [[theme_1.DIM, '  Hiding RECENT is run-local; Envoy restart/refresh shows it again.']],
        [[theme_1.DIM, '  MOVE: j/k one slot · gg/G first/last · Enter save · Esc cancel.']],
        [[theme_1.DIM, '  Saved order uses real session ids and survives Envoy restarts.']],
        [[theme_1.DIM, '  RENAME is Envoy-only, persists by real id, and blank clears it.']],
        [[theme_1.DIM, '  REFRESH always confirms, requires every live ACTIVE session to be']],
        [[theme_1.DIM, '  idle with a session ID, and loses drafts plus local scrollback.']],
        [],
        [[theme_1.DIM, '  Adopting a TERMINAL session closes it in its own window']],
        [[theme_1.DIM, '  (SIGTERM), then resumes it here with exclusive ownership.']],
        [],
        [[theme_1.FG, '  Status:  '], [theme_1.BOLD + theme_1.ACCENT, '⠋ '], [theme_1.FG, 'WORKING   '], [theme_1.DIM, '○ '], [theme_1.FG, 'IDLE']],
        [[theme_1.FG, '           '], [theme_1.BOLD + theme_1.WARN, '◆ '], [theme_1.FG, 'DONE — NEEDS YOU   '], [theme_1.BOLD + theme_1.ERROR, '! '], [theme_1.FG, 'PERMISSION NEEDED']],
        [[theme_1.FG, '           '], [theme_1.DIM, '× '], [theme_1.FG, 'EXITED   '], [theme_1.DIM, '× '], [theme_1.FG, 'EXITED — NEEDS YOU']],
        [[theme_1.DIM, '  WORKING starts only after the CLI submits a prompt, not on keyboard input.']],
        [],
        [[theme_1.DIM, '  Unread badges (●N) and highlighted rows appear when a session']],
        [[theme_1.DIM, '  finishes a turn, requests permission, or exits while you are away.']],
        [],
        [[theme_1.DIM, '  New-session dir defaults to "default_cwd" from']],
        [[theme_1.DIM, '  ~/.config/envoy/config.json (fallback: launch dir).']],
        [[theme_1.DIM, '  Config keys: "enabled_adapters", "default_adapter",']],
        [[theme_1.DIM, '  "adapter_commands", "recent_limit" (CLIs on PATH are enabled']],
        [[theme_1.DIM, '  by default; RECENT slots are shared fairly across CLIs).']],
    ];
    return raw.map((segs) => {
        let out = '';
        let left = width;
        for (const [sgr, text] of segs) {
            if (left <= 0)
                break;
            out += sgr + text.slice(0, left);
            left -= text.length;
        }
        return out + theme_1.RESET;
    });
}
class Renderer {
    manager;
    input;
    home;
    scroll = 0;
    renderTimer = null;
    animationTimer = null;
    freshnessTimer = null;
    koi = null;
    koiCount;
    koiTimer = null;
    koiLastAt = 0;
    spinnerFrame = 0;
    lastFrameAt = 0;
    prevRows = [];
    prevCols = 0;
    prevTermRows = 0;
    stopped = false;
    /**
     * Full-screen ANSI renderer drawing the sidebar, separator, right pane and status bar.
     * @param manager Source of sessions, selection and attachment state.
     * @param input Source of the current mode plus form/confirm state.
     * @param home User home directory for ~ abbreviation in the sidebar.
     */
    constructor(manager, input, home) {
        this.manager = manager;
        this.input = input;
        this.home = home;
    }
    /**
     * Turns the swimming-koi background on or off (off by default until the app enables it).
     * @param enabled True to animate koi behind blank cells.
     * @param repaint False at startup, before the first frame is allowed to draw.
     * @returns Nothing; repaints everything unless `repaint` is false.
     */
    setKoi(enabled, repaint = true) {
        if (enabled && !this.koi) {
            this.koi = new koi_1.KoiPond({ count: this.koiCount });
            this.koiLastAt = Date.now();
        }
        else if (!enabled) {
            this.koi = null;
            if (this.koiTimer)
                clearTimeout(this.koiTimer);
            this.koiTimer = null;
        }
        if (!repaint)
            return;
        this.invalidate();
        this.schedule();
    }
    /**
     * Fixes how many koi swim, or restores the automatic count.
     * @param count Whole number of fish, or undefined for automatic.
     * @param repaint False at startup, before the first frame is allowed to draw.
     * @returns Nothing.
     */
    setKoiCount(count, repaint = true) {
        this.koiCount = count;
        this.koi?.setCount(count);
        if (repaint)
            this.schedule();
    }
    /**
     * Schedules a line-diff redraw at up to ~30fps and starts or settles working animation.
     * @returns Nothing; state and PTY updates call this to coalesce output.
     */
    schedule() {
        if (this.stopped)
            return;
        if (!this.freshnessTimer) {
            // unref'd so the relative PROMPT label repaints on an idle app without holding the event loop open
            this.freshnessTimer = setInterval(() => this.schedule(), 15000);
            this.freshnessTimer.unref();
        }
        if (this.renderTimer)
            return;
        const wait = Math.max(0, 33 - (Date.now() - this.lastFrameAt));
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            if (this.stopped)
                return;
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
                if (this.animationTimer)
                    clearTimeout(this.animationTimer);
                this.animationTimer = null;
            }
            else if (!this.animationTimer) {
                this.animationTimer = setTimeout(() => {
                    this.animationTimer = null;
                    if (this.stopped || !this.manager.sessions.some((session) => session.status === 'working'))
                        return;
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
    stop() {
        this.stopped = true;
        if (this.renderTimer)
            clearTimeout(this.renderTimer);
        if (this.animationTimer)
            clearTimeout(this.animationTimer);
        if (this.freshnessTimer)
            clearInterval(this.freshnessTimer);
        if (this.koiTimer)
            clearTimeout(this.koiTimer);
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
    invalidate() {
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
    frame() {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        const paneW = Math.max(2, cols - exports.SIDEBAR_W - 1);
        const paneH = Math.max(2, rows - 1);
        const side = this.sidebarLines(paneH);
        const att = this.manager.attachedSession;
        const shown = this.input.mode === 'attached' && att ? att : this.manager.selectedSession;
        let paneText = null;
        if (this.input.mode === 'form' && this.input.form)
            paneText = this.formLines(paneW);
        else if (this.input.mode === 'rename' && this.input.rename)
            paneText = this.renameLines(paneW);
        else if (this.input.mode === 'tag-picker' && this.input.tagPicker)
            paneText = this.tagPickerLines(paneW);
        else if (this.input.mode === 'tag-name' && this.input.tagName)
            paneText = this.tagNameLines(paneW);
        else if (this.input.mode === 'tag-position' && this.input.tagPosition)
            paneText = this.tagPositionLines(paneW);
        else if (this.input.mode === 'settings' && this.input.settings && this.input.settingsBackend)
            paneText = this.settingsLines(paneW);
        else if (!shown)
            paneText = helpLines(paneW);
        const offset = shown ? Math.max(0, Math.min(shown.scrollOffset, shown.term.buffer.active.baseY)) : 0;
        const pinnedPrompt = this.input.mode === 'attached' && att && !paneText && offset > 0 ? att.promptForOffset(offset) : null;
        const header = pinnedPrompt ? theme_1.BG_BAR + theme_1.ACCENT + '▌ ' + theme_1.FG_BRIGHT + fit(pinnedPrompt, paneW - 2) : null;
        const newRows = [];
        const pond = this.koi && cols >= KOI_MIN_COLS && paneH >= KOI_MIN_ROWS ? this.koi : null;
        if (pond) {
            // one pond pixel = 1 column x half a row (half-block glyphs), so pixels are small and square
            const now = Date.now();
            pond.setAppearance((0, theme_1.currentAppearance)());
            pond.resize(cols, paneH * 2);
            pond.step(Math.min(0.25, Math.max(0, (now - this.koiLastAt) / 1000)));
            this.koiLastAt = now;
        }
        const water = (0, theme_1.backgroundRgb)();
        for (let y = 0; y < paneH; y++) {
            // the pinned prompt takes screen row 0, pushing the scrolled view down one row
            const pane = paneText ? paneText[y] ?? '' : header && y === 0 ? header : paneRow(shown.term, header ? y - 1 : y, paneW, offset);
            const row = side[y] + theme_1.RESET + theme_1.BG + theme_1.SEPARATOR + '│' + pane + theme_1.RESET + theme_1.BG + '\x1b[K';
            newRows.push(pond ? (0, koi_1.paintPond)(row, y, pond, water, cols) : row);
        }
        let bar;
        const sel = this.manager.entries[this.manager.selected];
        const recentHiddenLabel = ` RECENT HIDDEN (${this.manager.discovery.recents.length})`;
        const totalMemory = formatMemory(this.manager.discovery.totalMemoryBytes);
        const lastPrompt = formatAgo(this.manager.lastPromptAt);
        // with several CLIs enabled, break the total down per CLI (only CLIs with live REPLs);
        // the breakdown is dropped when it would crowd out the mode hints
        const perCli = this.manager.adapters.length > 1
            ? this.manager.adapters
                .filter((adapter) => (this.manager.discovery.memoryByAdapter.get(adapter.id) ?? 0) > 0)
                .map((adapter) => `${adapter.badge} ${formatMemory(this.manager.discovery.memoryByAdapter.get(adapter.id))}`)
            : [];
        const baseSuffix = `PROMPT ${lastPrompt} · AGENTS ${totalMemory}`;
        const breakdown = perCli.length > 0 && baseSuffix.length + 3 + perCli.join(' · ').length <= cols * 0.5 ? ` (${perCli.join(' · ')})` : '';
        const suffixPlain = baseSuffix + breakdown;
        const suffixWidth = Math.min(cols, suffixPlain.length);
        const barWidth = Math.max(0, cols - suffixWidth);
        const suffix = suffixWidth === suffixPlain.length
            ? theme_1.DIM + 'PROMPT ' + theme_1.ACCENT + lastPrompt + theme_1.DIM + ' · AGENTS ' + theme_1.ACCENT + totalMemory + (breakdown ? theme_1.DIM + breakdown : '')
            : theme_1.DIM + fit(suffixPlain, suffixWidth);
        if (this.input.mode === 'confirm' && this.input.confirm)
            bar = theme_1.WARN + fit(` ${this.input.confirm.question} [y/n]`, barWidth);
        else if (this.input.mode === 'move' && this.manager.moveState)
            bar = statusSegment(' MOVE', ` · #${this.manager.moveState.tag} · j/k reorder · gg/G first/last · Enter save · Esc cancel`, barWidth);
        else if (this.input.mode === 'attached' && att && this.input.attachedMode === 'insert')
            bar = statusSegment(' INSERT', ` · ${this.manager.displayName(att)} · ${att.status} · Ctrl-q normal`, barWidth);
        else if (this.input.mode === 'attached' && att)
            bar = this.input.notice
                ? theme_1.ERROR + fit(` ${this.input.notice}`, barWidth)
                : statusSegment(' NORMAL', `${offset > 0 ? ` · ↑${offset}` : ''} · ${this.manager.displayName(att)} · ${att.status} · j/k scroll · gg/G top/bottom · p last prompt · i insert · Ctrl-q sidebar`, barWidth);
        else if (this.input.mode === 'form')
            bar = statusSegment(' NEW SESSION', ` · Enter next/tag · Tab switch field${this.manager.adapters.length > 1 ? ' · ←/→ CLI' : ''} · Esc cancel`, barWidth);
        else if (this.input.mode === 'settings')
            bar = statusSegment(' SETTINGS', this.input.settings?.editing ? ' · type · Enter save · Ctrl-u clear · Esc cancel' : ' · j/k move · ←/→ or Enter change · Enter edits text · Esc close', barWidth);
        else if (this.input.mode === 'rename')
            bar = statusSegment(' RENAME', ' · type or paste · Enter save (blank clears) · Esc cancel', barWidth);
        else if (this.input.mode === 'tag-picker')
            bar = statusSegment(' TAG', ' · j/k or arrows move · gg/G top/bottom · Enter select · n new · Esc cancel action', barWidth);
        else if (this.input.mode === 'tag-name')
            bar = statusSegment(' TAG NAME', ' · type or paste · Enter choose position · Esc tags', barWidth);
        else if (this.input.mode === 'tag-position')
            bar = statusSegment(' TAG POSITION', ' · j/k or arrows move · gg/G top/bottom · Enter insert/select · Esc name', barWidth);
        else if (this.input.notice)
            bar = theme_1.ERROR + fit(` ${this.input.notice}`, barWidth);
        else if (!this.manager.recentVisible)
            bar = statusSegment(recentHiddenLabel, ' · H show · j/k move · Enter select · r rename · R refresh · q quit', barWidth, theme_1.BOLD + theme_1.WARN);
        else if (sel?.kind === 'external')
            bar = statusSegment(' TERMINAL', ' · Enter adopt · r rename · H hide recent · R refresh · j/k move · q quit', barWidth);
        else if (sel?.kind === 'recent')
            bar = statusSegment(' RECENT', ' · Enter resume · r rename · H hide recent · R refresh · j/k move · q quit', barWidth);
        else
            bar = statusSegment(' SIDEBAR', ' · j/k move · Enter attach · r rename · H hide recent · R refresh · m move · n new · d flag · x kill · , settings · q quit', barWidth);
        newRows.push(theme_1.BG_BAR + bar + suffix + theme_1.RESET);
        const full = cols !== this.prevCols || rows !== this.prevTermRows || this.prevRows.length === 0;
        let out = '\x1b[?25l';
        for (let y = 0; y < paneH; y++) {
            if (full || newRows[y] !== this.prevRows[y])
                out += `\x1b[${y + 1};1H` + newRows[y];
        }
        if (full || newRows[paneH] !== this.prevRows[paneH])
            out += `\x1b[${rows};1H` + newRows[paneH];
        this.prevRows = newRows;
        this.prevCols = cols;
        this.prevTermRows = rows;
        if (this.input.mode === 'attached' && att && !att.exited && this.input.attachedMode === 'insert' && offset === 0) {
            const b = att.term.buffer.active;
            if (b.cursorY >= 0 && b.cursorY < paneH)
                out += `\x1b[${b.cursorY + 1};${exports.SIDEBAR_W + 2 + Math.min(b.cursorX, paneW - 1)}H\x1b[?25h`;
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
    sidebarLines(height) {
        const lines = [
            theme_1.BG + theme_1.BOLD + theme_1.ACCENT + fit(' Envoy', exports.SIDEBAR_W) + theme_1.RESET,
            theme_1.BG + theme_1.RULE + '─'.repeat(exports.SIDEBAR_W) + theme_1.RESET,
        ];
        const entries = this.manager.entries;
        const body = [];
        let selStart = 0;
        let selLen = 3;
        let prevKind = '';
        let prevTag = '';
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e.kind !== prevKind) {
                prevKind = e.kind;
                const label = e.kind === 'active' ? 'ACTIVE' : e.kind === 'external' ? 'TERMINAL' : 'RECENT';
                body.push(theme_1.BG + theme_1.BOLD + theme_1.DIM + fit(` ${label}`, exports.SIDEBAR_W) + theme_1.RESET);
            }
            if (e.kind === 'active' && e.session.tag !== prevTag) {
                prevTag = e.session.tag;
                body.push(theme_1.BG + theme_1.BOLD + theme_1.ACCENT + fit(`  # ${e.session.tag}`, exports.SIDEBAR_W) + theme_1.RESET);
            }
            const selected = i === this.manager.selected;
            const unread = e.kind === 'active' && e.session.unread.length > 0;
            const flagged = e.kind === 'active' && e.session.markedDone;
            const bg = selected ? theme_1.BG_SELECT : unread || flagged ? theme_1.BG_UNREAD : theme_1.BG;
            const text = selected ? theme_1.FG_BRIGHT : theme_1.FG;
            let marker = selected ? theme_1.ACCENT + '›' : ' ';
            let icon;
            let name;
            let nameStyle = text;
            let badge = '';
            let badgeStyle = theme_1.BOLD + theme_1.ERROR;
            let details;
            if (e.kind === 'active') {
                const s = e.session;
                if (this.input.mode === 'move' && this.manager.moveState?.session === s)
                    marker = theme_1.ACCENT + '↕';
                else if (s.id === this.manager.attachedId)
                    marker = theme_1.OK + '▶';
                let sprite;
                let label;
                let statusStyle;
                if (s.status === 'working') {
                    sprite = SPINNER_FRAMES[this.spinnerFrame];
                    label = 'WORKING';
                    statusStyle = theme_1.BOLD + theme_1.ACCENT;
                }
                else if (s.status === 'waiting' && (unread || flagged)) {
                    sprite = '◆';
                    label = 'DONE — NEEDS YOU';
                    statusStyle = theme_1.BOLD + theme_1.WARN;
                }
                else if (s.status === 'waiting') {
                    sprite = '○';
                    label = 'IDLE';
                    statusStyle = theme_1.DIM;
                }
                else if (s.status === 'needs-permission') {
                    sprite = '!';
                    label = 'PERMISSION NEEDED';
                    statusStyle = theme_1.BOLD + theme_1.ERROR;
                }
                else {
                    sprite = '×';
                    label = unread || flagged ? 'EXITED — NEEDS YOU' : 'EXITED';
                    statusStyle = theme_1.DIM;
                }
                const statusText = `${sprite} ${label}`;
                const memory = formatMemory(s.memoryBytes);
                const cli = this.manager.badgeFor(s.adapterId) ? ` · ${this.manager.badgeFor(s.adapterId)}` : '';
                const dir = shortDir(s.cwd, exports.SIDEBAR_W - 7 - memory.length - cli.length, this.home);
                icon = statusStyle + sprite;
                name = this.manager.displayName(s);
                if (unread || flagged) {
                    nameStyle = theme_1.BOLD + theme_1.FG_BRIGHT;
                    badge = unread ? `●${s.unread.length}` : '◆';
                    if (!unread)
                        badgeStyle = theme_1.BOLD + theme_1.WARN;
                }
                else if (s.status === 'exited')
                    nameStyle = theme_1.DIM;
                details = [
                    theme_1.DIM + fit(`    ${dir} · ${memory}${cli}`, exports.SIDEBAR_W),
                    theme_1.DIM + '    ' + statusStyle + statusText + ' '.repeat(Math.max(0, exports.SIDEBAR_W - 4 - statusText.length)),
                ];
            }
            else if (e.kind === 'external') {
                const memory = formatMemory(e.external.memoryBytes);
                const cli = this.manager.badgeFor(e.external.adapterId) ? ` · ${this.manager.badgeFor(e.external.adapterId)}` : '';
                icon = theme_1.EXTERNAL + '⇄';
                name = this.manager.displayName(e);
                details = [
                    theme_1.DIM + fit(`    ${shortDir(e.external.cwd, exports.SIDEBAR_W - 7 - memory.length - cli.length, this.home)} · ${memory}${cli}`, exports.SIDEBAR_W),
                    theme_1.DIM + fit('    terminal', exports.SIDEBAR_W),
                ];
            }
            else {
                const cli = this.manager.badgeFor(e.recent.adapterId) ? ` · ${this.manager.badgeFor(e.recent.adapterId)}` : '';
                icon = theme_1.RECENT + '↺';
                name = this.manager.displayName(e);
                details = [theme_1.DIM + fit(`    ${shortDir(e.recent.cwd, exports.SIDEBAR_W - 7 - e.recent.lastAgo.length - cli.length, this.home)} · ${e.recent.lastAgo}${cli}`, exports.SIDEBAR_W)];
            }
            const nameW = exports.SIDEBAR_W - 4 - (badge ? badge.length + 1 : 0);
            const nameLines = selected || e.kind === 'active' ? wrap(name, nameW, exports.SIDEBAR_W - 4, 4) : [name];
            if (selected) {
                selStart = body.length;
                selLen = nameLines.length + details.length + 1;
            }
            body.push(bg + marker + ' ' + icon + ' ' + nameStyle + fit(nameLines[0], nameW) + (badge ? ' ' + badgeStyle + badge : '') + theme_1.RESET);
            for (const cont of nameLines.slice(1))
                body.push(bg + '    ' + nameStyle + fit(cont, exports.SIDEBAR_W - 4) + theme_1.RESET);
            for (const detail of details)
                body.push(bg + detail + theme_1.RESET);
            body.push(theme_1.BG + ' '.repeat(exports.SIDEBAR_W) + theme_1.RESET);
        }
        const avail = Math.max(1, height - 2);
        if (selStart + selLen > this.scroll + avail)
            this.scroll = selStart + selLen - avail;
        if (selStart - 1 < this.scroll)
            this.scroll = Math.max(0, selStart - 1);
        this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - avail)));
        lines.push(...body.slice(this.scroll, this.scroll + avail));
        while (lines.length < height)
            lines.push(theme_1.BG + ' '.repeat(exports.SIDEBAR_W) + theme_1.RESET);
        return lines.slice(0, height);
    }
    /**
     * Renders envoy alias editing with stable target/original context and validation feedback.
     * @param width Right-pane width used to tail-clip the field and clip hints.
     * @returns ANSI rows for the rename pane.
     */
    renameLines(width) {
        const state = this.input.rename;
        const budget = Math.max(4, width - 8);
        const shown = state.value.length > budget ? '…' + state.value.slice(-(budget - 1)) : state.value;
        return [
            '',
            '  ' + theme_1.BOLD + theme_1.ACCENT + 'Rename session' + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + fit(`${state.section} · ${state.target.kind === 'active' ? state.target.session.cliSessionId ?? 'Session ID pending' : state.target.sessionId}`, Math.max(0, width - 2)) + theme_1.RESET,
            '  ' + theme_1.DIM + fit(`Original: ${state.original}`, Math.max(0, width - 2)) + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + 'Envoy alias (maximum 120 characters):' + theme_1.RESET,
            '  ' + theme_1.ACCENT + '❯ ' + theme_1.FG_BRIGHT + shown + theme_1.CURSOR + ' ' + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + fit('Blank saves no alias and shows the CLI title/session ID.', Math.max(0, width - 2)) + theme_1.RESET,
            '',
            state.error ? '  ' + theme_1.ERROR + state.error.slice(0, Math.max(0, width - 3)) + theme_1.RESET : '',
        ];
    }
    /**
     * Renders the ordered existing-tag picker with Nord selection styling.
     * @param width Right-pane width used to clip list rows.
     * @returns ANSI rows for the tag picker pane.
     */
    tagPickerLines(width) {
        const selected = this.input.tagPicker.selected;
        const lines = [
            '',
            '  ' + theme_1.BOLD + theme_1.ACCENT + 'Choose a session tag' + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + 'Every ACTIVE session belongs to one ordered tag.' + theme_1.RESET,
            '',
        ];
        for (let i = 0; i < this.manager.tagStore.tags.length; i++) {
            const active = i === selected;
            const text = `${i + 1}. ${this.manager.tagStore.tags[i]}`;
            lines.push((active ? theme_1.BG_SELECT + theme_1.ACCENT + '  › ' + theme_1.FG_BRIGHT : '    ' + theme_1.FG) + fit(text, Math.max(1, width - 4)) + theme_1.RESET);
        }
        return lines;
    }
    /**
     * Renders custom tag-name text entry, cursor and validation feedback.
     * @param width Right-pane width used to tail-clip the value and error.
     * @returns ANSI rows for the tag-name pane.
     */
    tagNameLines(width) {
        const state = this.input.tagName;
        const budget = Math.max(4, width - 8);
        const shown = state.value.length > budget ? '…' + state.value.slice(-(budget - 1)) : state.value;
        return [
            '',
            '  ' + theme_1.BOLD + theme_1.ACCENT + 'Create a tag' + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + 'Name (1–30 characters, unique ignoring case):' + theme_1.RESET,
            '  ' + theme_1.ACCENT + '❯ ' + theme_1.FG_BRIGHT + shown + theme_1.CURSOR + ' ' + theme_1.RESET,
            '',
            state.error ? '  ' + theme_1.ERROR + state.error.slice(0, Math.max(0, width - 3)) + theme_1.RESET : '',
        ];
    }
    /**
     * Renders every human-readable insertion slot around the current ordered tags.
     * @param width Right-pane width used to clip slot labels.
     * @returns ANSI rows for the tag-position pane.
     */
    tagPositionLines(width) {
        const state = this.input.tagPosition;
        const tags = this.manager.tagStore.tags;
        const lines = [
            '',
            '  ' + theme_1.BOLD + theme_1.ACCENT + `Position #${state.name}` + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + 'Choose where the new tag belongs:' + theme_1.RESET,
            '',
        ];
        for (let i = 0; i <= tags.length; i++) {
            const label = i === 0 ? `before ${tags[0]}` : i === tags.length ? `after ${tags[tags.length - 1]}` : `between ${tags[i - 1]} and ${tags[i]}`;
            const active = i === state.selected;
            const text = `${i + 1}. ${label}`;
            lines.push((active ? theme_1.BG_SELECT + theme_1.ACCENT + '  › ' + theme_1.FG_BRIGHT : '    ' + theme_1.FG) + fit(text, Math.max(1, width - 4)) + theme_1.RESET);
        }
        lines.push('', state.error ? '  ' + theme_1.ERROR + state.error.slice(0, Math.max(0, width - 3)) + theme_1.RESET : '');
        return lines;
    }
    /**
     * Renders the settings screen: one row per setting (label, value, dimmed note), the
     * highlighted row, an inline text editor for typed values, and the last result message.
     * @param width Right-pane width used to clip rows.
     * @returns ANSI rows for the settings pane.
     */
    settingsLines(width) {
        const state = this.input.settings;
        const rows = this.input.settingsBackend.rows();
        const labelW = Math.min(24, Math.max(10, rows.reduce((max, row) => Math.max(max, row.label.length), 0) + 2));
        const budget = Math.max(4, width - 8);
        const lines = ['', '  ' + theme_1.BOLD + theme_1.ACCENT + 'Settings' + theme_1.RESET, '', '  ' + theme_1.DIM + fit('Changes apply immediately and are saved to ~/.config/envoy/config.json.', Math.max(0, width - 2)) + theme_1.RESET, ''];
        rows.forEach((row, i) => {
            const active = i === state.selected;
            const editing = active && state.editing ? state.editing : null;
            const valueText = editing ? (editing.value.length > budget ? '…' + editing.value.slice(-(budget - 1)) : editing.value) : row.value;
            const prefix = active ? theme_1.BG_SELECT + theme_1.ACCENT + '  › ' + theme_1.FG_BRIGHT : '    ' + theme_1.FG;
            const arrows = !editing && active && (row.kind === 'cycle' || row.kind === 'toggle' || row.kind === 'number') ? '◂ ▸ ' : '';
            const body = fit(row.label, labelW) + arrows + (editing ? '' : valueText);
            lines.push(prefix + fit(body, Math.max(1, width - 4)) + theme_1.RESET);
            if (editing)
                lines.push('      ' + theme_1.ACCENT + '❯ ' + theme_1.FG_BRIGHT + valueText + theme_1.CURSOR + ' ' + theme_1.RESET);
            else if (active && row.note)
                lines.push('      ' + theme_1.DIM + fit(row.note, Math.max(0, width - 6)) + theme_1.RESET);
        });
        lines.push('', state.message ? '  ' + (state.error ? theme_1.ERROR : theme_1.OK) + fit(state.message, Math.max(0, width - 3)) + theme_1.RESET : '');
        return lines;
    }
    /**
     * Renders the new-session form for the right pane: labeled cwd/name fields with a
     * block cursor on the active field, tail-truncated values and an error line.
     * @param width Right-pane width used to clip values.
     * @returns Array of ANSI strings (shorter than pane height; caller pads).
     */
    formLines(width) {
        const f = this.input.form;
        const budget = Math.max(4, width - 8);
        const cwdShown = f.cwd.length > budget ? '…' + f.cwd.slice(-(budget - 1)) : f.cwd;
        const nameShown = f.name.length > budget ? '…' + f.name.slice(-(budget - 1)) : f.name;
        const cliRows = this.manager.adapters.length > 1
            ? [
                '  ' + theme_1.DIM + 'CLI (← / → to change):' + theme_1.RESET,
                '  ' + this.manager.adapters.map((adapter) => (adapter.id === f.adapterId ? theme_1.BOLD + theme_1.ACCENT + `[${adapter.label}]` : theme_1.DIM + ` ${adapter.label} `) + theme_1.RESET).join(' '),
                '',
            ]
            : [];
        return [
            '',
            '  ' + theme_1.BOLD + theme_1.ACCENT + 'New session' + theme_1.RESET,
            '',
            ...cliRows,
            '  ' + theme_1.DIM + 'Working directory (~ ok):' + theme_1.RESET,
            '  ' + (f.field === 0 ? theme_1.ACCENT + '❯ ' : '  ') + theme_1.FG_BRIGHT + cwdShown + (f.field === 0 ? theme_1.CURSOR + ' ' : '') + theme_1.RESET,
            '',
            '  ' + theme_1.DIM + 'Session name (optional):' + theme_1.RESET,
            '  ' + (f.field === 1 ? theme_1.ACCENT + '❯ ' : '  ') + theme_1.FG_BRIGHT + nameShown + (f.field === 1 ? theme_1.CURSOR + ' ' : '') + theme_1.RESET,
            '',
            f.error ? '  ' + theme_1.ERROR + f.error.slice(0, Math.max(0, width - 3)) + theme_1.RESET : '',
        ];
    }
}
exports.Renderer = Renderer;
