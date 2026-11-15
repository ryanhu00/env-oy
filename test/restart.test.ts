import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { InputHandler } from '../src/input';
import { DesktopNotifier } from '../src/notify';
import { RESTART_STATE_VERSION, RestartState, consumeRestartState, validateRestartChannelPath, validateRestartState, writeRestartState } from '../src/restart';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

/**
 * Verifies atomic private handoff persistence, defensive validation, and consume deletion.
 * @returns Promise resolved after isolated temporary artifacts are removed.
 */
async function testRestartStateFiles(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-state-'));
  const dataDir = path.join(root, '.local', 'share', 'devin-conductor');
  try {
    const state: RestartState = {
      version: RESTART_STATE_VERSION,
      selectedSessionId: 'session-b',
      sessions: [
        {
          devinSessionId: 'session-a',
          cwd: root,
          name: 'original A',
          tag: 'code',
          unread: [{ type: 'stop', ts: 10 }, { type: 'permission', ts: 20 }],
          status: 'waiting',
        },
      ],
    };
    const file = path.join(dataDir, 'restart-channel-unit');
    assert.equal(writeRestartState(state, file, dataDir), file);
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes('.tmp')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), state);
    assert.deepEqual(consumeRestartState(file, ['code']), state);
    assert.equal(fs.existsSync(file), false);
    assert.equal(validateRestartChannelPath(file, dataDir), file);
    assert.equal(validateRestartChannelPath('restart-channel-relative', dataDir), null);
    assert.equal(validateRestartChannelPath(path.join(dataDir, 'wrong-prefix'), dataDir), null);
    assert.equal(validateRestartChannelPath(path.join(dataDir, 'nested', 'restart-channel-child'), dataDir), null);
    assert.equal(validateRestartChannelPath(path.join(root, 'restart-channel-outside'), dataDir), null);
    assert.throws(() => writeRestartState(state, path.join(root, 'restart-channel-outside'), dataDir), /Invalid restart channel/);

    const mixed = validateRestartState({
      version: RESTART_STATE_VERSION,
      selectedSessionId: 42,
      sessions: [
        state.sessions[0],
        { ...state.sessions[0], devinSessionId: 'bad-tag', tag: 'missing' },
        { ...state.sessions[0], devinSessionId: 'bad-unread', unread: [{ type: 'bogus', ts: 1 }] },
        { ...state.sessions[0], devinSessionId: 'bad-status', status: 'exited' },
        { ...state.sessions[0] },
      ],
    }, ['code']);
    assert.equal(mixed?.selectedSessionId, null);
    assert.deepEqual(mixed?.sessions, state.sessions);

    const withPrompt: RestartState = { ...state, lastPromptAt: 1_700_000_000_000 };
    const promptFile = path.join(dataDir, 'restart-channel-prompt');
    assert.equal(writeRestartState(withPrompt, promptFile, dataDir), promptFile);
    assert.deepEqual(consumeRestartState(promptFile, ['code']), withPrompt);
    assert.equal('lastPromptAt' in (validateRestartState(state, ['code']) as object), false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1700000000000', null, {}]) {
      const dropped = validateRestartState({ ...state, lastPromptAt: bad }, ['code']);
      assert.equal('lastPromptAt' in (dropped as object), false);
      assert.deepEqual(dropped?.sessions, state.sessions);
    }

    const malformed = path.join(dataDir, 'restart-channel-malformed');
    fs.writeFileSync(malformed, '{not-json', { mode: 0o600 });
    assert.equal(consumeRestartState(malformed, ['code']), null);
    assert.equal(fs.existsSync(malformed), false);
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes('.tmp')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Verifies non-attaching manager restore, ordering, aliases, unread state, selection, and refresh UX.
 * @returns Promise resolved after fake PTYs and temporary configuration are cleaned up.
 */
async function testManagerRestoreAndRefreshInput(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-manager-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.DEVIN_CONDUCTOR_CMD;
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.DEVIN_CONDUCTOR_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      tags: ['alpha', 'beta'],
      session_order: { alpha: ['session-b', 'session-a'] },
      session_aliases: { 'session-a': 'Alias A', 'session-b': 'Alias B' },
    }));
    const manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const state: RestartState = {
      version: RESTART_STATE_VERSION,
      selectedSessionId: 'session-a',
      lastPromptAt: 1_700_000_000_000,
      sessions: [
        { devinSessionId: 'session-a', cwd: root, name: 'Original A', tag: 'alpha', unread: [{ type: 'stop', ts: 10 }], status: 'waiting' },
        { devinSessionId: 'session-b', cwd: root, name: 'Original B', tag: 'alpha', unread: [{ type: 'permission', ts: 20 }], status: 'needs-permission' },
        { devinSessionId: 'session-invalid', cwd: root, name: 'Invalid', tag: 'missing', unread: [], status: 'waiting' },
      ],
    };
    const restored = manager.restoreRestartState(state);
    assert.equal(restored.length, 2);
    assert.equal(manager.attachedId, null);
    assert.deepEqual(manager.entries.filter((entry) => entry.kind === 'active').map((entry) => entry.kind === 'active' ? entry.session.devinSessionId : null), ['session-b', 'session-a']);
    assert.equal(manager.selectedSession?.devinSessionId, 'session-a');
    assert.equal(manager.lastPromptAt, 1_700_000_000_000);
    assert.equal(manager.getRestartState().lastPromptAt, 1_700_000_000_000);
    assert.equal(manager.displayName(restored[0]), 'Alias A');
    assert.deepEqual(restored[0].unread, [{ type: 'stop', ts: 10 }]);
    assert.equal(restored[0].status, 'waiting');
    assert.equal(restored[0].suppressNotifications, false);
    assert.deepEqual(restored[1].unread, [{ type: 'permission', ts: 20 }]);
    assert.equal(restored[1].status, 'needs-permission');
    assert.equal(manager.getRefreshReadiness().ready, false);

    restored[1].status = 'waiting';
    let refreshes = 0;
    const input = new InputHandler(manager, () => {}, () => {}, true, () => {
      refreshes++;
    }, root);
    input.handle('R');
    assert.equal(input.mode, 'confirm');
    assert.equal(input.confirm?.question, 'Refresh dgui and reconnect 2 idle sessions? Draft text and local scrollback will be lost.');
    input.handle('n');
    assert.equal(refreshes, 0);
    assert.equal(manager.sessions.every((session) => !session.exited), true);
    const directInput = new InputHandler(manager, () => {}, () => {}, false, () => {
      refreshes++;
    }, root);
    directInput.handle('R');
    assert.equal(directInput.notice, 'Cannot refresh: restart dgui once to enable the launcher');
    assert.equal(refreshes, 0);
    const failingInput = new InputHandler(manager, () => {}, () => {}, true, async () => {
      throw new Error('Cannot refresh: channel write failed');
    }, root);
    failingInput.handle('R');
    failingInput.handle('y');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(failingInput.notice, 'Cannot refresh: channel write failed');
    assert.equal(manager.sessions.every((session) => !session.exited), true);
    input.handle('r');
    assert.equal(input.mode, 'rename');
    input.handle('\x1b');

    restored[0].status = 'working';
    input.handle('R');
    assert.equal(input.notice, 'Cannot refresh: Alias A is WORKING');
    restored[0].status = 'waiting';
    restored[1].status = 'needs-permission';
    input.handle('R');
    assert.equal(input.notice, 'Cannot refresh: Alias B needs permission');
    restored[1].status = 'waiting';
    restored[0].devinSessionId = null;
    input.handle('R');
    assert.equal(input.notice, 'Cannot refresh: waiting for Devin ID for Original A');

    manager.killAll();
    for (const session of manager.sessions) session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } finally {
    if (previousCommand === undefined) delete process.env.DEVIN_CONDUCTOR_CMD;
    else process.env.DEVIN_CONDUCTOR_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('restart state files are private, atomic, validated, and consumed once', testRestartStateFiles);
test('manager restore and refresh input preserve session state without attachment', testManagerRestoreAndRefreshInput);
