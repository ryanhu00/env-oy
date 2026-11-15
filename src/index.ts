import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { EventsTailer } from './notifications';
import { DesktopNotifier } from './notify';
import { InputHandler } from './input';
import { Renderer, SIDEBAR_W } from './ui/renderer';
import { CONFIG_PATH, hooksInstalled, installHooks } from './hooks/installer';
import { consumeRestartState, validateRestartChannelPath, writeRestartState } from './restart';
import { TagStore } from './tags';
import { HaeinClient } from './haein/client';
import { HaeinControlServer, controlSocketPath, sendFocusRequest } from './haein/control';
import { HaeinRuntime } from './haein/runtime';

/**
 * Runs dgui, including launcher-channel restore and idempotent terminal lifecycle handling.
 * @returns Nothing; the process exits through normal quit, fatal cleanup, or launcher refresh.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const socketFlag = args.indexOf('--haein-socket');
  const haeinSocket = socketFlag >= 0 ? args[socketFlag + 1] : undefined;
  const focusFlag = args.indexOf('--focus-task');
  const focusTaskId = focusFlag >= 0 ? args[focusFlag + 1] : undefined;
  const focusOnly = args.includes('--focus-only');
  if ((socketFlag >= 0 && !haeinSocket) || (focusFlag >= 0 && !focusTaskId) || (focusOnly && (!haeinSocket || !focusTaskId))) {
    process.stderr.write('Usage: dgui [--haein-socket <path> --focus-task <id> [--focus-only]]\n');
    process.exitCode = 1;
    return;
  }
  if (focusOnly && haeinSocket && focusTaskId) {
    try {
      const response = await sendFocusRequest(controlSocketPath(haeinSocket), focusTaskId);
      if (!response.ok) throw new Error(response.error || 'focus request rejected');
    } catch (error) {
      process.stderr.write(`dgui: ${error instanceof Error ? error.message : 'could not focus Haein task'}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('devin-conductor must be run in an interactive terminal\n');
    process.exit(1);
  }
  const eventsDir = process.env.DEVIN_CONDUCTOR_EVENTS_DIR || path.join(os.homedir(), '.local', 'share', 'devin-conductor');
  const restartChannelPath = validateRestartChannelPath(process.env.DEVIN_CONDUCTOR_RESTART_CHANNEL);
  const hasRestartState = restartChannelPath !== null && fs.existsSync(restartChannelPath);
  const tagStore = new TagStore();
  const restartState = hasRestartState ? consumeRestartState(restartChannelPath, tagStore.tags) : null;
  let defaultCwd = process.cwd();
  let desktopNotifications = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(tagStore.configPath, 'utf8'));
    if (cfg.desktop_notifications === false) desktopNotifications = false;
    const dir = path.resolve(String(cfg.default_cwd).replace(/^~(?=$|\/)/, os.homedir()));
    if (fs.statSync(dir).isDirectory()) defaultCwd = dir;
  } catch {}

  let renderer: Renderer;
  let input: InputHandler;
  let renderEnabled = false;
  let runtimeStopped = false;
  let terminalEntered = false;
  let terminalRestored = false;
  const manager = new SessionManager(
    eventsDir,
    [...new Set([defaultCwd, process.cwd()])],
    tagStore,
    () => {
      if (renderEnabled) renderer.schedule();
    },
    new DesktopNotifier(desktopNotifications)
  );
  const haeinClient = haeinSocket ? new HaeinClient(haeinSocket) : null;
  let haeinRuntime: HaeinRuntime | null = null;
  let haeinControl: HaeinControlServer | null = null;
  if (haeinClient) haeinRuntime = new HaeinRuntime(haeinClient, manager, tagStore, () => { if (renderEnabled) renderer.schedule(); }, focusTaskId);
  const tailer = new EventsTailer(eventsDir, (id, event, payload) => manager.applyEvent(id, event, payload));

  /**
   * Restores raw mode, bracketed paste, cursor, styling, and alternate screen at most once.
   * @returns Nothing; safe for normal, refresh, startup, and fatal paths.
   */
  const restoreTerminal = (): void => {
    if (terminalRestored) return;
    terminalRestored = true;
    if (!terminalEntered) return;
    process.stdout.write('\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode(false);
  };

  /**
   * Stops every source of terminal updates and removes parent stdin/resize handling once.
   * @returns Nothing; PTYs remain alive until the caller explicitly kills them.
   */
  const stopRuntime = (): void => {
    if (runtimeStopped) return;
    runtimeStopped = true;
    renderEnabled = false;
    renderer.stop();
    manager.discovery.stop();
    tailer.stop();
    haeinRuntime?.stop();
    if (haeinControl) void haeinControl.stop();
    process.stdin.off('data', onData);
    process.stdin.pause();
    process.stdout.off('resize', onResize);
  };

  /**
   * Stops runtime work, terminates owned PTYs, restores the host terminal, and exits.
   * @param code Process exit code.
   * @param error Optional fatal error printed after terminal restoration.
   * @returns Nothing; process.exit terminates execution.
   */
  const shutdown = (code: number, error?: unknown): void => {
    stopRuntime();
    manager.killAll();
    restoreTerminal();
    if (error) process.stderr.write(`devin-conductor crashed: ${error instanceof Error ? error.stack || error.message : error}\n`);
    process.exit(code);
  };

  /**
   * Writes launcher handoff state before draining PTYs, then exits with the refresh status.
   * @returns Promise rejected only when state cannot be written before runtime shutdown.
   */
  const refresh = async (): Promise<void> => {
    const readiness = manager.getRefreshReadiness();
    if (!readiness.ready) throw new Error(readiness.message);
    if (!restartChannelPath) throw new Error('Cannot refresh: restart dgui once to enable the launcher');
    try {
      writeRestartState(manager.getRestartState(), restartChannelPath);
    } catch (error) {
      throw new Error(`Cannot refresh: ${error instanceof Error ? error.message : error}`);
    }
    stopRuntime();
    const pids = manager.killAll();
    const deadline = Date.now() + 5000;
    let remaining = pids;
    while (remaining.length > 0 && Date.now() < deadline) {
      remaining = remaining.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (remaining.length > 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (remaining.length === 0 && pids.length > 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    restoreTerminal();
    process.exit(75);
  };

  input = new InputHandler(manager, () => renderer.schedule(), () => shutdown(0), restartChannelPath !== null, refresh, defaultCwd, haeinRuntime ?? undefined);
  renderer = new Renderer(manager, input, os.homedir(), haeinRuntime ?? undefined);
  haeinRuntime?.setActivationHandler(() => {
    input.mode = 'attached';
    input.attachedMode = 'normal';
    renderer.schedule();
  });
  if (restartState && !haeinRuntime) manager.restoreRestartState(restartState);
  if (haeinClient && haeinRuntime && haeinSocket) {
    try { await haeinClient.health(); }
    catch (error) { haeinRuntime.notice = error instanceof Error ? `Haein unavailable: ${error.message}` : 'Haein unavailable'; }
    haeinControl = new HaeinControlServer(controlSocketPath(haeinSocket), (taskId) => {
      haeinRuntime!.focusTask(taskId);
    });
    try { await haeinControl.start(); }
    catch (error) { haeinRuntime.notice = error instanceof Error ? error.message : 'Could not start Haein focus socket'; }
  }

  /**
   * Routes host-terminal data into the input state machine.
   * @param data Raw stdin bytes from the interactive TTY.
   * @returns Nothing.
   */
  function onData(data: Buffer): void {
    input.handle(data.toString('utf8'));
  }

  /**
   * Resizes all session panes and invalidates the line-diff cache after host resize.
   * @returns Nothing.
   */
  function onResize(): void {
    manager.setPaneSize((process.stdout.columns || 80) - SIDEBAR_W - 1, (process.stdout.rows || 24) - 1);
    renderer.invalidate();
    renderer.schedule();
  }

  process.on('uncaughtException', (error) => shutdown(1, error));
  process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H\x1b[?25l');
  terminalEntered = true;
  terminalRestored = false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  manager.setPaneSize((process.stdout.columns || 80) - SIDEBAR_W - 1, (process.stdout.rows || 24) - 1);
  tailer.start();
  manager.discovery.start();
  if (haeinRuntime) haeinRuntime.start();
  if (!haeinRuntime && !hasRestartState && !hooksInstalled() && process.env.DEVIN_CONDUCTOR_NO_HOOK_PROMPT !== '1') {
    input.mode = 'confirm';
    input.confirm = {
      question: `Install Devin notification hooks into ${CONFIG_PATH}? (backup written first)`,
      onYes: () => installHooks(),
    };
  }
  renderEnabled = true;
  renderer.schedule();
}

void main().catch((error: unknown) => {
  process.stderr.write(`devin-conductor failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
