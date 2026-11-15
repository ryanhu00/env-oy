import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createClaudeAdapter } from '../src/adapters/claude';
import { createCodexAdapter } from '../src/adapters/codex';
import { createDevinAdapter } from '../src/adapters/devin';
import type { AdapterId, CliAdapter, RecentSession } from '../src/adapters/types';
import { DEFAULT_RECENT_LIMIT, Discovery, pickRecents } from '../src/discovery';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

const NOW = Date.now() / 1000;

/** Builds a recent session `minutesAgo` minutes old. */
function recent(adapterId: AdapterId, n: number, minutesAgo: number): RecentSession {
  return { adapterId, sessionId: `${adapterId}-${n}`, cwd: '/work', title: `${adapterId} ${n}`, lastAgo: '', lastActivityAt: NOW - minutesAgo * 60 };
}

const ids = (list: readonly RecentSession[]): string[] => list.map((s) => s.sessionId);

test('pickRecents keeps the newest sessions for a single CLI', () => {
  const list = [recent('devin', 1, 50), recent('devin', 2, 10), recent('devin', 3, 30), recent('devin', 4, 20)];
  assert.deepEqual(ids(pickRecents(list, 3)), ['devin-2', 'devin-4', 'devin-3']);
  assert.deepEqual(ids(pickRecents(list, 10)), ['devin-2', 'devin-4', 'devin-3', 'devin-1'], 'fewer candidates than slots');
  assert.deepEqual(pickRecents(list, 0), []);
  assert.deepEqual(pickRecents([], 5), []);
});

test('pickRecents deals slots across CLIs so a busy CLI cannot crowd out the others', () => {
  const busy = Array.from({ length: 12 }, (_, i) => recent('codex', i, 1 + i)); // newest 12 sessions are all Codex
  const list = [...busy, recent('claude', 1, 200), recent('devin', 1, 300)];
  const picked = pickRecents(list, 6);
  assert.equal(picked.length, 6);
  assert.deepEqual(new Set(picked.map((s) => s.adapterId)), new Set(['codex', 'claude', 'devin']), 'every CLI is represented');
  assert.deepEqual(ids(picked), ['codex-0', 'codex-1', 'codex-2', 'codex-3', 'claude-1', 'devin-1'], 'result is newest first');

  // the old behaviour would have returned six Codex rows
  assert.equal([...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 6).every((s) => s.adapterId === 'codex'), true);
});

test('pickRecents hands unused slots to whichever CLI has more', () => {
  const list = [recent('claude', 1, 5), recent('codex', 1, 6), recent('codex', 2, 7), recent('codex', 3, 8), recent('codex', 4, 9), recent('devin', 1, 10)];
  assert.deepEqual(ids(pickRecents(list, 5)), ['claude-1', 'codex-1', 'codex-2', 'codex-3', 'devin-1']);
  assert.equal(pickRecents(list, 5).filter((s) => s.adapterId === 'codex').length, 3, 'Claude and Devin are exhausted after one row, so Codex takes the rest');
  assert.equal(pickRecents(list, 20).length, 6);
  assert.deepEqual(ids(pickRecents(list, 2)), ['claude-1', 'codex-1'], 'with 2 slots the CLIs with the newest sessions go first');
});

test('pickRecents does not mutate its input', () => {
  const list = [recent('codex', 1, 30), recent('claude', 1, 10), recent('codex', 2, 20)];
  const copy = list.map((s) => ({ ...s }));
  pickRecents(list, 2);
  assert.deepEqual(list, copy);
});

test('TagStore.recentLimit accepts whole numbers from 1 to 100 and defaults otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-p6-limit-'));
  try {
    const configPath = path.join(dir, 'config.json');
    const limitFor = (value: unknown): number => {
      fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'], ...(value === undefined ? {} : { recent_limit: value }) }));
      return new TagStore(configPath).recentLimit;
    };
    assert.equal(DEFAULT_RECENT_LIMIT, 10);
    assert.equal(limitFor(undefined), 10);
    assert.equal(limitFor(3), 3);
    assert.equal(limitFor(1), 1);
    assert.equal(limitFor(100), 100);
    for (const bad of [0, -2, 101, 2.5, '5', null, true, [], {}]) assert.equal(limitFor(bad), 10, JSON.stringify(bad));

    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'], recent_limit: 4 }));
    const store = new TagStore(configPath);
    store.setSessionAlias('some-session', 'triggers a config write');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).recent_limit, 4, 'later writes keep the setting');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A catalog-only adapter: no processes, just a fixed list of resumable sessions. */
function catalogAdapter(id: AdapterId, sessions: RecentSession[]): CliAdapter {
  return {
    id, label: id, badge: id.slice(0, 2).toUpperCase(), sessionIdChanges: false,
    command: () => id, freshArgs: () => [], resumeArgs: (sessionId) => ['resume', sessionId],
    isReplProcess: () => false,
    resolveProcesses: async () => new Map(),
    refreshCatalog: async () => ({ fallbackActive: false }),
    catalog: () => sessions,
    catalogEntry: (sessionId) => sessions.find((s) => s.sessionId === sessionId),
  };
}

test('Discovery applies the configured RECENT limit fairly across CLIs', async () => {
  const adapters = [
    catalogAdapter('devin', [recent('devin', 1, 300)]),
    catalogAdapter('claude', [recent('claude', 1, 200)]),
    catalogAdapter('codex', Array.from({ length: 12 }, (_, i) => recent('codex', i, 1 + i))),
  ];
  const poll = async (limit?: number): Promise<string[]> => {
    const discovery = new Discovery(() => new Set(), () => new Set(), [], () => {}, () => {}, adapters, limit);
    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    return ids(discovery.recents);
  };
  assert.deepEqual(await poll(), ['codex-0', 'codex-1', 'codex-2', 'codex-3', 'codex-4', 'codex-5', 'codex-6', 'codex-7', 'claude-1', 'devin-1'], 'default of 10 still shows every CLI');
  assert.deepEqual(await poll(4), ['codex-0', 'codex-1', 'claude-1', 'devin-1']);
  assert.deepEqual(await poll(1), ['codex-0']);
});

/**
 * Builds a manager over all three CLIs whose fake executables log their arguments.
 * @param root Shared scratch directory.
 * @param label Prefix that keeps each manager's logs separate.
 * @param clis CLIs to enable.
 * @returns The manager and the log path for each CLI.
 */
function makeManager(root: string, label: string, clis: AdapterId[]): { manager: SessionManager; logs: Record<AdapterId, string> } {
  const logs = { devin: path.join(root, `${label}-devin.log`), claude: path.join(root, `${label}-claude.log`), codex: path.join(root, `${label}-codex.log`) };
  const script = (id: AdapterId): string => {
    const file = path.join(root, `${label}-fake-${id}`);
    fs.writeFileSync(file, `#!/bin/sh\nprintf 'args:%s\\n' "$*" >> "${logs[id]}"\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const factories: Record<AdapterId, () => CliAdapter> = {
    devin: () => createDevinAdapter({ command: script('devin') }),
    claude: () => createClaudeAdapter({ configDir: root, command: script('claude') }),
    codex: () => createCodexAdapter({ codexHome: root, command: script('codex') }),
  };
  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ tags: ['code', 'chat'] }));
  return { manager: new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false), clis.map((id) => factories[id]())), logs };
}

const waitForLine = async (file: string): Promise<string> => {
  for (let i = 0; i < 160 && !fs.existsSync(file); i++) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
};

test('an in-app refresh restores sessions of every CLI, including the same id used by different CLIs', async () => {
  const saved = ['ENVOY_CMD', 'ENVOY_CLAUDE_CMD', 'ENVOY_CODEX_CMD'].map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-p6-restart-'));
  const managers: SessionManager[] = [];
  try {
    const SAME = '019e7480-d2ba-77c3-914a-cdd5da40550d';
    const before = makeManager(root, 'before', ['devin', 'claude', 'codex']);
    managers.push(before.manager);
    for (const id of ['devin', 'claude', 'codex'] as AdapterId[]) before.manager.create(root, `${id} one`, 'code', SAME, { attach: false, adapterId: id });
    const state = before.manager.getRestartState();
    assert.deepEqual(state.sessions.map((s) => [s.adapterId, s.cliSessionId]), [['devin', SAME], ['claude', SAME], ['codex', SAME]]);
    // the handoff goes through JSON on disk, like the real launcher channel
    const roundTripped = JSON.parse(JSON.stringify(state));

    const after = makeManager(root, 'after', ['devin', 'claude', 'codex']);
    managers.push(after.manager);
    const restored = after.manager.restoreRestartState(roundTripped);
    assert.deepEqual(restored.map((s) => s.adapterId), ['devin', 'claude', 'codex']);
    assert.deepEqual(restored.map((s) => after.manager.keyOf(s)), [SAME, `claude:${SAME}`, `codex:${SAME}`], 'identical ids stay distinct per CLI');
    assert.equal(await waitForLine(after.logs.devin), `args:-r ${SAME}`);
    assert.equal(await waitForLine(after.logs.claude), `args:--resume ${SAME}`);
    assert.equal(await waitForLine(after.logs.codex), `args:resume ${SAME}`);
  } finally {
    for (const manager of managers) {
      manager.killAll();
      for (const session of manager.sessions) session.term.dispose();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});

test('restoring a session whose CLI is no longer enabled skips only that session', async () => {
  const saved = ['ENVOY_CMD', 'ENVOY_CLAUDE_CMD', 'ENVOY_CODEX_CMD'].map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-p6-disabled-'));
  const managers: SessionManager[] = [];
  try {
    const before = makeManager(root, 'before', ['devin', 'claude', 'codex']);
    managers.push(before.manager);
    before.manager.create(root, 'devin one', 'code', 'd-1', { attach: false, adapterId: 'devin' });
    before.manager.create(root, 'codex one', 'code', 'c-1', { attach: false, adapterId: 'codex' });
    before.manager.create(root, 'claude one', 'chat', 'cl-1', { attach: false, adapterId: 'claude' });
    const state = JSON.parse(JSON.stringify(before.manager.getRestartState()));
    assert.equal(state.sessions.length, 3);

    const after = makeManager(root, 'after', ['devin', 'claude']); // Codex disabled in the meantime
    managers.push(after.manager);
    let restored: Array<{ adapterId: AdapterId }> = [];
    assert.doesNotThrow(() => { restored = after.manager.restoreRestartState(state); });
    assert.deepEqual(restored.map((s) => s.adapterId).sort(), ['claude', 'devin']);
    assert.equal(after.manager.sessions.length, 2);
    assert.equal(fs.existsSync(after.logs.codex), false, 'nothing is spawned for the disabled CLI');
  } finally {
    for (const manager of managers) {
      manager.killAll();
      for (const session of manager.sessions) session.term.dispose();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});
