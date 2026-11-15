import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import { Terminal } from '@xterm/headless';
import { InputHandler } from '../src/input';
import { Session } from '../src/session';
import { SessionManager, SidebarEntry } from '../src/sessionManager';
import { Renderer, SIDEBAR_W, formatAgo, formatMemory } from '../src/ui/renderer';
import { BG_UNREAD } from '../src/ui/theme';

/**
 * Removes ANSI control sequences so renderer output can be checked by visible text.
 * @param value Styled terminal text.
 * @returns Plain visible text.
 */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Builds a lightweight renderer fixture without spawning processes.
 * @param unread Whether the active row should use unread styling.
 * @returns Renderer dependencies plus the active and external entries.
 */
function createFixture(unread = false): {
  renderer: Renderer;
  manager: SessionManager;
  input: InputHandler;
  active: Session;
  external: SidebarEntry;
} {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  const active = {
    id: 'owned',
    name: 'A very long active title that wraps across several sidebar lines without overflowing the fixed width',
    cwd: '/Users/example/projects/a-very-long-project-directory',
    tag: 'code',
    term: terminal,
    devinSessionId: null,
    memoryBytes: 1536 * 1024 ** 2,
    status: 'working',
    unread: unread ? [{ type: 'stop', ts: 1 }] : [],
    exited: false,
    scrollOffset: 0,
  } as unknown as Session;
  const external: SidebarEntry = {
    kind: 'external',
    external: {
      pid: 202,
      sessionId: 'external-id',
      cwd: '/Users/example/projects/external-long-directory',
      title: 'A long external title that wraps while selected in the terminal section',
      lastAgo: 'now',
      memoryBytes: 768 * 1024 ** 2,
    },
  };
  const manager = {
    entries: [{ kind: 'active', session: active }, external] as SidebarEntry[],
    selected: 0,
    attachedId: null,
    sessions: [active],
    lastPromptAt: Date.now() - 190_000,
    discovery: { recents: [], totalMemoryBytes: 2304 * 1024 ** 2 },
    tagStore: { tags: ['code'] },
    recentVisible: true,
    moveState: null,
    get attachedSession(): Session | undefined {
      return this.attachedId ? active : undefined;
    },
    get selectedSession(): Session | undefined {
      const entry = this.entries[this.selected];
      return entry?.kind === 'active' ? entry.session : undefined;
    },
    displayName(target: SidebarEntry | Session): string {
      if ('kind' in target) return target.kind === 'external' ? target.external.title : target.kind === 'recent' ? target.recent.title : target.session.name;
      return target.name;
    },
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
  return { renderer: new Renderer(manager, input, os.homedir()), manager, input, active, external };
}

/**
 * Verifies binary formatting at null, MB, rounding, and GiB boundaries.
 * @returns Nothing after synchronous formatter assertions.
 */
function testFormatMemory(): void {
  assert.equal(formatMemory(null), '—');
  assert.equal(formatMemory(0), '0 MB');
  assert.equal(formatMemory(512 * 1024 ** 2), '512 MB');
  assert.equal(formatMemory(1024 ** 3 - 1), '1024 MB');
  assert.equal(formatMemory(1024 ** 3), '1.0 GB');
  assert.equal(formatMemory(2560 * 1024 ** 2), '2.5 GB');
}

function testFormatAgo(): void {
  const now = 1_700_000_000_000;
  assert.equal(formatAgo(null, now), '—');
  assert.equal(formatAgo(now, now), 'just now');
  assert.equal(formatAgo(now - 59_000, now), 'just now');
  assert.equal(formatAgo(now - 60_000, now), '1m ago');
  assert.equal(formatAgo(now - 3_599_000, now), '59m ago');
  assert.equal(formatAgo(now - 3_600_000, now), '1h ago');
  assert.equal(formatAgo(now - 100 * 3_600_000, now), '100h ago');
  assert.equal(formatAgo(now + 5_000, now), 'just now');
  assert.equal(formatAgo(Number.NaN, now), '—');
  assert.equal(formatAgo(Number.POSITIVE_INFINITY, now), '—');
  assert.equal(formatAgo(-1, now), '—');
}

/**
 * Checks variable-height memory rows, unread backgrounds, wrapping, and synchronized diff animation.
 * @returns Nothing after renderer terminals are disposed.
 */
function testSidebarMemoryLayout(): void {
  const fixture = createFixture(true);
  try {
    const renderer = fixture.renderer as unknown as {
      sidebarLines: (height: number) => string[];
      frame: () => string;
      spinnerFrame: number;
      invalidate: () => void;
    };
    fixture.manager.selected = 1;
    const lines = renderer.sidebarLines(24);
    const plain = lines.map(stripAnsi);
    const nameIndex = plain.findIndex((line) => line.includes('A very long active'));
    const memoryIndex = plain.findIndex((line) => line.includes('1.5 GB'));
    const statusIndex = plain.findIndex((line) => line.includes('WORKING'));
    assert.equal(nameIndex > 0, true);
    assert.equal(memoryIndex > 0, true);
    assert.equal(statusIndex, memoryIndex + 1);
    assert.equal(lines[memoryIndex].startsWith(BG_UNREAD), true);
    assert.equal(lines[statusIndex].startsWith(BG_UNREAD), true);
    assert.equal(plain[memoryIndex + 3].trim(), 'TERMINAL');
    assert.equal(lines.every((line) => stripAnsi(line).length === SIDEBAR_W), true);
    assert.equal(memoryIndex - nameIndex > 1, true);

    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    try {
      renderer.invalidate();
      renderer.frame();
      renderer.spinnerFrame = 1;
      const diff = renderer.frame();
      assert.equal(diff.includes(`\x1b[${nameIndex + 1};1H`), true);
      assert.equal(diff.includes(`\x1b[${statusIndex + 1};1H`), true);
      assert.equal(diff.includes(`\x1b[${memoryIndex + 1};1H`), false);
    } finally {
      if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
      if (rowsDescriptor) Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    }
  } finally {
    fixture.active.term.dispose();
  }
}

/**
 * Verifies TERMINAL memory rows, every representative status mode suffix, separator placement, and narrow safety.
 * @returns Promise resolved after the host terminal consumes all rendered frames.
 */
async function testStatusSuffixAndTerminalLayout(): Promise<void> {
  const fixture = createFixture();
  const renderer = fixture.renderer as unknown as {
    sidebarLines: (height: number) => string[];
    frame: () => string;
    invalidate: () => void;
  };
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  try {
    fixture.manager.selected = 1;
    const terminalLines = renderer.sidebarLines(24).map(stripAnsi);
    const memoryIndex = terminalLines.findIndex((line) => line.includes('768 MB'));
    assert.equal(memoryIndex > 0, true);
    assert.equal(terminalLines[memoryIndex + 1].trim(), 'terminal');
    assert.equal(terminalLines.every((line) => line.length === SIDEBAR_W), true);

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    const cases: Array<() => void> = [
      () => {
        fixture.input.mode = 'sidebar';
        fixture.input.notice = '';
        fixture.manager.recentVisible = true;
      },
      () => {
        fixture.input.mode = 'confirm';
        fixture.input.confirm = { question: 'Confirm action?', onYes: () => {} };
      },
      () => {
        fixture.input.mode = 'move';
        (fixture.manager as unknown as { moveState: { session: Session; tag: string } | null }).moveState = { session: fixture.active, tag: 'code' };
      },
      () => {
        fixture.manager.attachedId = fixture.active.id;
        fixture.input.mode = 'attached';
        fixture.input.attachedMode = 'insert';
      },
      () => {
        fixture.input.mode = 'attached';
        fixture.input.attachedMode = 'normal';
      },
      () => {
        fixture.manager.attachedId = null;
        fixture.input.mode = 'form';
        fixture.input.form = { field: 0, cwd: '/', name: '', error: '' };
      },
      () => {
        fixture.input.mode = 'rename';
        fixture.input.rename = { target: { kind: 'active', session: fixture.active }, section: 'ACTIVE', original: 'old', value: 'new', error: '' };
      },
      () => {
        fixture.input.mode = 'tag-picker';
        fixture.input.tagPicker = { selected: 0 };
      },
      () => {
        fixture.input.mode = 'tag-name';
        fixture.input.tagName = { value: 'new-tag', error: '' };
      },
      () => {
        fixture.input.mode = 'tag-position';
        fixture.input.tagPosition = { name: 'new-tag', selected: 0, error: '' };
      },
      () => {
        fixture.input.mode = 'sidebar';
        fixture.input.notice = 'A retained notice';
      },
      () => {
        fixture.input.notice = '';
        fixture.manager.attachedId = null;
        fixture.manager.recentVisible = false;
      },
    ];
    for (const configure of cases) {
      configure();
      renderer.invalidate();
      assert.equal(stripAnsi(renderer.frame()).includes('PROMPT 3m ago · DEVIN 2.3 GB'), true);
    }
    fixture.manager.discovery.totalMemoryBytes = null;
    fixture.manager.lastPromptAt = null;
    renderer.invalidate();
    assert.equal(stripAnsi(renderer.frame()).includes('PROMPT — · DEVIN —'), true);
    fixture.manager.discovery.totalMemoryBytes = 2304 * 1024 ** 2;
    fixture.manager.lastPromptAt = Date.now() - 190_000;

    fixture.manager.recentVisible = true;
    fixture.input.mode = 'sidebar';
    renderer.invalidate();
    renderer.frame();
    // a freshness tick that changes no visible text must not repaint any row
    assert.equal(renderer.frame(), '\x1b[?25l');
    const host = new Terminal({ allowProposedApi: true, cols: 120, rows: 30 });
    renderer.invalidate();
    await new Promise<void>((resolve) => host.write(renderer.frame(), resolve));
    for (let row = 0; row < 29; row++) assert.equal(host.buffer.active.getLine(row)?.getCell(34)?.getChars(), '│');
    assert.equal(host.buffer.active.getLine(29)?.translateToString(true).endsWith('PROMPT 3m ago · DEVIN 2.3 GB'), true);
    host.dispose();

    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 5 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 4 });
    renderer.invalidate();
    assert.doesNotThrow(() => renderer.frame());
  } finally {
    if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
    if (rowsDescriptor) Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    fixture.active.term.dispose();
  }
}

test('formatMemory uses compact binary MB and GB boundaries', testFormatMemory);
test('formatAgo matches the RECENT relative convention and tolerates unusable timestamps', testFormatAgo);
test('ACTIVE memory/status rows preserve wrapping, unread backgrounds, and line-diff animation', testSidebarMemoryLayout);
test('TERMINAL rows and representative status modes render memory safely', testStatusSuffixAndTerminalLayout);
