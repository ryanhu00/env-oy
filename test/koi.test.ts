import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KoiPond, koiPalette, paintPond, type Rgb } from '../src/ui/koi';
import * as theme from '../src/ui/theme';

const BLACK: Rgb = [0, 0, 0];
const BG = '\x1b[48;2;0;0;0m';
const FG = '\x1b[38;2;220;220;220m';
const COLS = 160;
const ROWS = 40; // terminal rows; the pond has 2 pixel rows per terminal row
const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
/** Visible text with the half-block fish glyphs read as blanks. */
const text = (s: string): string => visible(s).replace(/[▀▄]/g, ' ');
const swim = (pond: KoiPond, seconds: number, dt = 0.1): void => {
  for (let t = 0; t < seconds; t += dt) pond.step(dt);
};
const snapshot = (pond: KoiPond): number[] => {
  const out: number[] = [];
  for (let y = 0; y < pond.height; y++) for (let x = 0; x < pond.width; x++) out.push(pond.rgbAt(x, y));
  return out;
};
/** The terminal row with the most fish pixels (so tests exercise real fish bodies). */
const fishRow = (pond: KoiPond): number => {
  let best = -1;
  let bestCount = 0;
  for (let y = 0; y < pond.height / 2; y++) {
    let count = 0;
    for (let x = 0; x < pond.width; x++) count += (pond.rgbAt(x, 2 * y) ? 1 : 0) + (pond.rgbAt(x, 2 * y + 1) ? 1 : 0);
    if (count > bestCount) [best, bestCount] = [y, count];
  }
  if (best < 0) throw new Error('no fish visible');
  return best;
};
/** A pond without ripples by default, so fish tests only ever see fish pixels. */
const newPond = (options: { seed: number; count?: number; ripples?: boolean }): KoiPond => {
  const pond = new KoiPond({ ripples: false, ...options });
  pond.resize(COLS, ROWS * 2);
  return pond;
};

test('the same seed gives the same pond; different seeds differ', () => {
  const a = newPond({ seed: 5 });
  const b = newPond({ seed: 5 });
  const c = newPond({ seed: 6 });
  for (const pond of [a, b, c]) swim(pond, 12);
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.notDeepEqual(snapshot(a), snapshot(c));
});

test('fish are small-pixel sprites in several colours and actually move', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const before = snapshot(pond);
  const colours = new Set(before.filter((v) => v !== 0));
  assert.ok(colours.size >= 3, `expected several koi colours, got ${colours.size}`);
  assert.ok(before.filter((v) => v !== 0).length > 400, 'fish have a detailed body, not a dot');
  swim(pond, 5);
  assert.notDeepEqual(snapshot(pond), before);
});

test('fish stay in the pond over a long swim', () => {
  const pond = newPond({ seed: 3, count: 5 });
  for (let t = 0; t < 600; t += 0.1) {
    pond.step(0.1);
    if (Math.round(t * 10) % 50 === 0) assert.ok(snapshot(pond).some((v) => v !== 0), `pond empty at ${t.toFixed(1)}s`);
  }
  assert.ok(snapshot(pond).some((v) => v !== 0));
});

test('fish count follows the pond size, resizing keeps working, and tiny ponds are safe', () => {
  const pond = new KoiPond({ seed: 2 });
  assert.equal(pond.fishCount, 0);
  pond.resize(40, 20);
  assert.equal(pond.fishCount, 2);
  pond.resize(300, 150);
  assert.equal(pond.fishCount, 6);
  pond.resize(80, 48);
  assert.ok(pond.fishCount >= 2 && pond.fishCount < 6);
  swim(pond, 3);
  const tiny = new KoiPond({ seed: 2 });
  tiny.resize(1, 1);
  swim(tiny, 3);
  const fixed = new KoiPond({ seed: 2, count: 3 });
  fixed.resize(80, 40);
  assert.equal(fixed.fishCount, 3);
});

test('setCount fixes the fish count live and auto restores the size-based count', () => {
  const pond = newPond({ seed: 9 });
  const auto = pond.fishCount;
  assert.equal(auto, 4); // 160 x 80 px = 12800 / 3600 = 3.6 -> 4
  pond.setCount(1);
  assert.equal(pond.fishCount, 1);
  pond.setCount(11);
  assert.equal(pond.fishCount, 11);
  assert.ok(snapshot(pond).some((v) => v !== 0));
  swim(pond, 5);
  pond.resize(100, 40); // resizing keeps the fixed count
  assert.equal(pond.fishCount, 11);
  pond.setCount(undefined);
  assert.ok(pond.fishCount >= 2 && pond.fishCount <= 6);
  pond.setCount(0); // never below one fish
  assert.equal(pond.fishCount, 1);
});

test('ripples spread, fade away, and never move the fish', () => {
  const withRipples = newPond({ seed: 11, count: 3, ripples: true });
  const without = newPond({ seed: 11, count: 3 });
  assert.equal(withRipples.rippleCount, 0);
  let seen = 0;
  let max = 0;
  for (let t = 0; t < 60; t += 0.1) {
    withRipples.step(0.1);
    without.step(0.1);
    seen += withRipples.rippleCount > 0 ? 1 : 0;
    max = Math.max(max, withRipples.rippleCount);
  }
  assert.ok(seen > 100, 'ripples should be around most of the time');
  assert.ok(max >= 1 && max <= 3, `at most 3 ripples at once, saw ${max}`);
  assert.equal(without.rippleCount, 0);
  // ripples add water pixels but the fish are in the same place (fish pixels are identical)
  const a = snapshot(withRipples);
  const b = snapshot(without);
  assert.ok(a.filter((v) => v !== 0).length > b.filter((v) => v !== 0).length);
  for (let i = 0; i < a.length; i++) if (b[i] !== 0) assert.equal(a[i], b[i], `pixel ${i}`);
});

test('ripples are large and subtle, and rows carrying only ripples are painted', () => {
  const pond = newPond({ seed: 21, count: 1, ripples: true });
  for (let t = 0; t < 4; t += 0.1) pond.step(0.1);
  assert.ok(pond.rippleCount >= 1);
  const bgRed = theme.backgroundFor('dark')[0];
  let lit = 0;
  let widest = 0;
  for (let y = 0; y < pond.height; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < pond.width; x++) {
      const v = pond.rgbAt(x, y);
      if (!v) continue;
      lit++;
      if (left < 0) left = x;
      right = x;
      assert.ok(v - 1 >= 0);
    }
    widest = Math.max(widest, right - left);
  }
  assert.ok(lit > 100);
  assert.ok(widest > 20, `ripples should be wide, widest span ${widest}`);
  // a ripple-only pixel is only a little lighter than the water: no harsh rings
  let faint = 0;
  for (let y = 0; y < pond.height; y++) {
    for (let x = 0; x < pond.width; x++) {
      const v = pond.rgbAt(x, y);
      if (v && (((v - 1) >> 16) & 255) - bgRed < 60) faint++;
    }
  }
  assert.ok(faint > lit / 3);
  const y = Array.from({ length: pond.height / 2 }, (_, i) => i).find((r) => pond.rowHasPixels(r))!;
  const row = '\x1b[0m' + BG + FG + 'x'.repeat(10) + '\x1b[K';
  assert.ok(text(paintPond(row, y, pond, BLACK, COLS)).startsWith('x'.repeat(10)));
});

test('light and dark ponds use different palettes', () => {
  const dark = newPond({ seed: 4, count: 3 });
  const light = newPond({ seed: 4, count: 3 });
  light.setAppearance('light');
  assert.notDeepEqual(snapshot(dark), snapshot(light));
  assert.notDeepEqual(koiPalette('light').tones.white, koiPalette('dark').tones.white);
});

test('paintPond leaves rows without fish untouched', () => {
  const pond = newPond({ seed: 1, count: 2 });
  const empty = Array.from({ length: pond.height / 2 }, (_, y) => y).find((y) => !pond.rowHasPixels(y));
  assert.notEqual(empty, undefined);
  const row = BG + FG + 'hello' + '\x1b[K';
  assert.equal(paintPond(row, empty!, pond, BLACK, COLS), row);
});

test('paintPond draws half-block pixels and never changes the text', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const y = fishRow(pond);
  const words = 'Run and switch between multiple agent CLI sessions'.padEnd(120, ' ');
  const row = '\x1b[0m' + BG + FG + words + '\x1b[0m' + BG + '\x1b[K';
  const painted = paintPond(row, y, pond, BLACK, COLS);
  assert.notEqual(painted, row);
  assert.match(painted, /[▀▄]/);
  assert.match(painted, /\x1b\[[0-9;]*38;2;\d+;\d+;\d+/);
  assert.match(painted, /\x1b\[[0-9;]*48;2;\d+;\d+;\d+/);
  // the original words survive exactly; the erase-to-EOL remainder became explicit blank cells
  assert.equal(text(painted).slice(0, words.length), words);
  assert.equal([...visible(painted)].length, COLS);
  assert.ok(painted.endsWith('\x1b[K'));
});

test('half-block glyphs only replace blank cells', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const y = fishRow(pond);
  const letters = 'x'.repeat(COLS);
  const painted = paintPond('\x1b[0m' + BG + FG + letters, y, pond, BLACK, COLS);
  assert.equal(visible(painted), letters); // every character stays; fish only tint behind them
  assert.notEqual(painted, '\x1b[0m' + BG + FG + letters);
});

test('paintPond skips highlighted, inverse, and explicit-background cells', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const y = fishRow(pond);
  const blanks = ' '.repeat(COLS);
  for (const prefix of ['\x1b[48;2;48;48;48m' + FG, BG + '\x1b[7m', BG + '\x1b[48;5;24m', BG + '\x1b[44m']) {
    const row = '\x1b[0m' + prefix + blanks;
    assert.equal(paintPond(row, y, pond, BLACK, COLS), row, JSON.stringify(prefix));
  }
  // the theme background itself is not "explicit": fish still show on it
  const plain = '\x1b[0m' + BG + FG + blanks;
  assert.notEqual(paintPond(plain, y, pond, BLACK, COLS), plain);
});

test('text over a fish is tinted faintly while blank cells are strong', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const y = fishRow(pond);
  let col = 0;
  while (!pond.rgbAt(col, 2 * y) && !pond.rgbAt(col, 2 * y + 1)) col++;
  const build = (ch: string): string => '\x1b[0m' + BG + FG + ' '.repeat(col) + ch + ' '.repeat(5);
  const firstColour = (row: string): number => {
    const painted = paintPond(row, y, pond, BLACK, COLS).slice(('\x1b[0m' + BG + FG + ' '.repeat(col)).length);
    const m = painted.match(/\x1b\[[0-9;]*?(?:38|48);2;(\d+);(\d+);(\d+)/);
    assert.ok(m, 'no fish colour emitted');
    return Math.max(Number(m[1]), Number(m[2]), Number(m[3]));
  };
  assert.ok(firstColour(build(' ')) > firstColour(build('X')));
});

test('copying a row with a fish only ever adds half-block glyphs and blanks', () => {
  const pond = newPond({ seed: 7, count: 5 });
  swim(pond, 8);
  const row = '\x1b[0m' + BG + FG + 'plain text here' + '\x1b[0m' + BG + '\x1b[K';
  for (let y = 0; y < pond.height / 2; y++) {
    const painted = paintPond(row, y, pond, BLACK, COLS);
    assert.ok(text(painted).startsWith('plain text here'));
    assert.equal([...visible(painted)].length, pond.rowHasPixels(y) ? COLS : 'plain text here'.length);
  }
});

test('wide characters keep column accounting correct', () => {
  const pond = newPond({ seed: 1, count: 4 });
  const y = fishRow(pond);
  const row = '\x1b[0m' + BG + FG + '日本語 text ' + ' '.repeat(20) + '\x1b[0m' + BG + '\x1b[K';
  const painted = paintPond(row, y, pond, BLACK, 100);
  assert.ok(visible(painted).startsWith('日本語 text'));
  assert.equal([...visible(painted)].reduce((w, ch) => w + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0), 100);
});
