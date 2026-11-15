import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as pty from 'node-pty';

interface RunningApp {
  proc: pty.IPty;
  output: string;
  exited: boolean;
}

interface LaunchRecord {
  id: string;
  conductorId: string;
  pid: number;
}

const SHELL_PROMPT = '__DGUI_SHELL_PROMPT__';

/**
 * Polls an assertion predicate within a fixed integration-test bound.
 * @param predicate Condition checked every 50ms.
 * @param message Failure context included in a timeout error.
 * @param timeout Maximum wait in milliseconds.
 * @returns Promise resolved when the predicate becomes true.
 */
async function waitFor(predicate: () => boolean, message: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/**
 * Starts one command under a PTY with a parent shell that exposes premature job completion.
 * @param command Shell-quoted command under test.
 * @param cwd Isolated working directory.
 * @param env Complete environment for the child shell.
 * @returns Mutable PTY state containing output and exit status.
 */
function startApp(command: string, cwd: string, env: Record<string, string>): RunningApp {
  const running: RunningApp = {
    proc: pty.spawn('/bin/sh', ['-c', `${command}; printf '${SHELL_PROMPT}\\n'; sleep 30`], {
      name: 'xterm-256color',
      cols: 180,
      rows: 50,
      cwd,
      env,
    }),
    output: '',
    exited: false,
  };
  running.proc.onData((data) => {
    running.output += data;
  });
  running.proc.onExit(() => {
    running.exited = true;
  });
  return running;
}

/**
 * Reads fake Devin JSON-lines launch records.
 * @param file Launch-log path.
 * @returns Parsed launch records, or an empty array before the first launch.
 */
function readLaunches(file: string): LaunchRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LaunchRecord);
}

/**
 * Reads app Node process IDs recorded by the PATH wrapper.
 * @param file PID-log path.
 * @returns Numeric app process IDs in launch order.
 */
function readAppPids(file: string): number[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

/**
 * Checks whether an operating-system process still exists.
 * @param pid Process ID to probe without signaling.
 * @returns True while the process exists.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates one fresh session through the TUI and returns to the sidebar.
 * @param app Running PTY application.
 * @param launchLog Fake Devin launch log.
 * @param expectedLaunches Total launch count expected after creation.
 * @returns Promise resolved after the session is detached in sidebar mode.
 */
async function createSession(app: RunningApp, launchLog: string, expectedLaunches: number): Promise<void> {
  let marker = app.output.length;
  app.proc.write('n');
  await waitFor(() => app.output.slice(marker).includes(' NEW SESSION'), 'new-session form');
  app.proc.write('\r\r');
  await waitFor(() => app.output.slice(marker).includes(' TAG'), 'tag picker');
  marker = app.output.length;
  app.proc.write('\r');
  await waitFor(() => readLaunches(launchLog).length === expectedLaunches && app.output.slice(marker).includes(' INSERT'), 'fresh fake session');
  marker = app.output.length;
  app.proc.write('\x11');
  await waitFor(() => app.output.slice(marker).includes(' NORMAL'), 'attached normal mode');
  marker = app.output.length;
  app.proc.write('\x11');
  await waitFor(() => app.output.slice(marker).includes(' SIDEBAR'), 'return to sidebar');
}

/**
 * Confirms normal quit and waits for the parent shell prompt.
 * @param app Running PTY application.
 * @returns Promise resolved after the launcher or direct Node child exits.
 */
async function quitApp(app: RunningApp): Promise<void> {
  const marker = app.output.length;
  app.proc.write('q');
  await waitFor(() => app.output.slice(marker).includes('Quit devin-conductor and kill all sessions?'), 'quit confirmation');
  app.proc.write('y');
  await waitFor(() => app.output.slice(marker).includes(SHELL_PROMPT), 'parent shell prompt');
}

/**
 * Exercises launcher refresh continuity, direct-node refusal, cleanup, and missing-channel failure.
 * @returns Promise resolved after isolated PTYs and temporary processes are removed.
 */
async function testLauncherRefreshLifecycle(): Promise<void> {
  const projectRoot = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-e2e-'));
  const fakeBin = path.join(root, 'bin');
  const fakeDevin = path.join(fakeBin, 'devin');
  const fakeNode = path.join(fakeBin, 'node');
  const launchLog = path.join(root, 'launches.jsonl');
  const nodeLog = path.join(root, 'app-pids');
  const eventsDir = path.join(root, 'events');
  const configDir = path.join(root, '.config', 'devin-conductor');
  const channelDir = path.join(root, '.local', 'share', 'devin-conductor');
  let launcherApp: RunningApp | null = null;
  let directApp: RunningApp | null = null;
  let fatalApp: RunningApp | null = null;
  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ tags: ['alpha', 'beta'], desktop_notifications: false }));
    const realNode = process.execPath.replace(/'/g, `'"'"'`);
    fs.writeFileSync(fakeNode, `#!/bin/sh
case "$1" in
  */dist/index.js) printf '%s\\n' "$$" >> "$FAKE_NODE_LOG" ;;
esac
exec '${realNode}' "$@"
`, { mode: 0o700 });
    fs.writeFileSync(fakeDevin, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
if (process.argv[2] === 'list') {
  process.stdout.write('[]\\n');
  process.exit(0);
}
const resume = process.argv[2] === '-r';
const id = resume ? process.argv[3] : 'fresh-' + process.env.DEVIN_CONDUCTOR_ID;
process.title = 'devin';
fs.appendFileSync(process.env.FAKE_DEVIN_LAUNCH_LOG, JSON.stringify({ id, conductorId: process.env.DEVIN_CONDUCTOR_ID, pid: process.pid }) + '\\n');
const locks = path.join(os.homedir(), '.local', 'share', 'devin', 'session_locks');
fs.mkdirSync(locks, { recursive: true });
const lock = fs.openSync(path.join(locks, id + '.lock'), 'a');
process.on('SIGHUP', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o700 });
    const baseEnv = {
      ...process.env,
      HOME: root,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      DEVIN_CONDUCTOR_CMD: fakeDevin,
      DEVIN_CONDUCTOR_EVENTS_DIR: eventsDir,
      DEVIN_CONDUCTOR_NO_HOOK_PROMPT: '1',
      FAKE_DEVIN_LAUNCH_LOG: launchLog,
      FAKE_NODE_LOG: nodeLog,
    } as Record<string, string>;
    delete baseEnv.DEVIN_CONDUCTOR_RESTART_CHANNEL;

    const launcher = path.join(projectRoot, 'bin', 'dgui').replace(/'/g, `'"'"'`);
    launcherApp = startApp(`'${launcher}'`, root, baseEnv);
    await waitFor(() => launcherApp!.output.includes(' SIDEBAR') && readAppPids(nodeLog).length === 1, 'launcher app startup');
    assert.equal(fs.statSync(channelDir).mode & 0o777, 0o700);
    const idleMarker = launcherApp.output.length;
    await createSession(launcherApp, launchLog, 1);
    const idleOutput = launcherApp.output.slice(idleMarker);
    assert.equal(idleOutput.includes('○ IDLE'), true);
    assert.equal(idleOutput.includes('WORKING'), false);
    assert.equal(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].some((frame) => idleOutput.includes(frame)), false);
    const firstLaunch = readLaunches(launchLog)[0];
    let eventMarker = launcherApp.output.length;
    fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), JSON.stringify({ id: firstLaunch.conductorId, event: 'UserPromptSubmit', ts: Date.now() }) + '\n');
    await waitFor(() => launcherApp!.output.slice(eventMarker).includes('WORKING'), 'prompt hook working status');
    await waitFor(() => ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].filter((frame) => launcherApp!.output.slice(eventMarker).includes(frame)).length >= 2, 'working spinner animation');
    eventMarker = launcherApp.output.length;
    fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), JSON.stringify({ id: firstLaunch.conductorId, event: 'Stop', ts: Date.now() }) + '\n');
    await waitFor(() => launcherApp!.output.slice(eventMarker).includes('DONE — NEEDS YOU') && launcherApp!.output.slice(eventMarker).includes('●1'), 'detached stop status');

    await createSession(launcherApp, launchLog, 2);
    const firstLaunches = readLaunches(launchLog).slice(0, 2);
    fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), JSON.stringify({ id: firstLaunches[1].conductorId, event: 'Stop', ts: Date.now() }) + '\n');
    await waitFor(() => launcherApp!.output.includes('●1'), 'unread notification before refresh');

    let refreshMarker = launcherApp.output.length;
    let confirmed = false;
    for (let attempt = 0; attempt < 8 && !confirmed; attempt++) {
      refreshMarker = launcherApp.output.length;
      launcherApp.proc.write('R');
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      confirmed = launcherApp.output.slice(refreshMarker).includes('Refresh dgui and reconnect 2 idle sessions?');
    }
    assert.equal(confirmed, true);
    const firstNodePid = readAppPids(nodeLog)[0];
    launcherApp.proc.write('y');
    await waitFor(() => readAppPids(nodeLog).length >= 2 && readLaunches(launchLog).length >= 4, 'launcher replacement sessions', 12000);
    const replacementNodePid = readAppPids(nodeLog)[1];
    await waitFor(() => !isAlive(firstNodePid) && isAlive(replacementNodePid), 'first Node exit and replacement Node startup');
    await waitFor(() => launcherApp!.output.slice(refreshMarker).includes('session-1') && launcherApp!.output.slice(refreshMarker).includes('session-2') && launcherApp!.output.slice(refreshMarker).includes(' SIDEBAR'), 'replacement screen', 12000);
    assert.equal(launcherApp.output.slice(refreshMarker).includes(SHELL_PROMPT), false);
    assert.equal(launcherApp.exited, false);
    assert.deepEqual(readLaunches(launchLog).slice(2, 4).map((entry) => entry.id).sort(), firstLaunches.map((entry) => entry.id).sort());
    assert.equal(launcherApp.output.slice(refreshMarker).includes('●1'), true);
    for (const launch of firstLaunches) assert.equal(isAlive(launch.pid), false);
    assert.deepEqual(fs.readdirSync(channelDir).filter((name) => name.startsWith('restart-channel-')), []);
    assert.deepEqual(readAppPids(nodeLog).filter(isAlive), [replacementNodePid]);

    await quitApp(launcherApp);
    await waitFor(() => !isAlive(replacementNodePid), 'replacement Node quit');
    assert.deepEqual(readAppPids(nodeLog).filter(isAlive), []);
    assert.deepEqual(fs.readdirSync(channelDir).filter((name) => name.startsWith('restart-channel-')), []);
    launcherApp.proc.kill();
    await waitFor(() => launcherApp!.exited, 'launcher PTY cleanup');

    const dist = path.join(projectRoot, 'dist', 'index.js').replace(/'/g, `'"'"'`);
    directApp = startApp(`node '${dist}'`, root, baseEnv);
    await waitFor(() => directApp!.output.includes(' SIDEBAR') && readAppPids(nodeLog).length === 3, 'direct Node startup');
    await createSession(directApp, launchLog, 5);
    const directNodePid = readAppPids(nodeLog)[2];
    const directSessionPid = readLaunches(launchLog)[4].pid;
    const directMarker = directApp.output.length;
    directApp.proc.write('R');
    await waitFor(() => directApp!.output.slice(directMarker).includes('Cannot refresh: restart dgui once to enable the launcher'), 'direct Node launcher notice');
    assert.equal(isAlive(directNodePid), true);
    assert.equal(isAlive(directSessionPid), true);
    assert.equal(directApp.exited, false);
    await quitApp(directApp);
    await waitFor(() => !isAlive(directNodePid) && !isAlive(directSessionPid), 'direct Node normal quit');
    directApp.proc.kill();
    await waitFor(() => directApp!.exited, 'direct PTY cleanup');

    const fatalPrelude = path.join(root, 'fatal-prelude.js');
    fs.writeFileSync(fatalPrelude, "setTimeout(() => { throw new Error('synthetic fatal'); }, 500);\n");
    const prelude = fatalPrelude.replace(/'/g, `'"'"'`);
    fatalApp = startApp(`node --require '${prelude}' '${dist}'`, root, baseEnv);
    await waitFor(() => fatalApp!.output.includes(' SIDEBAR'), 'fatal app startup');
    const fatalMarker = fatalApp.output.length;
    await waitFor(() => fatalApp!.output.slice(fatalMarker).includes('devin-conductor crashed: Error: synthetic fatal') && fatalApp!.output.slice(fatalMarker).includes(SHELL_PROMPT), 'fatal cleanup');
    const finalRestore = '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l';
    assert.equal(fatalApp.output.slice(fatalMarker).split(finalRestore).length - 1, 1);
    fatalApp.proc.kill();
    await waitFor(() => fatalApp!.exited, 'fatal PTY cleanup');

    const missingHome = path.join(root, 'missing-home');
    const missingBin = path.join(root, 'missing-bin');
    fs.mkdirSync(missingHome);
    fs.mkdirSync(missingBin);
    fs.writeFileSync(path.join(missingBin, 'node'), '#!/bin/sh\nexit 75\n', { mode: 0o700 });
    const missing = spawnSync(path.join(projectRoot, 'bin', 'dgui'), [], {
      env: { ...process.env, HOME: missingHome, PATH: `${missingBin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /dgui refresh failed: restart channel missing/);
    const missingChannels = path.join(missingHome, '.local', 'share', 'devin-conductor');
    assert.deepEqual(fs.readdirSync(missingChannels).filter((name) => name.startsWith('restart-channel-')), []);
  } finally {
    if (launcherApp && !launcherApp.exited) launcherApp.proc.kill();
    if (directApp && !directApp.exited) directApp.proc.kill();
    if (fatalApp && !fatalApp.exited) fatalApp.proc.kill();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('stable launcher refreshes in one foreground job and direct Node refuses refresh', { timeout: 40000 }, testLauncherRefreshLifecycle);
