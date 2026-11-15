import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Terminal } from '@xterm/headless';
import { createClaudeAdapter } from '../src/adapters/claude';
import { createCodexAdapter } from '../src/adapters/codex';
import { createDevinAdapter } from '../src/adapters/devin';
import { createAdapters, isCommandAvailable, selectAdapters } from '../src/adapters/registry';
import { InputHandler } from '../src/input';
import { DesktopNotifier } from '../src/notify';
import { Session } from '../src/session';
import { SessionManager, SidebarEntry } from '../src/sessionManager';
import { TagStore } from '../src/tags';
import { Renderer, SIDEBAR_W } from '../src/ui/renderer';

const CMD_ENVS = ['ENVOY_CMD', 'ENVOY_CLAUDE_CMD', 'ENVOY_CODEX_CMD'] as const;

/**
 * Runs a callback with the per-CLI command env vars cleared, restoring them afterwards, so
 * results do not depend on the developer's shell.
 * @param fn Callback to run.
 * @returns The callback's result.
 */
async function withCleanCommandEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = CMD_ENVS.map((name) => [name, process.env[name]] as const);
  for (const name of CMD_ENVS) delete process.env[name];
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeExecutable(file: string, body = '#!/bin/sh\nexit 0\n'): string {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755); // `mode` on write only applies to newly created files
  return file;
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

test('TagStore.adapterSettings validates the config and survives later writes', () => {
  const dir = tmpDir('envoy-p5-config-');
  try {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      tags: ['code'],
      enabled_adapters: ['claude', 'bogus', 'claude', 'codex', 7],
      default_adapter: 'codex',
      adapter_commands: { claude: ' ~/bin/claude ', codex: '', bogus: 'x', devin: 5 },
    }));
    const store = new TagStore(configPath);
    assert.deepEqual(store.adapterSettings, {
      enabled: ['claude', 'codex'],
      default: 'codex',
      commands: { claude: path.join(os.homedir(), 'bin/claude') },
    });

    store.setSessionAlias('some-session', 'triggers a config write');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.enabled_adapters, ['claude', 'bogus', 'claude', 'codex', 7], 'unrelated keys are written back untouched');
    assert.equal(saved.default_adapter, 'codex');

    for (const config of [
      {},
      { enabled_adapters: 'claude', default_adapter: 'nope', adapter_commands: ['claude'] },
      { enabled_adapters: [], default_adapter: 5, adapter_commands: {} },
      { enabled_adapters: ['nothing', 'valid'] },
    ]) {
      fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'], ...config }));
      assert.deepEqual(new TagStore(configPath).adapterSettings, {}, JSON.stringify(config));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('selectAdapters enables only installed CLIs unless the config lists them', async () => {
  await withCleanCommandEnv(() => {
    const bin = tmpDir('envoy-p5-bin-');
    const empty = tmpDir('envoy-p5-empty-');
    try {
      fakeExecutable(path.join(bin, 'claude'));
      fakeExecutable(path.join(bin, 'codex'));
      fs.writeFileSync(path.join(bin, 'devin'), '#!/bin/sh\n');
      fs.chmodSync(path.join(bin, 'devin'), 0o644); // present but not executable

      const auto = selectAdapters({}, bin);
      assert.deepEqual(auto.adapters.map((a) => a.id), ['claude', 'codex'], 'only executables found on PATH');
      assert.equal(auto.defaultAdapterId, 'claude', 'Devin is not enabled, so the first enabled CLI is the default');

      fakeExecutable(path.join(bin, 'devin'));
      const all = selectAdapters({}, bin);
      assert.deepEqual(all.adapters.map((a) => a.id), ['devin', 'claude', 'codex']);
      assert.equal(all.defaultAdapterId, 'devin');

      const none = selectAdapters({}, empty);
      assert.deepEqual(none.adapters.map((a) => a.id), ['devin'], 'with nothing installed Devin stays so the app still starts');
      assert.equal(none.defaultAdapterId, 'devin');

      const explicit = selectAdapters({ enabled: ['codex', 'devin'] }, empty);
      assert.deepEqual(explicit.adapters.map((a) => a.id), ['devin', 'codex'], 'explicit list wins over PATH and keeps canonical order');

      assert.equal(selectAdapters({ default: 'codex' }, bin).defaultAdapterId, 'codex');
      assert.equal(selectAdapters({ default: 'codex', enabled: ['claude'] }, bin).defaultAdapterId, 'claude', 'default that is not enabled falls back');
      assert.equal(selectAdapters({ default: 'claude', enabled: ['devin', 'claude'] }, bin).defaultAdapterId, 'claude');
      assert.equal(selectAdapters({ default: 'claude', enabled: ['devin', 'codex'] }, bin).defaultAdapterId, 'devin');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

test('config commands override the executable, are used for detection, and lose to env vars', async () => {
  await withCleanCommandEnv(() => {
    const bin = tmpDir('envoy-p5-cmd-');
    const empty = tmpDir('envoy-p5-empty-');
    try {
      const custom = fakeExecutable(path.join(bin, 'my-claude'));
      const selection = selectAdapters({ commands: { claude: custom } }, empty);
      assert.deepEqual(selection.adapters.map((a) => a.id), ['claude'], 'an explicit executable path counts as installed');
      assert.equal(selection.adapters[0].command(), custom);

      process.env.ENVOY_CLAUDE_CMD = '/env/wins';
      assert.equal(selection.adapters[0].command(), '/env/wins');
      delete process.env.ENVOY_CLAUDE_CMD;

      const commands = { devin: 'd', claude: 'c', codex: 'x' };
      assert.deepEqual(createAdapters(commands).map((a) => a.command()), ['d', 'c', 'x']);
      assert.deepEqual(createAdapters().map((a) => a.command()), ['devin', 'claude', 'codex']);

      assert.equal(isCommandAvailable(custom), true);
      assert.equal(isCommandAvailable(path.join(bin, 'missing')), false);
      assert.equal(isCommandAvailable(bin), false, 'a directory is not a command');
      assert.equal(isCommandAvailable(''), false);
      assert.equal(isCommandAvailable('my-claude', bin), true);
      assert.equal(isCommandAvailable('my-claude', empty), false);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

/**
 * Builds a real manager with Devin and Claude adapters that spawn fake long-running commands
 * which log their arguments.
 * @param options Which CLI is the default.
 * @returns Manager, input handler and per-CLI argument logs.
 */
function makeLiveFixture(options: { defaultAdapterId?: 'devin' | 'claude' | 'codex'; clis?: Array<'devin' | 'claude' | 'codex'> } = {}): {
  root: string;
  manager: SessionManager;
  input: InputHandler;
  logs: Record<'devin' | 'claude' | 'codex', string>;
  cleanup: () => Promise<void>;
} {
  const root = tmpDir('envoy-p5-live-');
  const logs = { devin: path.join(root, 'devin.log'), claude: path.join(root, 'claude.log'), codex: path.join(root, 'codex.log') };
  const script = (name: 'devin' | 'claude' | 'codex'): string => fakeExecutable(path.join(root, `fake-${name}`), `#!/bin/sh\nprintf 'args:%s\\n' "$*" >> "${logs[name]}"\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n`);
  const factories = {
    devin: () => createDevinAdapter({ command: script('devin') }),
    claude: () => createClaudeAdapter({ configDir: root, command: script('claude') }),
    codex: () => createCodexAdapter({ codexHome: root, command: script('codex') }),
  };
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ tags: ['code', 'chat'] }));
  const adapters = (options.clis ?? ['devin', 'claude']).map((id) => factories[id]());
  const manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false), adapters, options.defaultAdapterId);
  const input = new InputHandler(manager, () => {}, () => {}, false, () => {}, root);
  return {
    root, manager, input, logs,
    cleanup: async () => {
      manager.killAll();
      for (const session of manager.sessions) session.term.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const waitForFile = async (file: string): Promise<string> => {
  for (let i = 0; i < 160 && !fs.existsSync(file); i++) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  return fs.readFileSync(file, 'utf8').trim();
};

test('new sessions use the default CLI, and an explicit default overrides Devin', async () => {
  await withCleanCommandEnv(async () => {
    const devinDefault = makeLiveFixture();
    try {
      assert.equal(devinDefault.manager.defaultAdapterId, 'devin');
      const s = devinDefault.manager.create(devinDefault.root, 'one', 'code', undefined, { attach: false });
      assert.equal(s.adapterId, 'devin');
      assert.equal(await waitForFile(devinDefault.logs.devin), 'args:');
    } finally {
      await devinDefault.cleanup();
    }
    const claudeDefault = makeLiveFixture({ defaultAdapterId: 'claude' });
    try {
      assert.equal(claudeDefault.manager.defaultAdapterId, 'claude');
      const s = claudeDefault.manager.create(claudeDefault.root, 'one', 'code', undefined, { attach: false });
      assert.equal(s.adapterId, 'claude');
      await waitForFile(claudeDefault.logs.claude);
      assert.equal(fs.existsSync(claudeDefault.logs.devin), false);
    } finally {
      await claudeDefault.cleanup();
    }
    const noDevin = makeLiveFixture({ clis: ['claude', 'codex'], defaultAdapterId: 'devin' });
    try {
      assert.equal(noDevin.manager.defaultAdapterId, 'claude', 'a default that is not enabled falls back to the first CLI');
    } finally {
      await noDevin.cleanup();
    }
  });
});

test('the n form picks the CLI with the arrow keys and the choice reaches the spawned session', async () => {
  await withCleanCommandEnv(async () => {
    const fx = makeLiveFixture({ clis: ['devin', 'claude', 'codex'] });
    try {
      const press = (...keys: string[]): void => keys.forEach((key) => fx.input.handle(key));
      press('n');
      assert.equal(fx.input.mode, 'form');
      assert.equal(fx.input.form?.adapterId, 'devin', 'preselects the default CLI');
      press('\x1b[C');
      assert.equal(fx.input.form?.adapterId, 'claude');
      press('\x1b[C', '\x1b[C');
      assert.equal(fx.input.form?.adapterId, 'devin', 'wraps around to the first CLI');
      press('\x1b[D');
      assert.equal(fx.input.form?.adapterId, 'codex', 'left wraps to the last CLI');
      press('\x1b[D');
      assert.equal(fx.input.form?.adapterId, 'claude');
      assert.equal(fx.input.form?.cwd, fx.root, 'arrow keys never edit the text fields');
      press('\t', '\x1b[C');
      assert.equal(fx.input.form?.adapterId, 'codex', 'works from either field');
      assert.equal(fx.input.form?.name, '');

      press('\r'); // Tab moved to the last field, so Enter submits
      assert.equal(fx.input.mode, 'tag-picker');
      press('\r');
      assert.equal(fx.manager.sessions.length, 1);
      assert.equal(fx.manager.sessions[0].adapterId, 'codex');
      assert.equal(await waitForFile(fx.logs.codex), 'args:');
      assert.equal(fs.existsSync(fx.logs.devin) || fs.existsSync(fx.logs.claude), false, 'only the chosen CLI runs');
    } finally {
      await fx.cleanup();
    }
  });
});

test('with a single CLI the form ignores arrow keys and creates that CLI', async () => {
  await withCleanCommandEnv(async () => {
    const fx = makeLiveFixture({ clis: ['claude'] });
    try {
      fx.input.handle('n');
      assert.equal(fx.input.form?.adapterId, 'claude');
      fx.input.handle('\x1b[C');
      fx.input.handle('\x1b[D');
      assert.equal(fx.input.form?.adapterId, 'claude');
      fx.input.handle('\r');
      fx.input.handle('\r');
      fx.input.handle('\r');
      assert.equal(fx.manager.sessions[0].adapterId, 'claude');
      await waitForFile(fx.logs.claude);
    } finally {
      await fx.cleanup();
    }
  });
});

test('badgeFor is hidden for a single CLI and shown for several', async () => {
  await withCleanCommandEnv(async () => {
    const single = makeLiveFixture({ clis: ['claude'] });
    const multi = makeLiveFixture({ clis: ['devin', 'claude', 'codex'] });
    try {
      assert.equal(single.manager.badgeFor('claude'), '');
      assert.deepEqual(['devin', 'claude', 'codex'].map((id) => multi.manager.badgeFor(id as 'devin')), ['DV', 'CL', 'CX']);
      assert.equal(new SessionManager(single.root, [single.root], new TagStore(path.join(single.root, 'config.json')), () => {}, new DesktopNotifier(false), [createDevinAdapter()]).badgeFor('devin'), '');
    } finally {
      await single.cleanup();
      await multi.cleanup();
    }
  });
});

/**
 * Builds a renderer over a stub manager that has several CLIs enabled.
 * @returns Renderer plus the stub pieces tests tweak.
 */
function makeRendererFixture(): { renderer: Renderer; input: InputHandler; manager: SessionManager; entries: SidebarEntry[]; dispose: () => void } {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  const active = {
    id: 'owned', name: 'active one', cwd: '/Users/example/work/api', tag: 'code', term: terminal, adapterId: 'claude', cliSessionId: null,
    memoryBytes: 700 * 1024 ** 2, status: 'waiting', unread: [], exited: false, scrollOffset: 0,
  } as unknown as Session;
  const entries: SidebarEntry[] = [
    { kind: 'active', session: active },
    { kind: 'external', external: { adapterId: 'codex', pid: 9, sessionId: 'x', cwd: '/Users/example/work/web', title: 'external one', lastAgo: '', memoryBytes: 300 * 1024 ** 2 } },
    { kind: 'recent', recent: { adapterId: 'devin', sessionId: 'r', cwd: '/Users/example/work/old', title: 'recent one', lastAgo: '5m ago', lastActivityAt: 0 } },
  ];
  const adapters = [{ id: 'devin', label: 'Devin', badge: 'DV' }, { id: 'claude', label: 'Claude', badge: 'CL' }, { id: 'codex', label: 'Codex', badge: 'CX' }];
  const manager = {
    entries, selected: 0, attachedId: null, sessions: [active], lastPromptAt: Date.now() - 190_000,
    discovery: { recents: [], totalMemoryBytes: 1400 * 1024 ** 2, memoryByAdapter: new Map([['claude', 700 * 1024 ** 2], ['codex', 300 * 1024 ** 2], ['devin', 400 * 1024 ** 2]]) },
    adapters,
    badgeFor: (id: string): string => adapters.find((a) => a.id === id)?.badge ?? '',
    tagStore: { tags: ['code'] }, recentVisible: true, moveState: null,
    get attachedSession(): Session | undefined { return undefined; },
    get selectedSession(): Session | undefined { return active; },
    displayName: (target: SidebarEntry | Session): string => ('kind' in target ? (target.kind === 'active' ? target.session.name : target.kind === 'external' ? target.external.title : target.recent.title) : target.name),
  } as unknown as SessionManager;
  const input = { mode: 'sidebar', attachedMode: 'normal', notice: '', confirm: null, form: null, rename: null, tagPicker: null, tagName: null, tagPosition: null } as unknown as InputHandler;
  return { renderer: new Renderer(manager, input, os.homedir()), input, manager, entries, dispose: () => terminal.dispose() };
}

test('sidebar rows carry a CLI badge in every section when several CLIs are enabled', () => {
  const fx = makeRendererFixture();
  try {
    const renderer = fx.renderer as unknown as { sidebarLines: (height: number) => string[] };
    const plain = renderer.sidebarLines(30).map(stripAnsi);
    assert.equal(plain.every((line) => line.length === SIDEBAR_W), true, 'badges never break the fixed sidebar width');
    const active = plain.find((line) => line.includes('700 MB'));
    const external = plain.find((line) => line.includes('300 MB'));
    const recent = plain.find((line) => line.includes('5m ago'));
    assert.match(active ?? '', /700 MB · CL\s*$/);
    assert.match(external ?? '', /300 MB · CX\s*$/);
    assert.match(recent ?? '', /5m ago · DV\s*$/);

    // a long directory is shortened to leave room for the badge instead of pushing it out
    (fx.entries[0] as { session: { cwd: string } }).session.cwd = '/Users/example/a/very/long/project/directory/path/that/never/fits';
    const longPlain = renderer.sidebarLines(30).map(stripAnsi);
    assert.equal(longPlain.every((line) => line.length === SIDEBAR_W), true);
    assert.match(longPlain.find((line) => line.includes('700 MB')) ?? '', /700 MB · CL\s*$/);
  } finally {
    fx.dispose();
  }
});

test('the status bar breaks memory down per CLI and drops the breakdown when space is tight', () => {
  const fx = makeRendererFixture();
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  try {
    const renderer = fx.renderer as unknown as { frame: () => string; invalidate: () => void };
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 160 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    renderer.invalidate();
    const wide = stripAnsi(renderer.frame());
    assert.equal(wide.includes('PROMPT 3m ago · AGENTS 1.4 GB (DV 400 MB · CL 700 MB · CX 300 MB)'), true);

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 60 });
    renderer.invalidate();
    const narrow = stripAnsi(renderer.frame());
    assert.equal(narrow.includes('AGENTS 1.4 GB'), true);
    assert.equal(narrow.includes('DV 400 MB'), false, 'the total stays, the breakdown goes');

    (fx.manager.discovery as unknown as { memoryByAdapter: Map<string, number> }).memoryByAdapter = new Map([['codex', 300 * 1024 ** 2], ['claude', 0]]);
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 160 });
    renderer.invalidate();
    const partial = stripAnsi(renderer.frame());
    assert.equal(partial.includes('AGENTS 1.4 GB (CX 300 MB)'), true, 'only CLIs with live REPLs are listed');
  } finally {
    if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
    if (rowsDescriptor) Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    fx.dispose();
  }
});

test('the new-session form shows the CLI picker only when several CLIs are enabled', () => {
  const fx = makeRendererFixture();
  try {
    const renderer = fx.renderer as unknown as { formLines: (width: number) => string[] };
    fx.input.form = { field: 0, cwd: '/tmp', name: '', error: '', adapterId: 'claude' };
    const multi = renderer.formLines(80).map(stripAnsi);
    assert.equal(multi.some((line) => line.includes('CLI (← / → to change):')), true);
    assert.equal(multi.some((line) => line.includes('Devin') && line.includes('[Claude]') && line.includes('Codex')), true, 'selected CLI is bracketed');

    (fx.manager as unknown as { adapters: unknown[] }).adapters = [{ id: 'claude', label: 'Claude', badge: 'CL' }];
    const single = renderer.formLines(80).map(stripAnsi);
    assert.equal(single.some((line) => line.includes('CLI')), false);
    assert.equal(single.some((line) => line.includes('Working directory')), true);
  } finally {
    fx.dispose();
  }
});
