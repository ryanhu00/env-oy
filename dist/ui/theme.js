"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURSOR = exports.RECENT = exports.EXTERNAL = exports.ERROR = exports.WARN = exports.OK = exports.SEPARATOR = exports.RULE = exports.ACCENT = exports.DIM = exports.FG_BRIGHT = exports.FG = exports.BG_BAR = exports.BG_SELECT = exports.BG_UNREAD = exports.BG = exports.BOLD = exports.RESET = void 0;
exports.applyTheme = applyTheme;
exports.backgroundRgb = backgroundRgb;
exports.currentAppearance = currentAppearance;
/** Dark: pure black background and neutral grey highlights; text and accents are the original Nord colors. */
const DARK = {
    bg: '0;0;0',
    bgUnread: '26;26;26',
    bgSelect: '48;48;48',
    bgBar: '26;26;26',
    fg: '216;222;233',
    fgBright: '236;239;244',
    dim: '97;110;136',
    accent: '136;192;208',
    rule: '64;64;64',
    separator: '40;40;40',
    ok: '163;190;140',
    warn: '235;203;139',
    error: '191;97;106',
    external: '129;161;193',
    recent: '180;142;173',
    cursorFg: '0;0;0',
};
/** Light: pure white background, neutral grey highlights, darkened accents for contrast. */
const LIGHT = {
    bg: '255;255;255',
    bgUnread: '240;240;240',
    bgSelect: '222;222;222',
    bgBar: '240;240;240',
    fg: '40;40;40',
    fgBright: '0;0;0',
    dim: '110;110;110',
    accent: '30;100;160',
    rule: '200;200;200',
    separator: '220;220;220',
    ok: '60;120;40',
    warn: '150;100;0',
    error: '176;40;56',
    external: '50;90;150',
    recent: '130;80;125',
    cursorFg: '255;255;255',
};
exports.RESET = '\x1b[0m';
exports.BOLD = '\x1b[1m';
// The colors below are live bindings: applyTheme() reassigns them, and every consumer
// reads them at call time (compiled CommonJS accesses `theme_1.X` on each use).
exports.BG = '';
exports.BG_UNREAD = '';
exports.BG_SELECT = '';
exports.BG_BAR = '';
exports.FG = '';
exports.FG_BRIGHT = '';
exports.DIM = '';
exports.ACCENT = '';
exports.RULE = '';
exports.SEPARATOR = '';
exports.OK = '';
exports.WARN = '';
exports.ERROR = '';
exports.EXTERNAL = '';
exports.RECENT = '';
exports.CURSOR = '';
let current = 'dark';
const bgOf = (rgb) => `\x1b[48;2;${rgb}m`;
const fgOf = (rgb) => `\x1b[38;2;${rgb}m`;
/**
 * Switches every exported color to the given appearance.
 * @param appearance 'dark' (Nord, default at load) or 'light'.
 * @returns Nothing; callers must repaint (Renderer.invalidate) to show the change.
 */
function applyTheme(appearance) {
    const p = appearance === 'light' ? LIGHT : DARK;
    current = appearance;
    exports.BG = bgOf(p.bg);
    exports.BG_UNREAD = bgOf(p.bgUnread);
    exports.BG_SELECT = bgOf(p.bgSelect);
    exports.BG_BAR = bgOf(p.bgBar);
    exports.FG = fgOf(p.fg);
    exports.FG_BRIGHT = fgOf(p.fgBright);
    exports.DIM = fgOf(p.dim);
    exports.ACCENT = fgOf(p.accent);
    exports.RULE = fgOf(p.rule);
    exports.SEPARATOR = fgOf(p.separator);
    exports.OK = fgOf(p.ok);
    exports.WARN = fgOf(p.warn);
    exports.ERROR = fgOf(p.error);
    exports.EXTERNAL = fgOf(p.external);
    exports.RECENT = fgOf(p.recent);
    exports.CURSOR = bgOf(p.accent) + fgOf(p.cursorFg);
}
/**
 * Returns the current theme background as an RGB triple (what blank cells look like).
 * @returns [r, g, b].
 */
function backgroundRgb() {
    const [r, g, b] = (current === 'light' ? LIGHT : DARK).bg.split(';').map(Number);
    return [r, g, b];
}
/**
 * Returns the appearance currently applied.
 * @returns 'light' or 'dark'.
 */
function currentAppearance() {
    return current;
}
applyTheme('dark');
