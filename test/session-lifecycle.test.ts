import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { hooksInstalled, installHooks } from '../src/hooks/installer';
import { DesktopNotifier } from '../src/notify';
import type { NotificationType } from '../src/session';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

/**
 * Verifies a three-hook config gains only the missing prompt hook and remains idempotent.
 * @returns Nothing after isolated config and backup files are removed.
 */
function testHookInstallation(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-hooks-'));
  const configPath = path.join(root, '.config', 'devin', 'config.json');
  const hookScript = path.resolve(__dirname, '..', 'bin', 'envoy-hook.sh');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const initial = {
      preserved: { enabled: true },
      hooks: {
        UserPromptSubmit: [{ matcher: 'third-party', hooks: [{ type: 'command', command: '/tmp/other-hook UserPromptSubmit' }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${hookScript} Stop` }] }],
        PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: `${hookScript} PermissionRequest` }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: `${hookScript} SessionEnd` }] }],
        OtherEvent: [{ matcher: 'keep', hooks: [{ type: 'command', command: '/tmp/keep-me' }] }],
      },
    };
    const raw = JSON.stringify(initial, null, 2) + '\n';
    fs.writeFileSync(configPath, raw);

    assert.equal(hooksInstalled(configPath), false);
    installHooks(configPath);
    assert.equal(hooksInstalled(configPath), true);
    assert.equal(fs.readFileSync(configPath + '.bak-envoy', 'utf8'), raw);

    const installed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(installed.preserved, initial.preserved);
    assert.deepEqual(installed.hooks.Stop, initial.hooks.Stop);
    assert.deepEqual(installed.hooks.PermissionRequest, initial.hooks.PermissionRequest);
    assert.deepEqual(installed.hooks.SessionEnd, initial.hooks.SessionEnd);
    assert.deepEqual(installed.hooks.OtherEvent, initial.hooks.OtherEvent);
    assert.equal(installed.hooks.UserPromptSubmit.length, 2);
    assert.equal(installed.hooks.UserPromptSubmit.filter((matcher: any) => matcher.hooks.some((hook: any) => hook.command.includes(hookScript))).length, 1);

    const once = fs.readFileSync(configPath, 'utf8');
    installHooks(configPath);
    assert.equal(fs.readFileSync(configPath, 'utf8'), once);
    assert.equal(fs.readFileSync(configPath + '.bak-envoy', 'utf8'), raw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Verifies prompt hooks, input forwarding, notifications, permission interaction, and exit state.
 * @returns Promise resolved after the fake session and temporary files are removed.
 */
async function testSessionLifecycle(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-lifecycle-'));
  const command = path.join(root, 'fake-devin');
  const previousCommand = process.env.ENVOY_CMD;
  const sent: NotificationType[] = [];
  try {
    fs.writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' HUP TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.ENVOY_CMD = command;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    let redraws = 0;
    const notifier = new DesktopNotifier(false);
    notifier.send = (_sessionId: string, _name: string, type: NotificationType): void => {
      sent.push(type);
    };
    const manager = new SessionManager(root, [root], new TagStore(configPath), () => {
      redraws++;
    }, notifier);
    const session = manager.create(root, 'lifecycle', 'code');

    assert.equal(session.status, 'waiting');
    assert.equal(session.memoryBytes, null);
    manager.assignDiscoveredSessionIds(new Map([[session.pid, { memoryBytes: 64 * 1024 ** 2 }]]));
    assert.equal(session.memoryBytes, 64 * 1024 ** 2);
    assert.equal(session.cliSessionId, null);
    manager.assignDiscoveredSessionIds(new Map());
    assert.equal(session.memoryBytes, null);
    assert.deepEqual(session.unread, []);
    session.input('typed text');
    session.input('\x1b[200~pasted line one\npasted line two\x1b[201~', true);
    session.input('\r');
    session.input('ordinary prompt\r');
    assert.equal(session.status, 'waiting');

    manager.detach();
    const beforePrompt = redraws;
    manager.applyEvent(session.id, 'UserPromptSubmit');
    assert.equal(session.status, 'working');
    assert.deepEqual(session.unread, []);
    assert.deepEqual(sent, []);
    assert.equal(redraws, beforePrompt + 1);

    manager.applyEvent(session.id, 'Stop');
    assert.equal(session.status, 'waiting');
    assert.deepEqual(session.unread.map((entry) => entry.type), ['stop']);
    assert.deepEqual(sent, ['stop']);

    manager.applyEvent(session.id, 'PermissionRequest');
    assert.equal(session.status, 'needs-permission');
    assert.deepEqual(session.unread.map((entry) => entry.type), ['stop', 'permission']);
    assert.deepEqual(sent, ['stop', 'permission']);
    session.input('');
    assert.equal(session.status, 'needs-permission');
    session.input('\r');
    assert.equal(session.status, 'working');

    session.memoryBytes = 96 * 1024 ** 2;
    manager.applyEvent(session.id, 'SessionEnd');
    assert.equal(session.status, 'exited');
    assert.equal(session.memoryBytes, null);
    assert.deepEqual(session.unread.map((entry) => entry.type), ['stop', 'permission', 'exit']);
    assert.deepEqual(sent, ['stop', 'permission', 'exit']);
    const beforeExitedPrompt = redraws;
    manager.applyEvent(session.id, 'UserPromptSubmit');
    assert.equal(session.status, 'exited');
    assert.deepEqual(sent, ['stop', 'permission', 'exit']);
    assert.equal(redraws, beforeExitedPrompt + 1);

    manager.killAll();
    session.term.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } finally {
    if (previousCommand === undefined) delete process.env.ENVOY_CMD;
    else process.env.ENVOY_CMD = previousCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('hook installer appends UserPromptSubmit once and preserves existing config', testHookInstallation);
test('session lifecycle uses UserPromptSubmit instead of input to enter working', testSessionLifecycle);
