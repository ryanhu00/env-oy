import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Terminal } from '@xterm/headless';
import * as pty from 'node-pty';
import { InputHandler } from '../src/input';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

/**
 * Polls a condition until it succeeds or reaches a bounded test timeout.
 * @param predicate Condition checked every 25ms.
 * @param message Failure context for timeout errors.
 * @param timeout Maximum wait in milliseconds.
 * @returns Promise resolved once the condition succeeds.
 */
async function waitFor(predicate: () => boolean, message: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/**
 * Reads the headless terminal's visible rows as trimmed plain text.
 * @param terminal Terminal receiving the application's ANSI output.
 * @returns Current screen rows for PTY assertions.
 */
function readScreen(terminal: Terminal): string[] {
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '');
  return lines;
}

/**
 * Verifies selection repair, input routing, hidden polling, and uppercase-R replacement defaults.
 * @returns Promise resolved after fake sessions and isolated files are removed.
 */
async function testRecentVisibilityManagerAndInput(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-recent-manager-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.ENVOY_CMD;
  let manager: SessionManager | null = null;
  let replacement: SessionManager | null = null;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.ENVOY_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const activeA = manager.create(root, 'active-a', 'code');
    manager.detach();
    const activeB = manager.create(root, 'active-b', 'code');
    manager.detach();
    manager.discovery.recents = [{ adapterId: 'devin', sessionId: 'recent-old', cwd: root, title: 'recent old', lastAgo: '1m', lastActivityAt: 10 }];
    manager.discovery.externals = [{ adapterId: 'devin', pid: 424242, sessionId: 'external-one', cwd: root, title: 'terminal one', lastAgo: 'now', memoryBytes: 128 * 1024 ** 2 }];
    assert.equal(manager.recentVisible, true);
    assert.deepEqual(manager.entries.map((entry) => entry.kind), ['active', 'active', 'recent', 'external']);
    (manager.discovery as unknown as { onUpdate: () => void }).onUpdate();
    assert.equal(manager.selectedSession, activeB);

    const input = new InputHandler(manager, () => {}, () => {}, true, () => {}, root);
    manager.selected = 2;
    input.handle('H');
    assert.equal(manager.recentVisible, false);
    assert.deepEqual(manager.entries.map((entry) => entry.kind), ['active', 'active', 'external']);
    assert.equal(manager.entries[manager.selected].kind, 'external');
    assert.equal(manager.discovery.recents[0].sessionId, 'recent-old');
    manager.discovery.recents = [{ adapterId: 'devin', sessionId: 'recent-fresh', cwd: root, title: 'recent fresh', lastAgo: 'now', lastActivityAt: 20 }];
    (manager.discovery as unknown as { onUpdate: () => void }).onUpdate();
    assert.deepEqual(manager.entries.map((entry) => entry.kind), ['active', 'active', 'external']);
    assert.equal(manager.entries[manager.selected].kind, 'external');
    input.handle('H');
    assert.deepEqual(manager.entries.map((entry) => entry.kind), ['active', 'active', 'recent', 'external']);
    assert.equal(manager.entries.find((entry) => entry.kind === 'recent')?.kind === 'recent' ? manager.entries.find((entry) => entry.kind === 'recent')!.recent.sessionId : null, 'recent-fresh');
    assert.equal(manager.entries[manager.selected].kind, 'external');

    manager.selected = 0;
    input.handle('H');
    assert.equal(manager.selectedSession, activeA);
    input.handle('H');
    assert.equal(manager.selectedSession, activeA);
    manager.selected = manager.entries.findIndex((entry) => entry.kind === 'external');
    input.handle('H');
    assert.equal(manager.entries[manager.selected].kind, 'external');
    input.handle('H');
    assert.equal(manager.entries[manager.selected].kind, 'external');

    manager.discovery.externals = [];
    manager.selected = manager.entries.findIndex((entry) => entry.kind === 'recent');
    input.handle('H');
    assert.equal(manager.selectedSession, activeB);
    manager.discovery.recents = [{ adapterId: 'devin', sessionId: 'recent-hidden-poll', cwd: root, title: 'hidden poll', lastAgo: 'now', lastActivityAt: 30 }];
    (manager.discovery as unknown as { onUpdate: () => void }).onUpdate();
    assert.equal(manager.selectedSession, activeB);
    assert.deepEqual(manager.entries.map((entry) => entry.kind), ['active', 'active']);

    manager.attach(activeA);
    input.mode = 'attached';
    input.attachedMode = 'normal';
    const forwarded: string[] = [];
    activeA.input = (data: string): void => {
      forwarded.push(data);
    };
    input.handle('H');
    assert.deepEqual(forwarded, []);
    assert.equal(manager.recentVisible, false);
    input.attachedMode = 'insert';
    input.handle('H');
    assert.deepEqual(forwarded, ['H']);
    input.mode = 'form';
    input.form = { field: 1, cwd: root, name: '', error: '' };
    input.handle('H');
    assert.equal(input.form.name, '');
    input.handle('h');
    assert.equal(input.form.name, 'h');
    input.mode = 'sidebar';
    input.handle('h');
    assert.equal(manager.recentVisible, false);

    activeA.cliSessionId = 'active-a-id';
    activeB.cliSessionId = 'active-b-id';
    const refreshInput = new InputHandler(manager, () => {}, () => {}, true, () => {
      const restartState = manager!.getRestartState();
      assert.equal('recentVisible' in restartState, false);
      replacement = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
      replacement.restoreRestartState(restartState);
    }, root);
    refreshInput.handle('R');
    assert.equal(refreshInput.mode, 'confirm');
    refreshInput.handle('y');
    assert.equal(replacement?.recentVisible, true);
  } finally {
    manager?.killAll();
    replacement?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    for (const session of replacement?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previousCommand === undefined) delete process.env.ENVOY_CMD;
    else process.env.ENVOY_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Verifies untouched startup preference and that navigation or hiding prevents later jumps.
 * @returns Nothing after isolated manager configuration is removed.
 */
function testInitialRecentSelection(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-recent-selection-'));
  try {
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    const terminal = { adapterId: 'devin', pid: 1, sessionId: 'terminal-id', cwd: root, title: 'terminal', lastAgo: 'just now', memoryBytes: 1 };
    const recent = { adapterId: 'devin', sessionId: 'recent-id', cwd: root, title: 'recent', lastAgo: 'just now', lastActivityAt: 2 };
    const later = { adapterId: 'devin', sessionId: 'later-id', cwd: root, title: 'later', lastAgo: 'just now', lastActivityAt: 3 };
    const manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const discoveryUpdate = (manager.discovery as unknown as { onUpdate: () => void }).onUpdate;
    manager.discovery.externals = [terminal];
    discoveryUpdate();
    assert.equal(manager.entries[manager.selected].kind, 'external');
    manager.discovery.recents = [recent];
    discoveryUpdate();
    assert.equal(manager.entries[manager.selected].kind, 'recent');
    assert.equal(manager.entries[manager.selected].kind === 'recent' ? manager.entries[manager.selected].recent.sessionId : null, 'recent-id');

    manager.selected = manager.entries.findIndex((entry) => entry.kind === 'external');
    manager.discovery.recents = [later];
    discoveryUpdate();
    assert.equal(manager.entries[manager.selected].kind, 'external');

    const hiddenManager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const hiddenUpdate = (hiddenManager.discovery as unknown as { onUpdate: () => void }).onUpdate;
    hiddenManager.discovery.externals = [terminal];
    hiddenUpdate();
    const input = new InputHandler(hiddenManager, () => {}, () => {}, false, () => {}, root);
    input.handle('H');
    hiddenManager.discovery.recents = [recent];
    hiddenUpdate();
    assert.equal(hiddenManager.recentVisible, false);
    assert.deepEqual(hiddenManager.entries.map((entry) => entry.kind), ['external']);
    input.handle('H');
    assert.equal(hiddenManager.recentVisible, true);
    assert.equal(hiddenManager.entries[hiddenManager.selected].kind, 'external');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Exercises RECENT hiding and restoration in a bounded PTY with fake discovery only.
 * @returns Promise resolved after clean quit and deletion of all isolated artifacts.
 */
async function testRecentVisibilityPtySmoke(): Promise<void> {
  const projectRoot = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-recent-pty-'));
  const fakeBin = path.join(root, 'bin');
  const eventsDir = path.join(root, 'events');
  const configDir = path.join(root, '.config', 'envoy');
  const launchLog = path.join(root, 'unexpected-launches');
  const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows: 30 });
  let app: pty.IPty | null = null;
  let exited = false;
  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ tags: ['code'], desktop_notifications: false }));
    fs.writeFileSync(path.join(fakeBin, 'ps'), "#!/bin/sh\nprintf '  424242 131072 devin --fake-external\\n'\n", { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'lsof'), `#!/bin/sh
cat <<'EOF'
p424242
fcwd
n${root}
f10
n${path.join(root, '.local', 'share', 'devin', 'session_locks', 'external-1.lock')}
EOF
`, { mode: 0o700 });
    const now = Math.floor(Date.now() / 1000);
    const dbPath = path.join(root, '.local', 'share', 'devin', 'cli', 'sessions.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    execFileSync('/usr/bin/sqlite3', [dbPath, [
      'CREATE TABLE sessions (id, working_directory, last_activity_at, title, hidden)',
      `INSERT INTO sessions VALUES ('external-1', '${root}', ${now}, 'terminal smoke', 0)`,
      `INSERT INTO sessions VALUES ('recent-1', '${root}', ${now - 60}, 'recent smoke', 0)`,
    ].join(';')]);
    fs.writeFileSync(path.join(fakeBin, 'devin'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === 'list') {
  process.stderr.write('Error: database disk image is malformed\\n');
  process.exit(1);
}
fs.appendFileSync(process.env.FAKE_LAUNCH_LOG, process.argv.join(' ') + '\\n');
process.stdin.resume();
`, { mode: 0o700 });
    app = pty.spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js')], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        ENVOY_EVENTS_DIR: eventsDir,
        ENVOY_NO_HOOK_PROMPT: '1',
        FAKE_LAUNCH_LOG: launchLog,
      } as Record<string, string>,
    });
    app.onData((data) => terminal.write(data));
    app.onExit(() => {
      exited = true;
    });
    await waitFor(() => {
      const sidebar = readScreen(terminal).map((line) => line.slice(0, 34));
      return sidebar.some((line) => line.trim() === 'RECENT') && sidebar.some((line) => line.includes('recent smoke')) && sidebar.some((line) => line.trim() === 'TERMINAL') && sidebar.some((line) => line.includes('terminal smoke'));
    }, 'fake RECENT and TERMINAL discovery');
    const initialSidebar = readScreen(terminal).map((line) => line.slice(0, 34));
    assert.equal(initialSidebar.findIndex((line) => line.trim() === 'RECENT') < initialSidebar.findIndex((line) => line.trim() === 'TERMINAL'), true);
    assert.equal(initialSidebar.some((line) => line.includes('› ↺ recent smoke')), true);
    for (let row = 0; row < 29; row++) assert.equal(terminal.buffer.active.getLine(row)?.getCell(34)?.getChars(), '│');

    app.write('H');
    await waitFor(() => {
      const screen = readScreen(terminal);
      const sidebar = screen.map((line) => line.slice(0, 34));
      return screen[29].includes('RECENT HIDDEN (1) · H show') && !sidebar.some((line) => line.trim() === 'RECENT') && !sidebar.some((line) => line.includes('recent smoke')) && sidebar.some((line) => line.trim() === 'TERMINAL');
    }, 'hidden RECENT sidebar and status');
    assert.equal(fs.existsSync(launchLog), false);

    app.write('H');
    await waitFor(() => {
      const sidebar = readScreen(terminal).map((line) => line.slice(0, 34));
      return sidebar.some((line) => line.trim() === 'RECENT') && sidebar.some((line) => line.includes('recent smoke'));
    }, 'restored RECENT sidebar');
    assert.equal(fs.existsSync(launchLog), false);

    app.write('q');
    await waitFor(() => readScreen(terminal)[29].includes('Quit Envoy and kill all sessions?'), 'quit confirmation');
    app.write('y');
    await waitFor(() => exited, 'clean application quit');
  } finally {
    if (app && !exited) app.kill();
    terminal.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('RECENT visibility preserves selection, input modes, polling, and restart defaults', testRecentVisibilityManagerAndInput);
test('initial RECENT population selects only when startup selection is untouched', testInitialRecentSelection);
test('RECENT visibility toggles safely in a bounded fake-discovery PTY', { timeout: 15000 }, testRecentVisibilityPtySmoke);
