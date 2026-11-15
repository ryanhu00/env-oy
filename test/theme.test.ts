import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { detectAppearance, forcedAppearance, parseColorFgBg, systemAppearance, type RunCommand } from '../src/ui/appearance';
import * as theme from '../src/ui/theme';

afterEach(() => theme.applyTheme('dark'));

const failing = (code: unknown): RunCommand => async () => {
  throw Object.assign(new Error('failed'), { code });
};
const printing = (out: string): RunCommand => async () => out;

test('applyTheme swaps every live color binding and defaults to dark', () => {
  const dark = { bg: theme.BG, fg: theme.FG, accent: theme.ACCENT, cursor: theme.CURSOR };
  assert.equal(theme.currentAppearance(), 'dark');
  theme.applyTheme('light');
  assert.equal(theme.currentAppearance(), 'light');
  assert.notEqual(theme.BG, dark.bg);
  assert.notEqual(theme.FG, dark.fg);
  assert.notEqual(theme.ACCENT, dark.accent);
  assert.notEqual(theme.CURSOR, dark.cursor);
  theme.applyTheme('dark');
  assert.equal(theme.BG, dark.bg);
});

test('light palette has a light background and a dark foreground', () => {
  const luma = (sgr: string): number => {
    const [r, g, b] = sgr.match(/;2;(\d+);(\d+);(\d+)m/)!.slice(1).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  theme.applyTheme('light');
  assert.equal(theme.BG, '\x1b[48;2;255;255;255m');
  assert.ok(luma(theme.FG) < 100);
  assert.ok(luma(theme.BG_SELECT) > 150);
  theme.applyTheme('dark');
  assert.equal(theme.BG, '\x1b[48;2;0;0;0m');
  assert.ok(luma(theme.FG) > 180);
});

test('macOS: AppleInterfaceStyle present = dark, exit 1 = light, missing tool = unknown', async () => {
  assert.equal(await systemAppearance('darwin', printing('Dark\n')), 'dark');
  assert.equal(await systemAppearance('darwin', failing(1)), 'light');
  assert.equal(await systemAppearance('darwin', failing('ENOENT')), undefined);
});

test('Linux: gsettings color-scheme is read, failures are unknown, other platforms unknown', async () => {
  assert.equal(await systemAppearance('linux', printing("'prefer-dark'\n")), 'dark');
  assert.equal(await systemAppearance('linux', printing("'prefer-light'\n")), 'light');
  assert.equal(await systemAppearance('linux', printing("'default'\n")), 'light');
  assert.equal(await systemAppearance('linux', failing('ENOENT')), undefined);
  assert.equal(await systemAppearance('win32', printing('whatever')), undefined);
});

test('COLORFGBG and ENVOY_THEME parsing', () => {
  assert.equal(parseColorFgBg('15;0'), 'dark');
  assert.equal(parseColorFgBg('0;15'), 'light');
  assert.equal(parseColorFgBg('0;default;7'), 'light');
  assert.equal(parseColorFgBg('15;8'), 'dark');
  assert.equal(parseColorFgBg('nonsense'), undefined);
  assert.equal(parseColorFgBg(undefined), undefined);
  assert.equal(forcedAppearance('LIGHT'), 'light');
  assert.equal(forcedAppearance(' dark '), 'dark');
  assert.equal(forcedAppearance('auto'), undefined);
  assert.equal(forcedAppearance(undefined), undefined);
});

test('detectAppearance: forced > system > COLORFGBG > dark', async () => {
  assert.equal(await detectAppearance({ ENVOY_THEME: 'light' }, 'darwin', printing('Dark')), 'light');
  assert.equal(await detectAppearance({ ENVOY_THEME: 'auto' }, 'darwin', printing('Dark')), 'dark');
  assert.equal(await detectAppearance({}, 'darwin', failing(1)), 'light');
  assert.equal(await detectAppearance({ COLORFGBG: '0;15' }, 'win32', failing('ENOENT')), 'light');
  assert.equal(await detectAppearance({}, 'win32', failing('ENOENT')), 'dark');
});
