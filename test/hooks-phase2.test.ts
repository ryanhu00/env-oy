import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createDevinAdapter } from '../src/adapters/devin';
import type { CliAdapter } from '../src/adapters/types';
import { hookSessionId } from '../src/hooks/payload';
import {
  describeHookInstall,
  hooksInstalled,
  installHookTargets,
  installHooks,
  installedHookTargets,
  isOnPath,
  missingHookTargets,
} from '../src/hooks/installer';
import { EVENT_DEDUPE_WINDOW_MS, EventDeduper, EventsTailer } from '../src/notifications';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

const HOOK_SCRIPT = path.resolve(__dirname, '..', 'bin', 'envoy-hook.sh');

/**
 * Polls until a condition holds.
 * @param predicate Condition to wait for.
 * @param message Failure description.
 * @returns Promise resolved when the condition is true.
 */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/**
 * Creates an executable stub on disk.
 * @param dir Directory to place it in.
 * @param name File name.
 * @returns Nothing.
 */
function stubBinary(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('hookSessionId accepts plain ids and rejects unsafe ones', () => {
  assert.equal(hookSessionId({ session_id: 'abc-123_X.y:z' }), 'abc-123_X.y:z');
  assert.equal(hookSessionId({ session_id: '3f9c1e3a-1b2c-4d5e-8f90-123456789abc' }), '3f9c1e3a-1b2c-4d5e-8f90-123456789abc');
  for (const bad of ['', ' padded ', 'has space', '-leading', 'a'.repeat(129), 'new\nline', 42, null, undefined, { id: 1 }]) {
    assert.equal(hookSessionId({ session_id: bad }), null, String(bad));
  }
  assert.equal(hookSessionId(undefined), null);
  assert.equal(hookSessionId({}), null);
});

test('EventDeduper drops identical events inside the window only', () => {
  const dedupe = new EventDeduper();
  const payload = { session_id: 'a', prompt: 'p' };
  assert.equal(dedupe.isDuplicate('s1', 'Stop', payload, 10_000), false);
  assert.equal(dedupe.isDuplicate('s1', 'Stop', { ...payload }, 10_000), true);
  // hook ts has one-second resolution, so a duplicate can straddle a second boundary
  assert.equal(dedupe.isDuplicate('s1', 'Stop', payload, 10_000 + EVENT_DEDUPE_WINDOW_MS), true);
  assert.equal(dedupe.isDuplicate('s1', 'Stop', payload, 10_000 + EVENT_DEDUPE_WINDOW_MS + 1), false);
  // different session, event or payload are never duplicates
  assert.equal(dedupe.isDuplicate('s2', 'Stop', payload, 20_000), false);
  assert.equal(dedupe.isDuplicate('s2', 'UserPromptSubmit', payload, 20_000), false);
  assert.equal(dedupe.isDuplicate('s2', 'Stop', { ...payload, prompt: 'q' }, 20_000), false);
  assert.equal(dedupe.isDuplicate('s2', 'Stop', undefined, 20_000), false);
  assert.equal(dedupe.isDuplicate('s2', 'Stop', undefined, 20_000), true);
});

test('EventDeduper duplicates do not extend the window and old entries are evicted', () => {
  const dedupe = new EventDeduper(1000);
  assert.equal(dedupe.isDuplicate('s', 'Stop', undefined, 0), false);
  assert.equal(dedupe.isDuplicate('s', 'Stop', undefined, 900), true);
  // 1500 is within 1000ms of the duplicate at 900 but not of the original at 0
  assert.equal(dedupe.isDuplicate('s', 'Stop', undefined, 1500), false);
  for (let i = 0; i < 100; i++) dedupe.isDuplicate(`bulk-${i}`, 'Stop', undefined, 2000);
  assert.equal(dedupe.isDuplicate('s', 'Stop', undefined, 100_000), false);
  const size = (dedupe as unknown as { seen: Map<string, number> }).seen.size;
  assert.equal(size < 50, true);
});

test('EventsTailer collapses duplicate hook deliveries but keeps real repeats', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-tailer-dedupe-'));
  const file = path.join(root, 'events.jsonl');
  const received: Array<{ id: string; event: string; n?: number }> = [];
  const tailer = new EventsTailer(root, (id, event, payload) => received.push({ id, event, n: payload?.n as number | undefined }));
  const line = (id: string, event: string, ts: number, n: number): string => `${JSON.stringify({ id, event, ts, payload: { n } })}\n`;
  try {
    tailer.start();
    fs.appendFileSync(file, line('a', 'Stop', 5000, 1) + line('a', 'Stop', 5000, 1) + line('a', 'Stop', 6000, 1));
    fs.appendFileSync(file, line('a', 'Stop', 5000, 2) + line('b', 'Stop', 5000, 1));
    fs.appendFileSync(file, line('a', 'Stop', 60_000, 1));
    fs.appendFileSync(file, `${JSON.stringify({ id: 'a', event: 'PermissionRequest' })}\n${JSON.stringify({ id: 'a', event: 'PermissionRequest' })}\n`);
    await waitFor(() => received.length >= 5, 'deduplicated events');
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(received.map((e) => `${e.id}:${e.event}:${e.n ?? '-'}`), [
      'a:Stop:1', // first delivery
      // duplicate at the same ts, and one straddling the second boundary, are dropped
      'a:Stop:2', // same ts but different payload
      'b:Stop:1', // different session
      'a:Stop:1', // 55s later: a real repeat
      'a:PermissionRequest:-', // payload-less pair collapses to one
    ]);
  } finally {
    tailer.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Creates a manager over a fake long-running CLI.
 * @param root Temp directory that receives the fake command and config.
 * @param adapters Adapters to register.
 * @returns A manager using an isolated config with one `code` tag.
 */
function makeManager(root: string, adapters: CliAdapter[]): SessionManager {
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
  return new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false), adapters);
}

test('hook payload resolves a pending session id immediately and persists alias, tag and order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-hook-id-'));
  const command = path.join(root, 'fake-cli');
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    manager = makeManager(root, [{ ...createDevinAdapter(), command: () => command }]);
    const session = manager.create(root, 'pending', 'code', undefined, { attach: false });
    assert.equal(session.cliSessionId, null);
    assert.equal(manager.setDisplayAlias({ kind: 'active', session }, 'Typed early'), null);
    assert.equal(manager.getRefreshReadiness().ready, false);

    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: 'bad id!', prompt: 'x' });
    assert.equal(session.cliSessionId, null, 'unsafe ids are ignored');

    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: 'dev-1', prompt: 'x' });
    assert.equal(session.cliSessionId, 'dev-1');
    assert.equal(session.status, 'working');
    assert.equal(manager.tagStore.getSessionAlias('dev-1'), 'Typed early');
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['dev-1']);
    assert.equal(manager.keyOf(session), 'dev-1');

    // a later lock-file sample for the same session is a no-op, and Devin never re-keys
    manager.assignDiscoveredSessionIds(new Map([[session.pid, { memoryBytes: 1, sessionId: 'dev-1' }]]));
    manager.applyEvent(session.id, 'Stop', { session_id: 'dev-2' });
    assert.equal(session.cliSessionId, 'dev-1');
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['dev-1']);
    manager.applyEvent(session.id, 'Stop');
    assert.equal(manager.getRefreshReadiness().ready, true);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapters whose id changes re-key the same row on a new hook session_id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-hook-rekey-'));
  const command = path.join(root, 'fake-cli');
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    const claudeLike: CliAdapter = { ...createDevinAdapter(), id: 'claude', sessionIdChanges: true, command: () => command };
    manager = makeManager(root, [claudeLike]);
    const other = manager.create(root, 'other', 'code', 'keep', { attach: false, adapterId: 'claude' });
    const session = manager.create(root, 'cleared', 'code', 'old', { attach: false, adapterId: 'claude' });
    manager.tagStore.setSessionAlias('claude:old', 'My alias');
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['claude:keep', 'claude:old']);

    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: 'new' });
    assert.equal(session.cliSessionId, 'new');
    assert.equal(manager.keyOf(session), 'claude:new');
    // position preserved, alias carried to the new key and kept for the old conversation
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['claude:keep', 'claude:new']);
    assert.equal(manager.tagStore.getSessionAlias('claude:new'), 'My alias');
    assert.equal(manager.tagStore.getSessionAlias('claude:old'), 'My alias');
    assert.equal(manager.displayName(session), 'My alias');
    assert.equal(other.cliSessionId, 'keep');

    // same id again is a no-op; the restart handoff carries the new id
    manager.applyEvent(session.id, 'Stop', { session_id: 'new' });
    assert.deepEqual(manager.tagStore.getSessionOrder('code'), ['claude:keep', 'claude:new']);
    assert.deepEqual(manager.getRestartState().sessions.map((s) => s.cliSessionId), ['keep', 'new']);

    // a fresh TagStore reads the persisted change
    const reloaded = new TagStore(manager.tagStore.configPath);
    assert.deepEqual(reloaded.getSessionOrder('code'), ['claude:keep', 'claude:new']);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TagStore.renameSessionKey moves order, copies alias without clobbering, and validates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-rename-key-'));
  try {
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      tags: ['a', 'b'],
      session_order: { a: ['x', 'old', 'y'], b: ['old', 'z'] },
      session_aliases: { old: 'Old alias', taken: 'Existing' },
    }));
    const store = new TagStore(configPath);
    store.renameSessionKey('old', 'new');
    assert.deepEqual(store.getSessionOrder('a'), ['x', 'new', 'y']);
    assert.deepEqual(store.getSessionOrder('b'), ['new', 'z']);
    assert.equal(store.getSessionAlias('new'), 'Old alias');
    assert.equal(store.getSessionAlias('old'), 'Old alias');

    store.renameSessionKey('new', 'taken');
    assert.equal(store.getSessionAlias('taken'), 'Existing');
    store.renameSessionKey('taken', 'taken');
    assert.throws(() => store.renameSessionKey('', 'z'), /real session ID/);
    assert.throws(() => store.renameSessionKey('a', ' z '), /real session ID/);
    assert.deepEqual(new TagStore(configPath).getSessionOrder('a'), ['x', 'taken', 'y']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hook installer only targets CLIs that are installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-installer-detect-'));
  try {
    const bin = path.join(root, 'bin');
    const emptyBin = path.join(root, 'empty');
    fs.mkdirSync(bin);
    fs.mkdirSync(emptyBin);
    stubBinary(bin, 'claude');
    stubBinary(bin, 'codex');
    fs.writeFileSync(path.join(bin, 'devin'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(bin, 'sub'));

    assert.equal(isOnPath('claude', bin), true);
    assert.equal(isOnPath('devin', bin), false, 'non-executable file does not count');
    assert.equal(isOnPath('sub', bin), false, 'directories do not count');
    assert.equal(isOnPath('claude', `${emptyBin}${path.delimiter}`), false);
    assert.equal(isOnPath('claude', ''), false);

    const home = path.join(root, 'home');
    const targets = installedHookTargets(['devin', 'claude', 'codex'], home, bin);
    assert.deepEqual(targets.map((t) => [t.adapterId, t.configPath]), [
      ['claude', path.join(home, '.claude', 'settings.json')],
      ['codex', path.join(home, '.codex', 'hooks.json')],
    ]);
    assert.deepEqual(installedHookTargets(['devin', 'claude', 'codex'], home, emptyBin), []);
    assert.deepEqual(installedHookTargets(['claude'], home, bin).map((t) => t.adapterId), ['claude']);
    assert.deepEqual(installedHookTargets([], home, bin), []);
    assert.equal(fs.existsSync(home), false, 'detection never touches the home directory');

    assert.equal(describeHookInstall([targets[0]]), `Install Claude notification hooks into ${targets[0].configPath}? (backup written first)`);
    assert.equal(describeHookInstall(targets), 'Install notification hooks for Claude, Codex? (backups written first)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hook installer writes each CLI independently and reports trust notices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-installer-write-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['devin', 'claude', 'codex']) stubBinary(bin, name);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const claudeRaw = JSON.stringify({ theme: 'dark', hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: '/tmp/other' }] }] } }, null, 2) + '\n';
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), claudeRaw);

    const targets = installedHookTargets(['devin', 'claude', 'codex'], home, bin);
    assert.equal(missingHookTargets(targets).length, 3);
    const result = installHookTargets(targets);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.installed.map((t) => t.adapterId), ['devin', 'claude', 'codex']);
    assert.deepEqual(result.notices, ['Codex must trust the new hooks before they run: open Codex and run /hooks.']);
    assert.deepEqual(missingHookTargets(targets), []);

    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.equal(claude.hooks.Stop.length, 2);
    assert.equal(claude.hooks.Stop[1].matcher, '');
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json.bak-envoy'), 'utf8'), claudeRaw);

    const codex = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    for (const event of ['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd']) {
      assert.deepEqual(codex.hooks[event], [{ hooks: [{ type: 'command', command: `${HOOK_SCRIPT} ${event}` }] }]);
    }
    assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json.bak-envoy')), false, 'no backup when no prior file existed');
    assert.equal(hooksInstalled(path.join(home, '.config', 'devin', 'config.json')), true);

    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    assert.equal(installHookTargets(targets).errors.length, 0);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before, 'second install is a no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hook installer never overwrites a config it cannot parse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-installer-invalid-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['claude', 'codex']) stubBinary(bin, name);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const broken = '{ // user comment\n  "theme": "dark",\n}\n';
    const brokenPath = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(brokenPath, broken);

    const result = installHookTargets(installedHookTargets(['claude', 'codex'], home, bin));
    assert.deepEqual(result.installed.map((t) => t.adapterId), ['codex']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^Claude: .*settings\.json is not valid JSON/);
    assert.equal(fs.readFileSync(brokenPath, 'utf8'), broken);
    assert.equal(fs.existsSync(brokenPath + '.bak-envoy'), false);

    fs.writeFileSync(brokenPath, '[1,2]');
    assert.throws(() => installHooks(brokenPath), /not a JSON object/);
    assert.equal(fs.readFileSync(brokenPath, 'utf8'), '[1,2]');

    // an empty file is treated as "no config yet"
    fs.writeFileSync(brokenPath, '  \n');
    installHooks(brokenPath);
    assert.equal(hooksInstalled(brokenPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
