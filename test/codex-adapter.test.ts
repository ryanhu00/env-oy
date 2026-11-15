import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createCodexAdapter, isCodexReplCommand, parseLsofCodexSessions } from '../src/adapters/codex';
import { createAdapters } from '../src/adapters/registry';
import { sessionKey } from '../src/adapters/types';
import { Discovery } from '../src/discovery';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

const ID = (n: number): string => `019e7480-d2ba-77c3-914a-${String(n).padStart(12, '0')}`;

function dayDir(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return path.join(String(date.getFullYear()), p(date.getMonth() + 1), p(date.getDate()));
}

/**
 * Creates an isolated Codex home with helpers for rollouts and the thread index.
 * @returns Paths and writers.
 */
function makeHome(): {
  root: string;
  rollout: (sessionId: string, records: unknown[], opts?: { ageSeconds?: number; daysAgo?: number }) => string;
  index: (rows: unknown[]) => void;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-codex-'));
  return {
    root,
    rollout: (sessionId, records, opts = {}) => {
      const dir = path.join(root, 'sessions', dayDir(new Date(Date.now() - (opts.daysAgo ?? 0) * 86400_000)));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-05-29T09-11-00-${sessionId}.jsonl`);
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const when = new Date(Date.now() - (opts.ageSeconds ?? 5) * 1000);
      fs.utimesSync(file, when, when);
      return file;
    },
    index: (rows) => fs.writeFileSync(path.join(root, 'session_index.jsonl'), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const meta = (id: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  timestamp: 't', type: 'session_meta', payload: { id, cwd, originator: 'codex-tui', source: 'cli', thread_source: 'user', base_instructions: { text: 'x'.repeat(30_000) }, ...extra },
});
const userMsg = (message: string): Record<string, unknown> => ({ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message, images: [] } });

test('isCodexReplCommand accepts the interactive TUI and rejects servers and subcommands', () => {
  for (const command of [
    'codex', '/Users/me/.local/bin/codex', 'codex resume 019e7480-d2ba-77c3-914a-cdd5da40550d', 'codex resume --last', 'codex fork', 'codex fix the exec bug',
    'codex -m gpt-5 -C /tmp', 'codex --model o3 "do things"', 'codex -c model="o3" resume abc', '/Users/me/.codex/packages/standalone/releases/0.135.0-aarch64-apple-darwin/bin/codex',
    'codex --search --no-alt-screen', 'codex -- exec',
  ]) {
    assert.equal(isCodexReplCommand(command), true, command);
  }
  for (const command of [
    'codex exec "hi"', 'codex e hi', 'codex review', 'codex login', 'codex mcp list', 'codex mcp-server', 'codex app-server', 'codex app-server --listen stdio://',
    '/Users/me/.cursor/extensions/openai.chatgpt-26.1111/bin/macos-aarch64/codex -c features.code_mode_host=true -c features.x=false app-server --analytics-default-enabled',
    'codex -m gpt-5 exec go', 'codex --version', 'codex -h', 'codex update', 'codex doctor', 'codex completion zsh', 'codex apply', 'codex cloud', 'codex exec-server', 'codex remote-control',
    'node /usr/lib/node_modules/@openai/codex/bin/codex.js', 'codex-helper --x', '/Applications/Codex.app/Contents/MacOS/Codex', 'grep codex', 'devin', '',
  ]) {
    assert.equal(isCodexReplCommand(command), false, command);
  }
});

test('Codex adapter builds spawn args and honours ENVOY_CODEX_CMD', () => {
  const adapter = createCodexAdapter({ codexHome: '/nonexistent' });
  const previous = process.env.ENVOY_CODEX_CMD;
  try {
    delete process.env.ENVOY_CODEX_CMD;
    assert.equal(adapter.command(), 'codex');
    process.env.ENVOY_CODEX_CMD = '/tmp/my-codex';
    assert.equal(adapter.command(), '/tmp/my-codex');
  } finally {
    if (previous === undefined) delete process.env.ENVOY_CODEX_CMD;
    else process.env.ENVOY_CODEX_CMD = previous;
  }
  assert.deepEqual(adapter.freshArgs(), []);
  assert.deepEqual(adapter.resumeArgs('abc'), ['resume', 'abc']);
  assert.equal(adapter.id, 'codex');
  assert.equal(adapter.badge, 'CX');
  assert.equal(adapter.sessionIdChanges, true);
});

test('parseLsofCodexSessions reads the session id from the open rollout and the cwd', () => {
  const out = [
    'p100', 'fcwd', 'n/work/api', 'f12', `n/Users/me/.codex/sessions/2026/05/29/rollout-2026-05-29T09-11-00-${ID(1)}.jsonl`, 'f13', 'n/Users/me/.codex/logs_2.sqlite',
    'p101', 'fcwd', 'n/work/other', 'f3', 'n/Users/me/.codex/tmp/arg0/codex-arg0abc/.lock',
    'p102', 'fcwd', 'n/work/third', 'f4', `n/private/tmp/rollout-notes-${ID(2)}.txt`,
  ].join('\n');
  const parsed = parseLsofCodexSessions(out);
  assert.deepEqual(parsed.get(100), { cwd: '/work/api', sessionId: ID(1) });
  assert.deepEqual(parsed.get(101), { cwd: '/work/other' }, 'no rollout open yet: no id');
  assert.deepEqual(parsed.get(102), { cwd: '/work/third' }, 'only rollout .jsonl files count');
});

test('rollout catalog derives cwd, title and age and skips non-interactive sessions', async () => {
  const home = makeHome();
  try {
    home.rollout(ID(1), [meta(ID(1), '/work/proj'), userMsg('  fix   the\nflaky test ' + 'x'.repeat(200))], { ageSeconds: 5 * 60 });
    home.rollout(ID(2), [meta(ID(2), '/work/proj'), userMsg('named in index')], { ageSeconds: 2 * 3600 });
    home.rollout(ID(3), [meta(ID(3), '/work/exec', { source: 'exec' }), userMsg('headless')]);
    home.rollout(ID(4), [meta(ID(4), '/work/sub', { source: { subagent: { thread_spawn: {} } } }), userMsg('child')]);
    home.rollout(ID(5), [meta(ID(5), '/work/sub', { thread_source: 'subagent' }), userMsg('child two')]);
    home.rollout(ID(6), [{ timestamp: 't', type: 'session_meta', payload: { id: ID(6) } }, userMsg('no cwd')]);
    home.rollout(ID(7), [meta(ID(7), '/work/proj'), userMsg('too old')], { ageSeconds: 25 * 3600 });
    home.rollout(ID(8), [meta(ID(8), '/work/proj')], { ageSeconds: 30 });
    home.rollout(ID(9), [meta(ID(9), 'relative/dir'), { timestamp: 't', type: 'turn_context', payload: { cwd: '/work/from-turn' } }, userMsg('cwd from turn')], { ageSeconds: 40 });
    home.rollout(ID(10), [meta(ID(10), '/work/proj'), userMsg('old folder, still active')], { ageSeconds: 10, daysAgo: 3 });
    home.rollout(ID(11), [meta(ID(11), '/work/proj'), userMsg('ancient folder')], { ageSeconds: 10, daysAgo: 40 });
    fs.writeFileSync(path.join(home.root, 'sessions', dayDir(new Date()), 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(home.root, 'sessions', dayDir(new Date()), 'rollout-bad-name.jsonl'), '{}');
    home.index([
      { id: ID(2), thread_name: 'Old name', updated_at: 'x' },
      '{not json',
      { id: ID(2), thread_name: '  Index   name ', updated_at: 'y' },
      { id: ID(99), thread_name: 'unrelated' },
      { id: ID(8), thread_name: '' },
    ]);

    const adapter = createCodexAdapter({ codexHome: home.root });
    assert.deepEqual(adapter.catalog(), []);
    assert.deepEqual(await adapter.refreshCatalog(new Set()), { fallbackActive: false });
    const byId = new Map(adapter.catalog().map((entry) => [entry.sessionId, entry]));

    assert.deepEqual([...byId.keys()].sort(), [ID(1), ID(10), ID(2), ID(8), ID(9)].sort());
    assert.equal(byId.get(ID(1))?.title.startsWith('fix the flaky test xxx'), true, 'first prompt, whitespace collapsed');
    assert.equal(byId.get(ID(1))?.title.length, 80);
    assert.equal(byId.get(ID(1))?.cwd, '/work/proj');
    assert.equal(byId.get(ID(1))?.adapterId, 'codex');
    assert.equal(byId.get(ID(1))?.lastAgo, '5m ago');
    assert.equal(byId.get(ID(2))?.title, 'Index name', 'index thread name outranks first prompt; latest line wins');
    assert.equal(byId.get(ID(2))?.lastAgo, '2h ago');
    assert.equal(byId.get(ID(8))?.title, '');
    assert.equal(byId.get(ID(9))?.cwd, '/work/from-turn');
    assert.equal(byId.get(ID(10))?.title, 'old folder, still active');
    assert.equal(adapter.catalogEntry(ID(2))?.title, 'Index name');
    assert.equal(adapter.catalogEntry(ID(3)), undefined);
  } finally {
    home.cleanup();
  }
});

test('rollout catalog caches by mtime and size, drops removed files and tolerates a missing home', async () => {
  const home = makeHome();
  try {
    const file = home.rollout(ID(1), [meta(ID(1), '/work/a'), userMsg('first title')]);
    const adapter = createCodexAdapter({ codexHome: home.root });
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'first title');

    const original = fs.readFileSync(file);
    const stat = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 'x'));
    fs.utimesSync(file, stat.atime, stat.mtime);
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'first title', 'unchanged mtime and size: served from cache');

    fs.writeFileSync(file, original);
    fs.appendFileSync(file, JSON.stringify(userMsg('second')) + '\n');
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'first title');

    fs.unlinkSync(file);
    await adapter.refreshCatalog(new Set());
    assert.deepEqual(adapter.catalog(), []);

    const missing = createCodexAdapter({ codexHome: path.join(home.root, 'nope') });
    assert.deepEqual(await missing.refreshCatalog(new Set()), { fallbackActive: false });
    assert.deepEqual(missing.catalog(), []);
    assert.deepEqual([...(await missing.resolveProcesses([]))], []);
  } finally {
    home.cleanup();
  }
});

test('Discovery lists live Codex sessions via lsof, ignores the extension app-server, and offers recents', async () => {
  const home = makeHome();
  const bin = path.join(home.root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
cat <<'EOF'
  777 700 codex resume ${ID(1)}
  778 50 codex exec hello
  779 900 /x/openai.chatgpt/bin/macos-aarch64/codex -c features.a=true app-server --analytics-default-enabled
  780 300 codex
  781 400 codex
EOF
`, { mode: 0o700 });
    const rolloutPath = (n: number): string => `/h/.codex/sessions/2026/05/29/rollout-2026-05-29T09-11-00-${ID(n)}.jsonl`;
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
cat <<'EOF'
p777
fcwd
n/work/live
f9
n${rolloutPath(1)}
p780
fcwd
n/work/fresh
p781
fcwd
n/work/live
f9
n${rolloutPath(3)}
EOF
`, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    home.rollout(ID(1), [meta(ID(1), '/work/live'), userMsg('live one')], { ageSeconds: 60 });
    home.rollout(ID(4), [meta(ID(4), '/work/live'), userMsg('finished work')], { ageSeconds: 120 });
    home.rollout(ID(5), [meta(ID(5), '/work/live'), userMsg('already resumed here')], { ageSeconds: 90 });
    home.index([{ id: ID(1), thread_name: 'Named live one' }]);

    const updates: Array<Map<number, { sessionId?: string; memoryBytes: number }>> = [];
    const discovery = new Discovery(
      () => new Set([781]),
      () => new Set([sessionKey('codex', ID(5))]),
      ['/work/live'],
      (sample) => updates.push(sample),
      () => {},
      [createCodexAdapter({ codexHome: home.root })]
    );
    await (discovery as unknown as { poll: () => Promise<void> }).poll();

    assert.equal(discovery.totalMemoryBytes, (700 + 300 + 400) * 1024, 'exec and app-server processes are not counted');
    assert.deepEqual(discovery.externals.map((e) => [e.adapterId, e.pid, e.sessionId, e.title]), [['codex', 777, ID(1), 'Named live one']],
      'a fresh TUI without an open rollout has no id yet and is not listed');
    assert.deepEqual([...updates[0]], [[781, { memoryBytes: 400 * 1024, sessionId: ID(3) }]]);
    assert.deepEqual(discovery.recents.map((r) => [sessionKey(r.adapterId, r.sessionId), r.title]), [[`codex:${ID(4)}`, 'finished work']]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    home.cleanup();
  }
});

test('SessionManager resumes a Codex session with `resume`, keys it under codex: and follows /new', async () => {
  const home = makeHome();
  const argsLog = path.join(home.root, 'args.log');
  const command = path.join(home.root, 'fake-codex');
  const previous = process.env.ENVOY_CODEX_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, `#!/bin/sh\nprintf 'args:%s\\n' "$*" >> "${argsLog}"\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
    process.env.ENVOY_CODEX_CMD = command;
    const configPath = path.join(home.root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(home.root, [home.root], new TagStore(configPath), () => {}, new DesktopNotifier(false), [createCodexAdapter({ codexHome: home.root })]);
    const session = manager.create(home.root, 'resumed', 'code', ID(1), { attach: false, adapterId: 'codex' });
    for (let i = 0; i < 120 && !fs.existsSync(argsLog); i++) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.readFileSync(argsLog, 'utf8').trim(), `args:resume ${ID(1)}`);
    assert.equal(manager.keyOf(session), `codex:${ID(1)}`);
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), [`codex:${ID(1)}`]);

    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: ID(2) });
    assert.equal(manager.keyOf(session), `codex:${ID(2)}`);
    assert.deepEqual(manager.getRestartState().sessions.map((s) => [s.adapterId, s.cliSessionId]), [['codex', ID(2)]]);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previous === undefined) delete process.env.ENVOY_CODEX_CMD;
    else process.env.ENVOY_CODEX_CMD = previous;
    home.cleanup();
  }
});

test('createAdapters registers Devin, Claude and Codex in order', () => {
  assert.deepEqual(createAdapters().map((a) => a.id), ['devin', 'claude', 'codex']);
});
