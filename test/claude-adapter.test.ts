import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createClaudeAdapter, isClaudeReplCommand } from '../src/adapters/claude';
import { createAdapters } from '../src/adapters/registry';
import { sessionKey } from '../src/adapters/types';
import { Discovery } from '../src/discovery';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Creates an isolated Claude config root.
 * @returns Paths and writers for registry records and transcripts.
 */
function makeHome(): {
  root: string;
  sessionsDir: string;
  registry: (pid: number, record: unknown) => void;
  transcript: (project: string, sessionId: string, records: unknown[], ageSeconds?: number) => string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-claude-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return {
    root,
    sessionsDir,
    registry: (pid, record) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), typeof record === 'string' ? record : JSON.stringify(record)),
    transcript: (project, sessionId, records, ageSeconds = 5) => {
      const dir = path.join(root, 'projects', project);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const when = new Date(Date.now() - ageSeconds * 1000);
      fs.utimesSync(file, when, when);
      return file;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const userRecord = (cwd: string, text: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user', cwd, sessionId: 'x', entrypoint: 'cli', message: { role: 'user', content: text }, ...extra,
});

test('isClaudeReplCommand accepts interactive Claude and rejects helpers and other tools', () => {
  for (const command of ['claude', 'claude --resume abc', '/Users/me/.local/bin/claude', '/opt/claude/versions/2.1.3/claude --model opus', 'node /opt/homebrew/bin/claude', '/Users/me/.local/share/claude/versions/2.1.75', '/Users/me/.local/share/claude/versions/2.1.75 --resume abc', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume x']) {
    assert.equal(isClaudeReplCommand(command), true, command);
  }
  for (const command of [
    'claude -p hello', 'claude --print', 'claude --chrome-native-host', 'claude mcp serve', 'claude update', 'claude doctor', 'claude --version', 'claude agents',
    '/Applications/Claude.app/Contents/MacOS/Claude', 'node server.js', 'node /tmp/other.js', 'claude-helper --x', '/Users/me/.local/share/claude/versions/2.1.75 -p hi', '/Users/me/.local/share/claude/versions/2.1.75 mcp serve', '/Users/me/other/versions/2.1.75', '/Users/me/.local/share/claude/versions', 'grep claude', 'devin', '',
  ]) {
    assert.equal(isClaudeReplCommand(command), false, command);
  }
});

test('Claude adapter builds spawn args and honours ENVOY_CLAUDE_CMD', () => {
  const adapter = createClaudeAdapter({ configDir: '/nonexistent' });
  const previous = process.env.ENVOY_CLAUDE_CMD;
  try {
    delete process.env.ENVOY_CLAUDE_CMD;
    assert.equal(adapter.command(), 'claude');
    process.env.ENVOY_CLAUDE_CMD = '/tmp/my-claude';
    assert.equal(adapter.command(), '/tmp/my-claude');
  } finally {
    if (previous === undefined) delete process.env.ENVOY_CLAUDE_CMD;
    else process.env.ENVOY_CLAUDE_CMD = previous;
  }
  assert.deepEqual(adapter.freshArgs(), []);
  assert.deepEqual(adapter.resumeArgs('abc'), ['--resume', 'abc']);
  assert.equal(adapter.id, 'claude');
  assert.equal(adapter.sessionIdChanges, true);
  assert.deepEqual(createAdapters().map((a) => a.id), ['devin', 'claude', 'codex']);
});

test('registry resolution trusts only records that match a live Claude pid', async () => {
  const home = makeHome();
  try {
    const good = { pid: 100, sessionId: ID(1), cwd: '/work/api', procStart: '2277', kind: 'interactive', name: ' API session ', status: 'idle' };
    home.registry(100, good);
    home.registry(101, { ...good, pid: 999, sessionId: ID(2) }); // file name and pid disagree
    home.registry(102, { ...good, pid: 102, sessionId: 'bad id!' });
    home.registry(103, '{not json');
    home.registry(104, { ...good, pid: 104, sessionId: ID(4), kind: 'bg' });
    home.registry(105, { ...good, pid: 105, sessionId: ID(5), parkedJobId: 'job-1' });
    home.registry(106, { ...good, pid: 106, sessionId: ID(6), procStart: '1' }); // pid reused
    home.registry(107, { pid: 107, sessionId: ID(7), cwd: 'relative/dir' });
    home.registry(108, [1, 2]);
    home.registry(109, { ...good, pid: 109, sessionId: ID(9), procStart: '5555' });
    fs.writeFileSync(path.join(home.sessionsDir, '110.json'), JSON.stringify({ pid: 110, sessionId: ID(10), pad: 'x'.repeat(70_000) }));

    const starts: Record<number, string | null> = { 100: '2277', 106: '2277', 109: null };
    const adapter = createClaudeAdapter({ configDir: home.root, procStart: (pid) => starts[pid] ?? null });
    const resolved = await adapter.resolveProcesses([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);

    assert.deepEqual([...resolved.keys()], [100, 107, 109]);
    assert.deepEqual(resolved.get(100), { sessionId: ID(1), cwd: '/work/api', title: 'API session' });
    assert.deepEqual(resolved.get(107), { sessionId: ID(7) }, 'relative cwd is dropped, id kept');
    assert.equal(resolved.get(109)?.sessionId, ID(9), 'unverifiable procStart (no /proc) falls back to the ps match');
    assert.deepEqual([...(await adapter.resolveProcesses([]))], []);
  } finally {
    home.cleanup();
  }
});

test('transcript catalog derives title, cwd and age and skips unusable sessions', async () => {
  const home = makeHome();
  try {
    const cwd = '/work/proj';
    home.transcript('-work-proj', ID(1), [
      userRecord(cwd, 'first prompt for one'),
      { type: 'ai-title', aiTitle: 'Old AI title', sessionId: ID(1) },
      { type: 'assistant', cwd, sessionId: ID(1) },
      { type: 'ai-title', aiTitle: 'Newest AI title', sessionId: ID(1) },
      { type: 'custom-title', customTitle: 'Renamed by user', sessionId: ID(1) },
    ], 5 * 60);
    home.transcript('-work-proj', ID(2), [userRecord(cwd, 'hello two'), { type: 'ai-title', aiTitle: 'AI only' }], 2 * 3600);
    home.transcript('-work-proj', ID(3), [
      userRecord(cwd, '<command-name>/clear</command-name>'),
      userRecord(cwd, 'meta caveat', { isMeta: true }),
      userRecord(cwd, 'sub agent prompt', { isSidechain: true }),
      userRecord(cwd, [{ type: 'tool_result', content: 'ignored' }]),
      userRecord(cwd, [{ type: 'text', text: '  fix   the\nflaky  test  ' + 'x'.repeat(200) }]),
    ]);
    home.transcript('-work-proj', ID(4), [userRecord(cwd, 'headless run', { entrypoint: 'sdk-cli' })]);
    home.transcript('-work-proj', ID(5), [{ type: 'ai-title', aiTitle: 'no cwd anywhere' }]);
    home.transcript('-work-proj', ID(6), [userRecord(cwd, 'too old')], 25 * 3600);
    home.transcript('-work-proj', 'not a valid id', [userRecord(cwd, 'bad name')]);
    home.transcript('-work-proj', ID(8), [userRecord(cwd, '')]);
    fs.mkdirSync(path.join(home.root, 'projects', '-work-proj', ID(1), 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(home.root, 'projects', '-work-proj', ID(1), 'subagents', 'agent-1.jsonl'), JSON.stringify(userRecord(cwd, 'subagent')) + '\n');
    fs.writeFileSync(path.join(home.root, 'projects', '-work-proj', 'notes.txt'), 'ignored');

    const adapter = createClaudeAdapter({ configDir: home.root });
    assert.deepEqual(adapter.catalog(), []);
    assert.deepEqual(await adapter.refreshCatalog(new Set()), { fallbackActive: false });
    const byId = new Map(adapter.catalog().map((entry) => [entry.sessionId, entry]));

    assert.deepEqual([...byId.keys()].sort(), [ID(1), ID(2), ID(3), ID(8)]);
    assert.equal(byId.get(ID(1))?.title, 'Renamed by user', 'custom title outranks AI title');
    assert.equal(byId.get(ID(1))?.cwd, cwd);
    assert.equal(byId.get(ID(1))?.adapterId, 'claude');
    assert.equal(byId.get(ID(1))?.lastAgo, '5m ago');
    assert.equal(byId.get(ID(2))?.title, 'AI only');
    assert.equal(byId.get(ID(2))?.lastAgo, '2h ago');
    const fallback = byId.get(ID(3))?.title ?? '';
    assert.equal(fallback.startsWith('fix the flaky test xxx'), true, 'first real prompt, whitespace collapsed');
    assert.equal(fallback.length, 80);
    assert.equal(byId.get(ID(8))?.title, '');
    assert.equal(Math.abs((byId.get(ID(1))?.lastActivityAt ?? 0) - (Date.now() / 1000 - 300)) < 5, true);
    assert.equal(adapter.catalogEntry(ID(2))?.title, 'AI only');
    assert.equal(adapter.catalogEntry(ID(4)), undefined);
  } finally {
    home.cleanup();
  }
});

test('transcript catalog samples head and tail of large files and caches by mtime and size', async () => {
  const home = makeHome();
  try {
    const cwd = '/work/big';
    const filler = { type: 'assistant', cwd, text: 'z'.repeat(2000) };
    const records: unknown[] = [userRecord(cwd, 'opening prompt'), { type: 'ai-title', aiTitle: 'Early title' }];
    for (let i = 0; i < 150; i++) records.push(filler);
    records.push({ type: 'ai-title', aiTitle: 'Late title' });
    const file = home.transcript('-work-big', ID(1), records);
    assert.equal(fs.statSync(file).size > 128 * 1024, true);

    const adapter = createClaudeAdapter({ configDir: home.root });
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'Late title');
    assert.equal(adapter.catalog()[0].cwd, cwd);

    // unchanged file: served from cache even if its contents were swapped for same-size junk
    const original = fs.readFileSync(file);
    const stat = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(original.length, 'x'));
    fs.utimesSync(file, stat.atime, stat.mtime);
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'Late title');

    // changed size or mtime invalidates
    fs.writeFileSync(file, original);
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed later' }) + '\n');
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog()[0].title, 'Renamed later');

    // removed files and a missing projects dir drop out of the catalog
    fs.unlinkSync(file);
    await adapter.refreshCatalog(new Set());
    assert.deepEqual(adapter.catalog(), []);
    home.transcript('-work-big', ID(2), [userRecord(cwd, 'again')]);
    await adapter.refreshCatalog(new Set());
    assert.equal(adapter.catalog().length, 1);
    fs.rmSync(path.join(home.root, 'projects'), { recursive: true });
    assert.deepEqual(await adapter.refreshCatalog(new Set()), { fallbackActive: false });
    assert.deepEqual(adapter.catalog(), []);
  } finally {
    home.cleanup();
  }
});

test('Discovery lists live Claude sessions and recents without leaking helper processes', async () => {
  const home = makeHome();
  const bin = path.join(home.root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
cat <<'EOF'
  777 700 claude --resume ${ID(1)}
  778 50 claude -p headless
  779 10 claude mcp serve
  780 300 claude
  781 400 claude
EOF
`, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const cwd = '/work/live';
    home.registry(777, { pid: 777, sessionId: ID(1), cwd, name: 'Registry name' });
    home.registry(780, { pid: 780, sessionId: ID(2), cwd, name: 'Only registry name' });
    home.registry(781, { pid: 781, sessionId: ID(3), cwd, name: 'Owned here' });
    home.transcript('-work-live', ID(1), [userRecord(cwd, 'live one'), { type: 'ai-title', aiTitle: 'Catalog title' }], 60);
    home.transcript('-work-live', ID(4), [userRecord(cwd, 'finished work'), { type: 'ai-title', aiTitle: 'Resume me' }], 120);
    home.transcript('-work-live', ID(5), [userRecord(cwd, 'already resumed here')], 90);

    const updates: Array<Map<number, { sessionId?: string; memoryBytes: number }>> = [];
    const discovery = new Discovery(
      () => new Set([781]),
      () => new Set([sessionKey('claude', ID(5))]),
      [cwd],
      (sample) => updates.push(sample),
      () => {},
      [createClaudeAdapter({ configDir: home.root, procStart: () => null })]
    );
    await (discovery as unknown as { poll: () => Promise<void> }).poll();

    assert.equal(discovery.totalMemoryBytes, (700 + 300 + 400) * 1024, 'headless and mcp helpers are not counted');
    assert.deepEqual(discovery.externals.map((e) => [e.adapterId, e.pid, e.sessionId, e.title]), [
      ['claude', 777, ID(1), 'Catalog title'],
      ['claude', 780, ID(2), 'Only registry name'],
    ]);
    assert.deepEqual([...updates[0]], [[781, { memoryBytes: 400 * 1024, sessionId: ID(3) }]]);
    assert.deepEqual(discovery.recents.map((r) => [sessionKey(r.adapterId, r.sessionId), r.title]), [[`claude:${ID(4)}`, 'Resume me']]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    home.cleanup();
  }
});

test('SessionManager resumes a Claude session with --resume and keys it under claude:', async () => {
  const home = makeHome();
  const argsLog = path.join(home.root, 'args.log');
  const command = path.join(home.root, 'fake-claude');
  const previous = process.env.ENVOY_CLAUDE_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, `#!/bin/sh\nprintf 'args:%s\\n' "$*" >> "${argsLog}"\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
    process.env.ENVOY_CLAUDE_CMD = command;
    const configPath = path.join(home.root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(home.root, [home.root], new TagStore(configPath), () => {}, new DesktopNotifier(false), [createClaudeAdapter({ configDir: home.root })]);
    const session = manager.create(home.root, 'resumed', 'code', ID(1), { attach: false, adapterId: 'claude' });
    for (let i = 0; i < 120 && !fs.existsSync(argsLog); i++) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.readFileSync(argsLog, 'utf8').trim(), `args:--resume ${ID(1)}`);
    assert.equal(manager.keyOf(session), `claude:${ID(1)}`);
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), [`claude:${ID(1)}`]);

    // /clear: the hook reports a new id and the same row follows it
    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: ID(2) });
    assert.equal(manager.keyOf(session), `claude:${ID(2)}`);
    assert.deepEqual(manager.getRestartState().sessions.map((s) => [s.adapterId, s.cliSessionId]), [['claude', ID(2)]]);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previous === undefined) delete process.env.ENVOY_CLAUDE_CMD;
    else process.env.ENVOY_CLAUDE_CMD = previous;
    home.cleanup();
  }
});
