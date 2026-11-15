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

/** Dark: pure black background and neutral grey highlights; text and accents are the original Nord colors. */
const DARK: Palette = {
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
const LIGHT: Palette = {
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
  const [r, g, b] = (current === 'light' ? LIGHT : DARK).bg.split(';').map(Number);
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
