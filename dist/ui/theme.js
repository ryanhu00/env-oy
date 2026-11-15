"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURSOR = exports.RECENT = exports.EXTERNAL = exports.ERROR = exports.WARN = exports.OK = exports.SEPARATOR = exports.RULE = exports.ACCENT = exports.DIM = exports.FG_BRIGHT = exports.FG = exports.BG_BAR = exports.BG_SELECT = exports.BG_UNREAD = exports.BG = exports.BOLD = exports.RESET = void 0;
exports.applyTheme = applyTheme;
exports.backgroundRgb = backgroundRgb;
exports.backgroundFor = backgroundFor;
exports.currentAppearance = currentAppearance;
/**
 * Dark: a soft near-black (#181818, the usual editor-dark level, avoiding the glare and halation
 * of pure #000 behind #fff) with neutral grey highlights; text is a slightly softened Nord white.
 */
const DARK = {
    bg: '24;24;24',
    bgUnread: '34;34;34',
    bgSelect: '54;54;54',
    bgBar: '34;34;34',
    fg: '200;206;218',
    fgBright: '224;228;236',
    dim: '112;124;148',
    accent: '136;192;208',
    rule: '70;70;70',
    separator: '46;46;46',
    ok: '163;190;140',
    warn: '235;203;139',
    error: '191;97;106',
    external: '129;161;193',
    recent: '180;142;173',
    cursorFg: '24;24;24',
};
/**
 * Light: a soft off-white paper tone (#f4f4f2) instead of pure white, charcoal text instead of
 * pure black, neutral grey highlights, and darkened accents for contrast.
 */
const LIGHT = {
    bg: '244;244;242',
    bgUnread: '232;232;230',
    bgSelect: '214;214;212',
    bgBar: '232;232;230',
    fg: '52;52;52',
    fgBright: '26;26;26',
    dim: '112;112;112',
    accent: '30;100;160',
    rule: '196;196;194',
    separator: '216;216;214',
    ok: '60;120;40',
    warn: '150;100;0',
    error: '176;40;56',
    external: '50;90;150',
    recent: '130;80;125',
    cursorFg: '244;244;242',
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
    return backgroundFor(current);
}
/**
 * Returns the background of a given appearance as an RGB triple.
 * @param appearance 'light' or 'dark'.
 * @returns [r, g, b].
 */
function backgroundFor(appearance) {
    const [r, g, b] = (appearance === 'light' ? LIGHT : DARK).bg.split(';').map(Number);
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
