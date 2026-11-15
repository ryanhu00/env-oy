import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Terminal } from '@xterm/headless';
import { InputHandler } from '../src/input';
import { DesktopNotifier } from '../src/notify';
import { RESTART_STATE_VERSION, validateRestartState } from '../src/restart';
import type { Notification, Session, SessionStatus } from '../src/session';
import { SessionManager, SidebarEntry } from '../src/sessionManager';
import { TagStore } from '../src/tags';
import { Renderer, SIDEBAR_W } from '../src/ui/renderer';
import { BG_SELECT, BG_UNREAD, BOLD, ERROR, WARN } from '../src/ui/theme';

const FAKE_DEVIN = "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function createFixture(status: SessionStatus, markedDone: boolean, unread: Notification[] = [], selected = -1): {
  renderer: Renderer;
  session: Session;
} {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  const session = {
    id: 'owned',
    name: 'flagged session',
    cwd: '/Users/example/projects/flagged',
    tag: 'code',
    term: terminal,
    adapterId: 'devin',
    cliSessionId: null,
    memoryBytes: 512 * 1024 ** 2,
    status,
    unread,
    markedDone,
    exited: status === 'exited',
    scrollOffset: 0,
  } as unknown as Session;
  const manager = {
    entries: [{ kind: 'active', session }] as SidebarEntry[],
    selected,
    attachedId: null,
    sessions: [session],
    discovery: { recents: [], totalMemoryBytes: null, memoryByAdapter: new Map() },
    adapters: [{ id: 'devin', label: 'Devin', badge: 'DV' }],
    badgeFor: (): string => '',
    tagStore: { tags: ['code'] },
    recentVisible: true,
    moveState: null,
    displayName: (target: SidebarEntry | Session): string => ('kind' in target ? 'flagged session' : target.name),
  } as unknown as SessionManager;
  const input = {
    mode: 'sidebar',
    attachedMode: 'normal',
    notice: '',
    confirm: null,
    form: null,
    rename: null,
    tagPicker: null,
    tagName: null,
    tagPosition: null,
  } as unknown as InputHandler;
  return { renderer: new Renderer(manager, input, os.homedir()), session };
}

function sidebarFor(status: SessionStatus, markedDone: boolean, unread: Notification[] = [], selected = -1): { lines: string[]; plain: string[]; nameRow: number } {
  const fixture = createFixture(status, markedDone, unread, selected);
  try {
    const lines = (fixture.renderer as unknown as { sidebarLines: (height: number) => string[] }).sidebarLines(24);
    const plain = lines.map(stripAnsi);
    assert.equal(plain.every((line) => line.length === SIDEBAR_W), true);
    return { lines, plain, nameRow: plain.findIndex((line) => line.includes('flagged session')) };
  } finally {
    fixture.session.term.dispose();
  }
}

async function testSidebarFlagToggle(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-marked-done-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.ENVOY_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, FAKE_DEVIN, { mode: 0o700 });
    process.env.ENVOY_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    let redraws = 0;
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {
      redraws++;
    }, new DesktopNotifier(false));
    const input = new InputHandler(manager, () => {}, () => {}, true, () => {}, root);
    assert.deepEqual(manager.entries, []);
    input.handle('d');
    assert.equal(input.notice, '');

    const session = manager.create(root, 'flagged', 'code', undefined, { attach: false });
    manager.selected = 0;
    assert.equal(session.markedDone, false);
    const beforeToggle = redraws;
    input.handle('d');
    assert.equal(session.markedDone, true);
    assert.equal(input.notice, '');
    assert.equal(redraws > beforeToggle, true);
    input.handle('d');
    assert.equal(session.markedDone, false);

    manager.discovery.externals = [{ adapterId: 'devin', pid: 424242, sessionId: 'external-one', cwd: root, title: 'terminal one', lastAgo: 'now', memoryBytes: null }];
    manager.discovery.recents = [{ adapterId: 'devin', sessionId: 'recent-one', cwd: root, title: 'recent one', lastAgo: '1m', lastActivityAt: 10 }];
    manager.selected = manager.entries.findIndex((entry) => entry.kind === 'external');
    input.handle('d');
    assert.equal(input.notice, 'd only flags ACTIVE sessions');
    assert.equal(manager.sessions.some((entry) => entry.markedDone), false);
    manager.selected = manager.entries.findIndex((entry) => entry.kind === 'recent');
    input.handle('d');
    assert.equal(input.notice, 'd only flags ACTIVE sessions');
    assert.equal(manager.sessions.some((entry) => entry.markedDone), false);

    manager.toggleMarkedDone(session);
    assert.equal(session.markedDone, true);
    manager.attach(session);
    assert.equal(session.markedDone, false);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previousCommand === undefined) delete process.env.ENVOY_CMD;
    else process.env.ENVOY_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFlaggedSidebarStatusAndBadge(): void {
  const waiting = sidebarFor('waiting', true);
  assert.equal(waiting.plain.some((line) => line.includes('◆ DONE — NEEDS YOU')), true);
  assert.equal(waiting.plain.some((line) => line.includes('IDLE')), false);
  assert.equal(waiting.plain[waiting.nameRow].endsWith('◆'), true);
  assert.equal(waiting.lines[waiting.nameRow].startsWith(BG_UNREAD), true);

  const working = sidebarFor('working', true);
  assert.equal(working.plain.some((line) => line.includes('WORKING')), true);
  assert.equal(working.plain.some((line) => line.includes('DONE — NEEDS YOU')), false);
  assert.equal(working.lines[working.nameRow].includes(BOLD + WARN + '◆'), true);
  assert.equal(working.lines[working.nameRow].startsWith(BG_UNREAD), true);

  const permission = sidebarFor('needs-permission', true);
  assert.equal(permission.plain.some((line) => line.includes('! PERMISSION NEEDED')), true);
  assert.equal(permission.plain.some((line) => line.includes('DONE — NEEDS YOU')), false);

  const exited = sidebarFor('exited', true);
  assert.equal(exited.plain.some((line) => line.includes('× EXITED — NEEDS YOU')), true);

  const unread = sidebarFor('waiting', true, [{ type: 'stop', ts: 1 }, { type: 'permission', ts: 2 }]);
  assert.equal(unread.plain.some((line) => line.includes('◆ DONE — NEEDS YOU')), true);
  assert.equal(unread.lines[unread.nameRow].includes(BOLD + ERROR + '●2'), true);
  assert.equal(unread.plain[unread.nameRow].endsWith('●2'), true);

  const plainRow = sidebarFor('waiting', false);
  assert.equal(plainRow.plain.some((line) => line.includes('○ IDLE')), true);
  assert.equal(plainRow.lines[plainRow.nameRow].startsWith(BG_UNREAD), false);
  assert.equal(plainRow.plain[plainRow.nameRow].endsWith('◆'), false);

  const selectedRow = sidebarFor('waiting', true, [], 0);
  assert.equal(selectedRow.lines[selectedRow.nameRow].startsWith(BG_SELECT), true);
  assert.equal(selectedRow.plain[selectedRow.nameRow].endsWith('◆'), true);
}

async function testFlagRestartRoundTrip(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-marked-done-restart-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.ENVOY_CMD;
  let manager: SessionManager | null = null;
  let replacement: SessionManager | null = null;
  try {
    fs.writeFileSync(command, FAKE_DEVIN, { mode: 0o700 });
    process.env.ENVOY_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const session = manager.create(root, 'flagged', 'code', 'session-a', { attach: false });
    manager.toggleMarkedDone(session);
    const state = manager.getRestartState();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].markedDone, true);
    const validated = validateRestartState(state, ['code']);
    assert.equal(validated?.sessions[0].markedDone, true);

    const invalid = validateRestartState({
      version: RESTART_STATE_VERSION,
      selectedSessionId: null,
      sessions: [{ ...state.sessions[0], markedDone: 'yes' }],
    }, ['code']);
    assert.deepEqual(invalid?.sessions, []);

    const legacy = validateRestartState({
      version: 1,
      selectedSessionId: null,
      sessions: [{ devinSessionId: 'session-legacy', cwd: root, name: 'legacy', tag: 'code', unread: [], status: 'waiting' }],
    }, ['code']);
    assert.equal(legacy?.sessions.length, 1);
    assert.equal(legacy?.sessions[0].markedDone ?? false, false);

    replacement = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const restored = replacement.restoreRestartState({
      version: RESTART_STATE_VERSION,
      selectedSessionId: null,
      sessions: [validated!.sessions[0], legacy!.sessions[0]],
    });
    assert.equal(restored.length, 2);
    assert.equal(restored.find((entry) => entry.cliSessionId === 'session-a')?.markedDone, true);
    assert.equal(restored.find((entry) => entry.cliSessionId === 'session-legacy')?.markedDone, false);
    assert.deepEqual(restored[0].unread, []);
    assert.equal(replacement.attachedId, null);
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

test('sidebar d toggles the manual DONE flag on ACTIVE rows only and attaching clears it', testSidebarFlagToggle);
test('flagged rows show DONE — NEEDS YOU without overriding working or permission status', testFlaggedSidebarStatusAndBadge);
test('manual DONE flag survives a validated restart handoff', testFlagRestartRoundTrip);
