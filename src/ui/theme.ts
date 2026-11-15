export type Appearance = 'light' | 'dark';

/** User preference: a fixed appearance, or 'auto' to follow the system. */
export type ThemeSetting = Appearance | 'auto';

/** RGB triples ("r;g;b") for every role the UI paints with. */
interface Palette {
  bg: string;
  bgUnread: string;
  bgSelect: string;
  bgBar: string;
  fg: string;
  fgBright: string;
  dim: string;
  accent: string;
  rule: string;
  separator: string;
  ok: string;
  warn: string;
  error: string;
  external: string;
  recent: string;
  /** Foreground drawn on top of the accent-colored cursor block. */
  cursorFg: string;
}

/**
 * Dark: a soft near-black (#181818, the usual editor-dark level, avoiding the glare and halation
 * of pure #000 behind #fff) with neutral grey highlights; text is a slightly softened Nord white.
 */
const DARK: Palette = {
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
const LIGHT: Palette = {
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

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';

// The colors below are live bindings: applyTheme() reassigns them, and every consumer
// reads them at call time (compiled CommonJS accesses `theme_1.X` on each use).
export let BG = '';
export let BG_UNREAD = '';
export let BG_SELECT = '';
export let BG_BAR = '';
export let FG = '';
export let FG_BRIGHT = '';
export let DIM = '';
export let ACCENT = '';
export let RULE = '';
export let SEPARATOR = '';
export let OK = '';
export let WARN = '';
export let ERROR = '';
export let EXTERNAL = '';
export let RECENT = '';
export let CURSOR = '';

let current: Appearance = 'dark';

const bgOf = (rgb: string): string => `\x1b[48;2;${rgb}m`;
const fgOf = (rgb: string): string => `\x1b[38;2;${rgb}m`;

/**
 * Switches every exported color to the given appearance.
 * @param appearance 'dark' (Nord, default at load) or 'light'.
 * @returns Nothing; callers must repaint (Renderer.invalidate) to show the change.
 */
export function applyTheme(appearance: Appearance): void {
  const p = appearance === 'light' ? LIGHT : DARK;
  current = appearance;
  BG = bgOf(p.bg);
  BG_UNREAD = bgOf(p.bgUnread);
  BG_SELECT = bgOf(p.bgSelect);
  BG_BAR = bgOf(p.bgBar);
  FG = fgOf(p.fg);
  FG_BRIGHT = fgOf(p.fgBright);
  DIM = fgOf(p.dim);
  ACCENT = fgOf(p.accent);
  RULE = fgOf(p.rule);
  SEPARATOR = fgOf(p.separator);
  OK = fgOf(p.ok);
  WARN = fgOf(p.warn);
  ERROR = fgOf(p.error);
  EXTERNAL = fgOf(p.external);
  RECENT = fgOf(p.recent);
  CURSOR = bgOf(p.accent) + fgOf(p.cursorFg);
}

/**
 * Returns the current theme background as an RGB triple (what blank cells look like).
 * @returns [r, g, b].
 */
export function backgroundRgb(): readonly [number, number, number] {
  return backgroundFor(current);
}

/**
 * Returns the background of a given appearance as an RGB triple.
 * @param appearance 'light' or 'dark'.
 * @returns [r, g, b].
 */
export function backgroundFor(appearance: Appearance): readonly [number, number, number] {
  const [r, g, b] = (appearance === 'light' ? LIGHT : DARK).bg.split(';').map(Number);
  return [r, g, b];
}

/**
 * Returns the appearance currently applied.
 * @returns 'light' or 'dark'.
 */
export function currentAppearance(): Appearance {
  return current;
}

applyTheme('dark');
