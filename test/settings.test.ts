import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { createAdapters } from '../src/adapters/registry';
import type { AdapterId } from '../src/adapters/types';
import { InputHandler } from '../src/input';
import { AppSettings, type SettingsManager } from '../src/settings';
import { TagStore } from '../src/tags';
import { Renderer } from '../src/ui/renderer';
import { detectAppearance, type RunCommand } from '../src/ui/appearance';
import { applyTheme } from '../src/ui/theme';

const dirs: string[] = [];
afterEach(() => {
  applyTheme('dark');
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(options: { clis?: AdapterId[]; config?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-settings-'));
  dirs.push(root);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ tags: ['code', 'chat'], session_aliases: { abc: 'keep me' }, ...options.config }));
  const tagStore = new TagStore(configPath);
  const calls = { koi: [] as boolean[], koiCounts: [] as (number | undefined)[], themeChanges: 0, cwds: [] as string[], baseDirs: [] as string[][], refreshes: 0 };
  const adapters = createAdapters().filter((adapter) => (options.clis ?? ['devin', 'claude']).includes(adapter.id));
  const manager: SettingsManager & { defaultAdapterId: AdapterId } = {
    adapters,
    defaultAdapterId: adapters[0].id,
    discovery: {
      recentLimit: 10,
      setBaseDirs: (next: string[]) => void calls.baseDirs.push(next),
      refresh: () => void calls.refreshes++,
    },
    setDefaultAdapter(id) {
      this.defaultAdapterId = id;
    },
  };
  const notifier = { enabled: true };
  const settings = new AppSettings({
    tagStore,
    manager,
    notifier,
    launchDir: root,
    onDefaultCwd: (dir) => void calls.cwds.push(dir),
    onThemeChange: () => void calls.themeChanges++,
    onKoiChange: (enabled) => void calls.koi.push(enabled),
    onKoiCountChange: (count) => void calls.koiCounts.push(count),
  });
  const saved = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { root, tagStore, manager, notifier, settings, calls, saved };
}

test('rows list every setting in order with current values', () => {
  const { settings } = fixture();
  const rows = settings.rows();
  assert.deepEqual(rows.map((row) => row.id), ['theme', 'koi', 'koi_count', 'desktop_notifications', 'default_cwd', 'default_adapter', 'recent_limit', 'cli:devin', 'cli:claude', 'cli:codex']);
  const value = (id: string): string => rows.find((row) => row.id === id)!.value;
  assert.match(value('theme'), /^auto/);
  assert.equal(value('desktop_notifications'), 'on');
  assert.match(value('default_cwd'), /launch directory/);
  assert.equal(value('default_adapter'), 'Devin');
  assert.equal(value('recent_limit'), '10');
  assert.equal(value('cli:devin'), 'enabled');
  assert.equal(value('cli:codex'), 'disabled');
});

test('theme cycles auto > light > dark > auto, saves, and notifies; auto removes the key', () => {
  const { settings, saved, calls, tagStore } = fixture();
  assert.equal(settings.step('theme', 1), '');
  assert.equal(saved().theme, 'light');
  assert.equal(tagStore.theme, 'light');
  settings.step('theme', 1);
  assert.equal(saved().theme, 'dark');
  settings.step('theme', 1);
  assert.equal('theme' in saved(), false);
  assert.equal(tagStore.theme, 'auto');
  settings.step('theme', -1);
  assert.equal(saved().theme, 'dark');
  assert.equal(calls.themeChanges, 4);
});

test('saving a setting keeps every other key', () => {
  const { settings, saved } = fixture({ config: { custom_key: [1, 2], adapter_commands: { claude: '/x/claude' } } });
  settings.step('desktop_notifications', 1);
  settings.step('theme', 1);
  const config = saved();
  assert.deepEqual(config.tags, ['code', 'chat']);
  assert.deepEqual(config.session_aliases, { abc: 'keep me' });
  assert.deepEqual(config.custom_key, [1, 2]);
  assert.deepEqual(config.adapter_commands, { claude: '/x/claude' });
});

test('desktop notifications toggle applies live and persists', () => {
  const { settings, notifier, saved, tagStore } = fixture();
  settings.step('desktop_notifications', 1);
  assert.equal(notifier.enabled, false);
  assert.equal(saved().desktop_notifications, false);
  assert.equal(tagStore.desktopNotifications, false);
  settings.step('desktop_notifications', 1);
  assert.equal(notifier.enabled, true);
  assert.equal(saved().desktop_notifications, true);
});

test('koi toggle persists, defaults on, and notifies the renderer', () => {
  const { settings, saved, tagStore, calls } = fixture();
  assert.equal(tagStore.koi, true);
  settings.step('koi', 1);
  assert.equal(saved().koi, false);
  assert.equal(tagStore.koi, false);
  settings.step('koi', 1);
  assert.equal(saved().koi, true);
  assert.deepEqual(calls.koi, [false, true]);
  assert.equal(settings.rows().find((row) => row.id === 'koi')!.value, 'on');
});

test('koi count cycles auto, 1..12 (wrapping), persists, and is validated on read', () => {
  const { settings, saved, tagStore, calls } = fixture();
  assert.equal(tagStore.koiCount, undefined);
  assert.equal(settings.rows().find((row) => row.id === 'koi_count')!.value, 'auto');
  settings.step('koi_count', 1);
  assert.equal(saved().koi_count, 1);
  assert.equal(tagStore.koiCount, 1);
  settings.step('koi_count', -1); // back to auto removes the key
  assert.equal('koi_count' in saved(), false);
  settings.step('koi_count', -1); // wraps to the maximum
  assert.equal(saved().koi_count, 12);
  settings.step('koi_count', 1); // wraps to auto
  assert.equal(tagStore.koiCount, undefined);
  assert.deepEqual(calls.koiCounts, [1, undefined, 12, undefined]);
  for (const bad of [0, 13, 2.5, '3', null]) {
    const { tagStore: store } = fixture({ config: { koi_count: bad } });
    assert.equal(store.koiCount, undefined, JSON.stringify(bad));
  }
  assert.equal(fixture({ config: { koi_count: 7 } }).tagStore.koiCount, 7);
});

test('default CLI cycles through enabled CLIs only and persists', () => {
  const { settings, manager, saved } = fixture({ clis: ['devin', 'claude'] });
  settings.step('default_adapter', 1);
  assert.equal(manager.defaultAdapterId, 'claude');
  assert.equal(saved().default_adapter, 'claude');
  settings.step('default_adapter', 1);
  assert.equal(manager.defaultAdapterId, 'devin');
  settings.step('default_adapter', -1);
  assert.equal(manager.defaultAdapterId, 'claude');

  const single = fixture({ clis: ['codex'] });
  assert.match(single.settings.step('default_adapter', 1), /Only one CLI/);
  assert.equal('default_adapter' in single.saved(), false);
});

test('RECENT rows: arrows step within 1-100, typed values validate, changes apply to discovery', () => {
  const { settings, manager, calls, saved } = fixture();
  assert.equal(settings.step('recent_limit', 1), '');
  assert.equal(saved().recent_limit, 11);
  assert.equal(manager.discovery.recentLimit, 11);
  assert.equal(calls.refreshes, 1);
  assert.equal(settings.commit('recent_limit', ' 40 '), '');
  assert.equal(manager.discovery.recentLimit, 40);
  assert.equal(settings.commit('recent_limit', '100'), '');
  assert.match(settings.step('recent_limit', 1), /1 to 100/);
  assert.equal(saved().recent_limit, 100);
  assert.equal(settings.commit('recent_limit', '1'), '');
  assert.match(settings.step('recent_limit', -1), /1 to 100/);
  for (const bad of ['', 'abc', '0', '101', '2.5', '-3']) {
    assert.notEqual(settings.commit('recent_limit', bad), '', bad);
  }
  assert.equal(saved().recent_limit, 1);
  assert.equal(manager.discovery.recentLimit, 1);
});

test('default directory: valid saves and applies, invalid is rejected, blank resets to the launch dir', () => {
  const { settings, root, calls, saved, tagStore } = fixture();
  const target = fs.mkdtempSync(path.join(root, 'proj-'));
  assert.equal(settings.commit('default_cwd', ` ${target} `), '');
  assert.equal(saved().default_cwd, target);
  assert.equal(tagStore.defaultCwdSetting, target);
  assert.deepEqual(calls.cwds, [target]);
  assert.deepEqual(calls.baseDirs.at(-1), [target, root]);

  assert.match(settings.commit('default_cwd', path.join(root, 'nope')), /Not a directory/);
  assert.equal(saved().default_cwd, target);
  assert.equal(calls.cwds.length, 1);

  assert.equal(settings.commit('default_cwd', '~'), '');
  assert.equal(saved().default_cwd, '~');
  assert.equal(calls.cwds.at(-1), os.homedir());

  assert.equal(settings.commit('default_cwd', '   '), '');
  assert.equal('default_cwd' in saved(), false);
  assert.equal(calls.cwds.at(-1), root);
  assert.equal(settings.initialText('default_cwd'), '');
});

test('CLI toggles write an ordered enabled list, keep one CLI on, and flag the restart', () => {
  const { settings, saved } = fixture({ clis: ['devin', 'claude'] });
  assert.equal(settings.step('cli:codex', 1), '');
  assert.deepEqual(saved().enabled_adapters, ['devin', 'claude', 'codex']);
  assert.match(settings.rows().find((row) => row.id === 'cli:codex')!.note, /restart/i);
  assert.equal(settings.step('cli:devin', 1), '');
  assert.deepEqual(saved().enabled_adapters, ['claude', 'codex']);
  assert.equal(settings.step('cli:claude', 1), '');
  assert.match(settings.step('cli:codex', 1), /At least one/);
  assert.deepEqual(saved().enabled_adapters, ['codex']);
  // back to the running set: no restart note anymore
  settings.step('cli:devin', 1);
  settings.step('cli:claude', 1);
  settings.step('cli:codex', 1);
  assert.deepEqual(saved().enabled_adapters, ['devin', 'claude']);
  assert.doesNotMatch(settings.rows().find((row) => row.id === 'cli:devin')!.note, /restart/i);
});

test('settings screen keys: open, move, change, edit typed text (incl. capital H), close', () => {
  const { settings, saved, root } = fixture();
  const manager = { entries: [], adapters: [], defaultAdapterId: 'devin' } as never;
  const input = new InputHandler(manager, () => {}, () => {}, false, () => {}, root);
  input.handle(',');
  assert.equal(input.mode, 'sidebar');
  assert.match(input.notice, /unavailable/);

  input.settingsBackend = settings;
  input.handle(',');
  assert.equal(input.mode, 'settings');
  assert.equal(input.settings!.selected, 0);

  input.handle('\x1b[C'); // theme -> light
  assert.equal(saved().theme, 'light');
  assert.equal(input.settings!.message, 'Saved');
  input.handle('h'); // back to auto
  assert.equal('theme' in saved(), false);

  input.handle('j'); // koi pond
  input.handle('\r');
  assert.equal(saved().koi, false);
  input.handle('j'); // koi count
  input.handle('\x1b[C'); // auto -> 1
  assert.equal(saved().koi_count, 1);
  input.handle('j'); // notifications
  input.handle('\r'); // Enter toggles
  assert.equal(saved().desktop_notifications, false);

  input.handle('j'); // default directory
  input.handle('\r'); // opens editor
  assert.deepEqual(input.settings!.editing, { id: 'default_cwd', value: '' });
  const target = fs.mkdtempSync(path.join(root, 'Home-'));
  input.handle(target); // contains a capital H
  input.handle('\x15x\x7f'); // Ctrl-u clears, then x, then backspace
  assert.equal(input.settings!.editing!.value, '');
  input.handle('\r'); // blank = launch directory
  assert.equal(input.settings!.editing, null);
  assert.equal(input.defaultCwd, root);

  input.handle('\r');
  input.handle(`${target}Hx`);
  assert.equal(input.settings!.editing!.value, `${target}Hx`);
  input.handle('\r'); // not a directory
  assert.match(input.settings!.message, /Not a directory/);
  assert.equal(input.settings!.error, true);
  input.handle('\x1b'); // cancel edit
  assert.equal(input.mode, 'settings');
  assert.equal(input.settings!.editing, null);

  input.handle('G'); // last row
  assert.equal(input.settings!.selected, settings.rows().length - 1);
  input.handle('gg');
  assert.equal(input.settings!.selected, 0);
  input.handle('q');
  assert.equal(input.mode, 'sidebar');
  assert.equal(input.settings, null);
});

test('config theme sits between ENVOY_THEME and the system setting', async () => {
  const dark: RunCommand = async () => 'Dark\n';
  assert.equal(await detectAppearance({}, 'darwin', dark, 'light'), 'light');
  assert.equal(await detectAppearance({}, 'darwin', dark, 'auto'), 'dark');
  assert.equal(await detectAppearance({ ENVOY_THEME: 'dark' }, 'darwin', async () => 'x', 'light'), 'dark');
  assert.equal(await detectAppearance({ ENVOY_THEME: 'auto' }, 'darwin', dark, 'light'), 'light');
});

test('settings pane renders rows, the selected row note, the editor and the message', () => {
  const { settings, root } = fixture();
  const manager = { entries: [], adapters: [], defaultAdapterId: 'devin' } as never;
  const input = new InputHandler(manager, () => {}, () => {}, false, () => {}, root);
  input.settingsBackend = settings;
  input.handle(',');
  const renderer = new Renderer(manager, input, root);
  const plain = (): string => (renderer as unknown as { settingsLines(width: number): string[] }).settingsLines(90).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  let text = plain();
  for (const label of ['Settings', 'Theme', 'Desktop notifications', 'Default directory', 'Default CLI', 'RECENT rows', 'CLI: Devin', 'CLI: Claude', 'CLI: Codex']) assert.ok(text.includes(label), label);
  assert.ok(text.includes('› Theme'));
  assert.ok(text.includes('auto follows the system'));
  input.handle('\x1b[C');
  assert.ok(plain().includes('Saved'));
  input.handle('jjjj\r');
  text = plain();
  assert.ok(text.includes('❯ '));
  assert.ok(!text.includes('launch directory)\n'));
});
