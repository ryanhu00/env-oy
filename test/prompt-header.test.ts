import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Terminal } from '@xterm/headless';
import { InputHandler } from '../src/input';
import { EventsTailer } from '../src/notifications';
import { DesktopNotifier } from '../src/notify';
import { Session } from '../src/session';
import { SessionManager, SidebarEntry } from '../src/sessionManager';
import { TagStore } from '../src/tags';
import { Renderer, SIDEBAR_W } from '../src/ui/renderer';

const HOOK_SCRIPT = path.resolve(__dirname, '..', 'bin', 'conductor-hook.sh');

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

async function waitFor(predicate: () => boolean, message: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function runHook(eventsDir: string, event: string, payload: string, conductorId: string | null): string {
  const env: Record<string, string> = { ...process.env, DEVIN_CONDUCTOR_EVENTS_DIR: eventsDir } as Record<string, string>;
  if (conductorId) env.DEVIN_CONDUCTOR_ID = conductorId;
  else delete env.DEVIN_CONDUCTOR_ID;
  return execFileSync(HOOK_SCRIPT, [event], { input: payload, env, encoding: 'utf8' });
}

function testHookScriptPayload(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-hook-payload-'));
  const eventsFile = path.join(root, 'events.jsonl');
  try {
    const prompt = 'investigate the\tflaky login test\nand report back';
    assert.equal(runHook(root, 'UserPromptSubmit', JSON.stringify({ prompt, session_id: 'devin-1' }, null, 2), 'conductor-1'), '');
    let lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.id, 'conductor-1');
    assert.equal(record.event, 'UserPromptSubmit');
    assert.equal(typeof record.ts, 'number');
    assert.equal(record.payload.prompt, prompt);
    assert.equal(record.payload.session_id, 'devin-1');

    assert.equal(runHook(root, 'Stop', 'not json at all\n', 'conductor-1'), '');
    assert.equal(runHook(root, 'UserPromptSubmit', `{"prompt":"${'a'.repeat(70000)}"}`, 'conductor-1'), '');
    lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.id, 'conductor-1');
      assert.equal('payload' in parsed, false);
    }
    assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line).event), ['Stop', 'UserPromptSubmit']);

    // raw control bytes below 0x20 would otherwise make JSON.parse reject the whole line and drop the turn
    assert.equal(runHook(root, 'UserPromptSubmit', '{"prompt":"tab\there and\nnewline here","session_id":"devin-2"}', 'conductor-1'), '');
    lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    const stripped = JSON.parse(lines[3]);
    assert.equal(stripped.event, 'UserPromptSubmit');
    assert.equal(stripped.payload.prompt, 'tabhere andnewline here');
    assert.equal(stripped.payload.session_id, 'devin-2');

    const unownedDir = path.join(root, 'unowned');
    assert.equal(runHook(unownedDir, 'UserPromptSubmit', JSON.stringify({ prompt: 'ignored' }), null), '');
    assert.equal(fs.existsSync(unownedDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testTailerDispatchesPayload(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-tailer-payload-'));
  const eventsFile = path.join(root, 'events.jsonl');
  const received: Array<{ id: string; event: string; payload?: Record<string, unknown> }> = [];
  const tailer = new EventsTailer(root, (id, event, payload) => {
    received.push({ id, event, payload });
  });
  try {
    fs.writeFileSync(eventsFile, `${JSON.stringify({ id: 'pre-existing', event: 'Stop' })}\n`);
    tailer.start();
    fs.appendFileSync(eventsFile, `${JSON.stringify({ id: 'a', event: 'UserPromptSubmit', ts: 1, payload: { prompt: 'ship it' } })}\n`);
    fs.appendFileSync(eventsFile, '{"id":"b","event":"Stop","ts":2,"payload":["not-an-object"]}\n');
    fs.appendFileSync(eventsFile, '{"id":"c","event":"broken"\n');
    fs.appendFileSync(eventsFile, `${JSON.stringify({ id: 'd', event: 'PermissionRequest', ts: 3 })}\n`);
    await waitFor(() => received.length >= 3, 'tailed hook events');
    assert.deepEqual(received.map((entry) => entry.id), ['a', 'b', 'd']);
    assert.deepEqual(received[0].payload, { prompt: 'ship it' });
    assert.equal(received[1].payload, undefined);
    assert.equal(received[2].payload, undefined);
  } finally {
    tailer.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testManagerRecordsTurns(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-prompt-turns-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.DEVIN_CONDUCTOR_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.DEVIN_CONDUCTOR_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const session = manager.create(root, 'turns', 'code');
    const grow = (count: number): Promise<void> =>
      new Promise<void>((resolve) => session.term.write('output line\r\n'.repeat(count), resolve));

    assert.equal(session.promptForOffset(0), null);
    await grow(40);
    manager.applyEvent(session.id, 'UserPromptSubmit', { prompt: '   first    prompt\nsecond line   ' });
    assert.equal(session.status, 'working');
    await grow(40);
    manager.applyEvent(session.id, 'UserPromptSubmit', { prompt: 'later prompt' });
    manager.applyEvent(session.id, 'UserPromptSubmit', { prompt: '   ' });
    manager.applyEvent(session.id, 'Stop');
    await grow(40);

    const baseY = session.term.buffer.active.baseY;
    assert.equal(baseY > 80, true);
    assert.equal(session.promptForOffset(0), 'later prompt');
    assert.equal(session.promptForOffset(baseY - 79), 'first prompt second line');
    assert.equal(session.promptForOffset(baseY), null);

    const withoutPayload = manager.create(root, 'no-turns', 'code');
    manager.applyEvent(withoutPayload.id, 'UserPromptSubmit');
    assert.equal(withoutPayload.status, 'working');
    assert.equal(withoutPayload.promptForOffset(0), null);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previousCommand === undefined) delete process.env.DEVIN_CONDUCTOR_CMD;
    else process.env.DEVIN_CONDUCTOR_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testManagerTracksLastPromptAt(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-last-prompt-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.DEVIN_CONDUCTOR_CMD;
  let manager: SessionManager | null = null;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.DEVIN_CONDUCTOR_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const session = manager.create(root, 'prompted', 'code', undefined, { attach: false });
    assert.equal(manager.lastPromptAt, null);

    manager.applyEvent(session.id, 'Stop');
    manager.applyEvent(session.id, 'PermissionRequest');
    manager.applyEvent('not-a-session', 'UserPromptSubmit');
    assert.equal(manager.lastPromptAt, null);

    const before = Date.now();
    manager.applyEvent(session.id, 'UserPromptSubmit');
    const first = manager.lastPromptAt;
    assert.equal(typeof first, 'number');
    assert.equal(first! >= before, true);

    manager.lastPromptAt = first! + 60_000;
    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: 'devin-1' });
    assert.equal(manager.lastPromptAt, first! + 60_000);

    manager.lastPromptAt = null;
    manager.applyEvent(session.id, 'UserPromptSubmit', { session_id: 'devin-1' });
    assert.equal(typeof manager.lastPromptAt, 'number');

    manager.applyEvent(session.id, 'SessionEnd');
    assert.equal(session.status, 'exited');
    manager.lastPromptAt = null;
    manager.applyEvent(session.id, 'UserPromptSubmit');
    assert.equal(typeof manager.lastPromptAt, 'number');
    assert.equal(session.status, 'exited');
    assert.equal(manager.getRestartState().lastPromptAt, manager.lastPromptAt);

    manager.lastPromptAt = null;
    assert.equal('lastPromptAt' in manager.getRestartState(), false);
  } finally {
    manager?.killAll();
    for (const session of manager?.sessions ?? []) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (previousCommand === undefined) delete process.env.DEVIN_CONDUCTOR_CMD;
    else process.env.DEVIN_CONDUCTOR_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRendererPinsPromptHeader(): Promise<void> {
  const message = 'why does the login retry loop never terminate?';
  const terminal = new Terminal({ allowProposedApi: true, cols: 85, rows: 29 });
  const session = {
    id: 'attached',
    name: 'pinned',
    cwd: '/Users/example/projects/pinned',
    tag: 'code',
    term: terminal,
    devinSessionId: null,
    memoryBytes: null,
    status: 'waiting',
    unread: [],
    exited: false,
    scrollOffset: 0,
    promptForOffset: (): string | null => message,
  } as unknown as Session;
  const manager = {
    entries: [{ kind: 'active', session }] as SidebarEntry[],
    selected: 0,
    attachedId: 'attached',
    sessions: [session],
    discovery: { recents: [], totalMemoryBytes: 512 * 1024 ** 2 },
    tagStore: { tags: ['code'] },
    recentVisible: true,
    moveState: null,
    get attachedSession(): Session | undefined {
      return this.attachedId ? session : undefined;
    },
    get selectedSession(): Session | undefined {
      return session;
    },
    displayName(): string {
      return 'pinned';
    },
  } as unknown as SessionManager;
  const input = {
    mode: 'attached',
    attachedMode: 'normal',
    notice: '',
    confirm: null,
    form: null,
    rename: null,
    tagPicker: null,
    tagName: null,
    tagPosition: null,
  } as unknown as InputHandler;
  const renderer = new Renderer(manager, input, os.homedir()) as unknown as {
    frame: () => string;
    invalidate: () => void;
    prevRows: string[];
  };
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const host = new Terminal({ allowProposedApi: true, cols: 120, rows: 30 });
  try {
    await new Promise<void>((resolve) => {
      let content = '';
      for (let line = 0; line < 60; line++) content += `pane-content-${line}\r\n`;
      terminal.write(content, resolve);
    });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    const paneW = 120 - SIDEBAR_W - 1;
    const buffer = terminal.buffer.active;
    const lineAt = (row: number): string => buffer.getLine(row)?.translateToString(true) ?? '';

    session.scrollOffset = 6;
    renderer.invalidate();
    await new Promise<void>((resolve) => host.write(renderer.frame(), resolve));
    const scrolled = [];
    for (let row = 0; row < 30; row++) scrolled.push(host.buffer.active.getLine(row)?.translateToString(true) ?? '');
    assert.equal(scrolled[0].slice(SIDEBAR_W + 1).trim(), `▌ ${message}`);
    assert.equal(scrolled[1].slice(SIDEBAR_W + 1).trim(), lineAt(buffer.baseY - 6));
    assert.equal(scrolled[28].slice(SIDEBAR_W + 1).trim(), lineAt(buffer.baseY - 6 + 27));
    for (let row = 0; row < 29; row++) assert.equal(host.buffer.active.getLine(row)?.getCell(SIDEBAR_W)?.getChars(), '│');
    for (let row = 0; row < 29; row++) assert.equal(stripAnsi(renderer.prevRows[row]).length, SIDEBAR_W + 1 + paneW);

    session.scrollOffset = 0;
    renderer.invalidate();
    await new Promise<void>((resolve) => host.write(renderer.frame(), resolve));
    const live = [];
    for (let row = 0; row < 30; row++) live.push(host.buffer.active.getLine(row)?.translateToString(true) ?? '');
    assert.equal(live.some((row) => row.includes(message)), false);
    assert.equal(live[0].slice(SIDEBAR_W + 1).trim(), lineAt(buffer.baseY));
    for (let row = 0; row < 29; row++) assert.equal(host.buffer.active.getLine(row)?.getCell(SIDEBAR_W)?.getChars(), '│');
    for (let row = 0; row < 29; row++) assert.equal(stripAnsi(renderer.prevRows[row]).length, SIDEBAR_W + 1 + paneW);

    input.attachedMode = 'insert';
    renderer.invalidate();
    const insertFrame = renderer.frame();
    assert.equal(insertFrame.includes(`\x1b[${buffer.cursorY + 1};${SIDEBAR_W + 2 + Math.min(buffer.cursorX, paneW - 1)}H\x1b[?25h`), true);
    assert.equal(stripAnsi(insertFrame).includes(message), false);

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 38 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 3 });
    input.attachedMode = 'normal';
    session.scrollOffset = 6;
    renderer.invalidate();
    assert.doesNotThrow(() => renderer.frame());
    assert.equal(stripAnsi(renderer.prevRows[0]).length, SIDEBAR_W + 1 + 3);
  } finally {
    if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
    if (rowsDescriptor) Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    host.dispose();
    terminal.dispose();
  }
}

test('conductor hook appends the verbatim UserPromptSubmit payload without touching stdout', testHookScriptPayload);
test('events tailer dispatches parsed payloads and tolerates payload-free and malformed lines', testTailerDispatchesPayload);
test('UserPromptSubmit payloads record prompt turns resolvable by scroll offset', testManagerRecordsTurns);
test('every UserPromptSubmit stamps a monotonic global last-prompt time other events leave alone', testManagerTracksLastPromptAt);
test('attached NORMAL pins the current turn prompt above the scrolled pane', testRendererPinsPromptHeader);
