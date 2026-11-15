import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectAdapters } from './adapters/registry';
import { SessionManager } from './sessionManager';
import { EventsTailer } from './notifications';
import { DesktopNotifier } from './notify';
import { InputHandler } from './input';
import { Renderer, SIDEBAR_W } from './ui/renderer';
import { describeHookInstall, installHookTargets, installedHookTargets, missingHookTargets } from './hooks/installer';
import { consumeRestartState, validateRestartChannelPath, writeRestartState } from './restart';
import { TagStore } from './tags';
import { APP_DISPLAY_NAME, APP_NAME, envoyEnv, resolveEventsDir } from './paths';

/**
 * Runs Envoy, including launcher-channel restore and idempotent terminal lifecycle handling.
 * @returns Nothing; the process exits through normal quit, fatal cleanup, or launcher refresh.
 */
async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${APP_DISPLAY_NAME} must be run in an interactive terminal\n`);
    process.exit(1);
  }
  const eventsDir = resolveEventsDir();
  const restartChannelPath = validateRestartChannelPath(envoyEnv('RESTART_CHANNEL'));
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

  // only the CLIs the user has (or explicitly enabled in the config) are driven
  const selection = selectAdapters(tagStore.adapterSettings);
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
    new DesktopNotifier(desktopNotifications),
    selection.adapters,
    selection.defaultAdapterId,
    tagStore.recentLimit
  );
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
    if (error) process.stderr.write(`${APP_DISPLAY_NAME} crashed: ${error instanceof Error ? error.stack || error.message : error}\n`);
    process.exit(code);
  };

  /**
   * Writes launcher handoff state before draining PTYs, then exits with the refresh status.
   * @returns Promise rejected only when state cannot be written before runtime shutdown.
   */
  const refresh = async (): Promise<void> => {
    const readiness = manager.getRefreshReadiness();
    if (!readiness.ready) throw new Error(readiness.message);
    if (!restartChannelPath) throw new Error(`Cannot refresh: restart ${APP_NAME} once to enable the launcher`);
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

  input = new InputHandler(manager, () => renderer.schedule(), () => shutdown(0), restartChannelPath !== null, refresh, defaultCwd);
  renderer = new Renderer(manager, input, os.homedir());
  if (restartState) manager.restoreRestartState(restartState);

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
  const missingHooks = !hasRestartState && envoyEnv('NO_HOOK_PROMPT') !== '1'
    ? missingHookTargets(installedHookTargets(manager.adapters.map((adapter) => adapter.id)))
    : [];
  if (missingHooks.length > 0) {
    input.mode = 'confirm';
    input.confirm = {
      question: describeHookInstall(missingHooks),
      onYes: () => {
        const result = installHookTargets(missingHooks);
        if (result.errors.length > 0) throw new Error(`Hook install failed: ${result.errors.join('; ')}`);
        if (result.notices.length > 0) input.notice = result.notices.join(' ');
      },
    };
  }
  renderEnabled = true;
  renderer.schedule();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${APP_DISPLAY_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
