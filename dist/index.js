"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const registry_1 = require("./adapters/registry");
const sessionManager_1 = require("./sessionManager");
const notifications_1 = require("./notifications");
const notify_1 = require("./notify");
const input_1 = require("./input");
const renderer_1 = require("./ui/renderer");
const theme_1 = require("./ui/theme");
const settings_1 = require("./settings");
const appearance_1 = require("./ui/appearance");
const installer_1 = require("./hooks/installer");
const restart_1 = require("./restart");
const tags_1 = require("./tags");
const paths_1 = require("./paths");
/**
 * Runs Envoy, including launcher-channel restore and idempotent terminal lifecycle handling.
 * @returns Nothing; the process exits through normal quit, fatal cleanup, or launcher refresh.
 */
async function main() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(`${paths_1.APP_DISPLAY_NAME} must be run in an interactive terminal\n`);
        process.exit(1);
    }
    const eventsDir = (0, paths_1.resolveEventsDir)();
    const restartChannelPath = (0, restart_1.validateRestartChannelPath)((0, paths_1.envoyEnv)('RESTART_CHANNEL'));
    const hasRestartState = restartChannelPath !== null && fs.existsSync(restartChannelPath);
    const tagStore = new tags_1.TagStore();
    const restartState = hasRestartState ? (0, restart_1.consumeRestartState)(restartChannelPath, tagStore.tags) : null;
    let defaultCwd = process.cwd();
    const launchDir = defaultCwd;
    try {
        const dir = path.resolve((tagStore.defaultCwdSetting ?? '').replace(/^~(?=$|\/)/, os.homedir()));
        if (tagStore.defaultCwdSetting && fs.statSync(dir).isDirectory())
            defaultCwd = dir;
    }
    catch { }
    const notifier = new notify_1.DesktopNotifier(tagStore.desktopNotifications);
    // only the CLIs the user has (or explicitly enabled in the config) are driven
    const selection = (0, registry_1.selectAdapters)(tagStore.adapterSettings);
    // light/dark: ENVOY_THEME, else the `theme` setting, else the system appearance
    const resolveAppearance = () => (0, appearance_1.detectAppearance)(process.env, process.platform, undefined, tagStore.theme);
    (0, theme_1.applyTheme)(await resolveAppearance());
    let themeTimer = null;
    let renderer;
    let input;
    let renderEnabled = false;
    let runtimeStopped = false;
    let terminalEntered = false;
    let terminalRestored = false;
    const manager = new sessionManager_1.SessionManager(eventsDir, [...new Set([defaultCwd, process.cwd()])], tagStore, () => {
        if (renderEnabled)
            renderer.schedule();
    }, notifier, selection.adapters, selection.defaultAdapterId, tagStore.recentLimit);
    const tailer = new notifications_1.EventsTailer(eventsDir, (id, event, payload) => manager.applyEvent(id, event, payload));
    /**
     * Restores raw mode, bracketed paste, cursor, styling, and alternate screen at most once.
     * @returns Nothing; safe for normal, refresh, startup, and fatal paths.
     */
    const restoreTerminal = () => {
        if (terminalRestored)
            return;
        terminalRestored = true;
        if (!terminalEntered)
            return;
        process.stdout.write('\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l');
        process.stdin.setRawMode(false);
    };
    /**
     * Stops every source of terminal updates and removes parent stdin/resize handling once.
     * @returns Nothing; PTYs remain alive until the caller explicitly kills them.
     */
    const stopRuntime = () => {
        if (runtimeStopped)
            return;
        runtimeStopped = true;
        renderEnabled = false;
        if (themeTimer)
            clearInterval(themeTimer);
        themeTimer = null;
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
    const shutdown = (code, error) => {
        stopRuntime();
        manager.killAll();
        restoreTerminal();
        if (error)
            process.stderr.write(`${paths_1.APP_DISPLAY_NAME} crashed: ${error instanceof Error ? error.stack || error.message : error}\n`);
        process.exit(code);
    };
    /**
     * Writes launcher handoff state before draining PTYs, then exits with the refresh status.
     * @returns Promise rejected only when state cannot be written before runtime shutdown.
     */
    const refresh = async () => {
        const readiness = manager.getRefreshReadiness();
        if (!readiness.ready)
            throw new Error(readiness.message);
        if (!restartChannelPath)
            throw new Error(`Cannot refresh: restart ${paths_1.APP_NAME} once to enable the launcher`);
        try {
            (0, restart_1.writeRestartState)(manager.getRestartState(), restartChannelPath);
        }
        catch (error) {
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
                }
                catch {
                    return false;
                }
            });
            if (remaining.length > 0)
                await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (remaining.length === 0 && pids.length > 0)
            await new Promise((resolve) => setTimeout(resolve, 100));
        restoreTerminal();
        process.exit(75);
    };
    input = new input_1.InputHandler(manager, () => renderer.schedule(), () => shutdown(0), restartChannelPath !== null, refresh, defaultCwd);
    renderer = new renderer_1.Renderer(manager, input, os.homedir());
    /**
     * Re-resolves the appearance and repaints when it changed (settings change or system flip).
     * @returns Promise resolved once any change has been applied.
     */
    const syncAppearance = async () => {
        const appearance = await resolveAppearance();
        if (runtimeStopped || appearance === (0, theme_1.currentAppearance)())
            return;
        (0, theme_1.applyTheme)(appearance);
        renderer.invalidate();
        renderer.schedule();
    };
    input.settingsBackend = new settings_1.AppSettings({
        tagStore,
        manager,
        notifier,
        launchDir,
        onDefaultCwd: (dir) => {
            input.defaultCwd = dir;
        },
        onThemeChange: () => void syncAppearance(),
        onKoiChange: (enabled) => renderer.setKoi(enabled),
        onKoiCountChange: (count) => renderer.setKoiCount(count),
    });
    renderer.setKoiCount(tagStore.koiCount, false);
    if (tagStore.koi)
        renderer.setKoi(true, false);
    if (restartState)
        manager.restoreRestartState(restartState);
    /**
     * Routes host-terminal data into the input state machine.
     * @param data Raw stdin bytes from the interactive TTY.
     * @returns Nothing.
     */
    function onData(data) {
        input.handle(data.toString('utf8'));
    }
    /**
     * Resizes all session panes and invalidates the line-diff cache after host resize.
     * @returns Nothing.
     */
    function onResize() {
        manager.setPaneSize((process.stdout.columns || 80) - renderer_1.SIDEBAR_W - 1, (process.stdout.rows || 24) - 1);
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
    manager.setPaneSize((process.stdout.columns || 80) - renderer_1.SIDEBAR_W - 1, (process.stdout.rows || 24) - 1);
    tailer.start();
    manager.discovery.start();
    const missingHooks = !hasRestartState && (0, paths_1.envoyEnv)('NO_HOOK_PROMPT') !== '1'
        ? (0, installer_1.missingHookTargets)((0, installer_1.installedHookTargets)(manager.adapters.map((adapter) => adapter.id)))
        : [];
    if (missingHooks.length > 0) {
        input.mode = 'confirm';
        input.confirm = {
            question: (0, installer_1.describeHookInstall)(missingHooks),
            onYes: () => {
                const result = (0, installer_1.installHookTargets)(missingHooks);
                if (result.errors.length > 0)
                    throw new Error(`Hook install failed: ${result.errors.join('; ')}`);
                if (result.notices.length > 0)
                    input.notice = result.notices.join(' ');
            },
        };
    }
    renderEnabled = true;
    renderer.schedule();
    // follow system appearance changes while running
    let themeChecking = false;
    themeTimer = setInterval(() => {
        if (themeChecking)
            return;
        themeChecking = true;
        void syncAppearance()
            .catch(() => { })
            .finally(() => {
            themeChecking = false;
        });
    }, 3000);
    themeTimer.unref();
}
void main().catch((error) => {
    process.stderr.write(`${paths_1.APP_DISPLAY_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
