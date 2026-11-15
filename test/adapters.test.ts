import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createDevinAdapter, isDevinReplCommand, parseLsofSessions } from '../src/adapters/devin';
import { parseLsofLocks, parsePsProcesses } from '../src/adapters/ps';
import { createAdapters } from '../src/adapters/registry';
import { ADAPTER_IDS, sessionKey } from '../src/adapters/types';
import type { AdapterId, CliAdapter, ProcessInfo, RecentSession } from '../src/adapters/types';
import { Discovery } from '../src/discovery';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

/**
 * Builds an in-memory adapter whose REPL binary, running sessions and catalog are fixed.
 * @param id Adapter id to claim.
 * @param binary Command-line prefix that identifies its REPL processes in `ps`.
 * @param running Session id and cwd by pid.
 * @param catalog Sessions the adapter reports as known.
 * @returns The adapter plus a log of the pids it was asked to resolve.
 */
function fakeAdapter(id: AdapterId, binary: string, running: Record<number, ProcessInfo>, catalog: RecentSession[]): { adapter: CliAdapter; resolved: number[][] } {
  const resolved: number[][] = [];
  const adapter: CliAdapter = {
    id,
    label: id,
    badge: id.slice(0, 2).toUpperCase(),
    sessionIdChanges: false,
    command: () => binary,
    freshArgs: () => [],
    resumeArgs: (sessionId) => ['--resume', sessionId],
    isReplProcess: (command) => command === binary || command.startsWith(`${binary} `),
    async resolveProcesses(pids) {
      resolved.push([...pids]);
      return new Map(pids.flatMap((pid): Array<[number, ProcessInfo]> => (running[pid] ? [[pid, running[pid]]] : [])));
    },
    async refreshCatalog() {
      return { fallbackActive: false };
    },
    catalog: () => catalog,
    catalogEntry: (sessionId) => catalog.find((entry) => entry.sessionId === sessionId),
  };
  return { adapter, resolved };
}

test('session keys keep Devin ids bare and namespace every other CLI', () => {
  assert.equal(sessionKey('devin', 'abc'), 'abc');
  assert.equal(sessionKey('claude', 'abc'), 'claude:abc');
  assert.equal(sessionKey('codex', 'abc'), 'codex:abc');
  assert.equal(new Set(ADAPTER_IDS.map((id) => sessionKey(id, 'same'))).size, ADAPTER_IDS.length);
});

test('registry exposes a fresh Devin adapter each call', () => {
  const [first] = createAdapters();
  const [second] = createAdapters();
  assert.equal(first.id, 'devin');
  assert.notEqual(first, second);
});

test('Devin adapter builds spawn args and honours ENVOY_CMD', () => {
  const adapter = createDevinAdapter();
  const previous = process.env.ENVOY_CMD;
  try {
    delete process.env.ENVOY_CMD;
    assert.equal(adapter.command(), 'devin');
    process.env.ENVOY_CMD = '/tmp/custom-devin';
    assert.equal(adapter.command(), '/tmp/custom-devin');
  } finally {
    if (previous === undefined) delete process.env.ENVOY_CMD;
    else process.env.ENVOY_CMD = previous;
  }
  assert.deepEqual(adapter.freshArgs(), []);
  assert.deepEqual(adapter.resumeArgs('sess-1'), ['-r', 'sess-1']);
  assert.equal(adapter.sessionIdChanges, false);
  assert.equal(adapter.isReplProcess('devin --flag'), true);
  assert.equal(isDevinReplCommand('devin auth'), false);
});

test('generic lock parser takes a per-CLI pattern', () => {
  const output = ['p10', 'fcwd', 'n/work', 'f9', 'n/home/u/.codex/thread-writer-locks/thr_1.lock', 'p11', 'f3', 'n/home/u/.devin/session_locks/dev-2.lock'].join('\n');
  const codex = parseLsofLocks(output, /\/thread-writer-locks\/([^/]+)\.lock$/);
  assert.deepEqual(codex.get(10), { cwd: '/work', sessionId: 'thr_1' });
  assert.deepEqual(codex.get(11), {});
  assert.deepEqual(parseLsofSessions(output).get(11), { sessionId: 'dev-2' });
  assert.equal(parseLsofSessions(output).get(10)?.sessionId, undefined);
});

test('ps parser filters by the supplied predicate only', () => {
  const output = ['  1 10 aone', '  2 20 atwo --x', '  3 30 aone list'].join('\n');
  assert.deepEqual(parsePsProcesses(output, (command) => command.startsWith('atwo')), [{ pid: 2, rssBytes: 20 * 1024 }]);
});

test('Discovery merges adapters: totals, per-adapter pids, namespaced keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-multi-discovery-'));
  const bin = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  const now = Date.now() / 1000;
  const recent = (adapterId: AdapterId, sessionId: string, lastActivityAt: number): RecentSession => ({ adapterId, sessionId, cwd: root, title: `${adapterId} ${sessionId}`, lastAgo: 'now', lastActivityAt });
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
cat <<'EOF'
  101 100 aone --owned
  202 200 aone
  303 300 atwo
  404 400 atwo --owned
  505 500 unrelated
EOF
`, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const one = fakeAdapter('devin', 'aone', { 101: { sessionId: 'dev-owned', cwd: root }, 202: { sessionId: 'same-id', cwd: root } }, [
      recent('devin', 'same-id', now - 10),
      recent('devin', 'dev-owned', now - 20),
      recent('devin', 'dev-old', now - 30),
    ]);
    const two = fakeAdapter('claude', 'atwo', { 303: { sessionId: 'cl-ext', cwd: root }, 404: { sessionId: 'cl-owned', cwd: root } }, [
      recent('claude', 'same-id', now - 5),
      recent('claude', 'cl-owned', now - 6),
      recent('claude', 'cl-stale', now - 7),
      recent('claude', 'cl-ext', now - 8),
      recent('claude', 'cl-resumed', now - 9),
      recent('claude', 'cl-ancient', now - 200000),
    ]);
    const updates: Array<Map<number, { sessionId?: string; memoryBytes: number }>> = [];
    const discovery = new Discovery(
      () => new Set([101, 404]),
      () => new Set([sessionKey('claude', 'cl-resumed')]),
      [root],
      (sample) => updates.push(sample),
      () => {},
      [one.adapter, two.adapter]
    );
    await (discovery as unknown as { poll: () => Promise<void> }).poll();

    assert.equal(discovery.totalMemoryBytes, 1000 * 1024);
    assert.deepEqual(one.resolved, [[101, 202]]);
    assert.deepEqual(two.resolved, [[303, 404]]);
    assert.deepEqual(discovery.externals.map((e) => [e.adapterId, e.pid, e.sessionId]), [['devin', 202, 'same-id'], ['claude', 303, 'cl-ext']]);
    assert.equal(discovery.externals[0].title, 'devin same-id');
    assert.equal(discovery.externals[1].title, 'claude cl-ext');
    assert.deepEqual([...updates[0]].sort(([a], [b]) => a - b), [[101, { memoryBytes: 100 * 1024, sessionId: 'dev-owned' }], [404, { memoryBytes: 400 * 1024, sessionId: 'cl-owned' }]]);
    // running rows (any adapter), app-owned keys and >24h rows are hidden; the claude row that
    // shares an id with a running devin session stays because its key is namespaced
    assert.deepEqual(discovery.recents.map((r) => sessionKey(r.adapterId, r.sessionId)), ['claude:same-id', 'claude:cl-stale', 'dev-old']);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SessionManager spawns through the adapter and persists namespaced keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-adapter-manager-'));
  const argsLog = path.join(root, 'args.log');
  const command = path.join(root, 'fake-cli');
  const previousCommand = process.env.ENVOY_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, `#!/bin/sh\nprintf 'args:%s\\n' "$*" >> "${argsLog}"\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    const claudeLike: CliAdapter = { ...fakeAdapter('claude', command, {}, []).adapter };
    const devin = { ...createDevinAdapter(), command: () => command };
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false), [devin, claudeLike]);

    const fresh = manager.create(root, 'fresh', 'code', undefined, { attach: false, adapterId: 'claude' });
    const resumed = manager.create(root, 'resumed', 'code', 'abc', { attach: false, adapterId: 'claude' });
    const devinResumed = manager.create(root, 'devin', 'code', 'abc', { attach: false });
    assert.equal(fresh.adapterId, 'claude');
    assert.equal(devinResumed.adapterId, 'devin');
    const logged = (): string[] => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').trim().split('\n') : []);
    for (let i = 0; i < 120 && logged().length < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(logged().sort(), ['args:', 'args:--resume abc', 'args:-r abc']);

    // same id under two CLIs yields two distinct persisted keys
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['claude:abc', 'abc']);
    assert.equal(manager.keyOf(resumed), 'claude:abc');
    assert.equal(manager.keyOf(devinResumed), 'abc');
    assert.equal(manager.keyOf(fresh), null);

    const state = manager.getRestartState();
    assert.deepEqual(state.sessions.map((s) => [s.adapterId, s.cliSessionId]), [['claude', 'abc'], ['devin', 'abc']]);

    const before = manager.sessions.length;
    assert.throws(() => manager.create(root, 'x', 'code', undefined, { adapterId: 'codex' }), /Unknown CLI adapter: codex/);
    assert.equal(manager.sessions.length, before);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previousCommand === undefined) delete process.env.ENVOY_CMD;
    else process.env.ENVOY_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
