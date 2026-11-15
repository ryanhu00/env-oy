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
const sessionManager_1 = require("./sessionManager");
const notifications_1 = require("./notifications");
const notify_1 = require("./notify");
const input_1 = require("./input");
const renderer_1 = require("./ui/renderer");
const installer_1 = require("./hooks/installer");
const restart_1 = require("./restart");
const tags_1 = require("./tags");
const client_1 = require("./haein/client");
const control_1 = require("./haein/control");
const runtime_1 = require("./haein/runtime");
/**
 * Runs dgui, including launcher-channel restore and idempotent terminal lifecycle handling.
 * @returns Nothing; the process exits through normal quit, fatal cleanup, or launcher refresh.
 */
async function main() {
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
            const response = await (0, control_1.sendFocusRequest)((0, control_1.controlSocketPath)(haeinSocket), focusTaskId);
            if (!response.ok)
                throw new Error(response.error || 'focus request rejected');
        }
        catch (error) {
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
    const restartChannelPath = (0, restart_1.validateRestartChannelPath)(process.env.DEVIN_CONDUCTOR_RESTART_CHANNEL);
    const hasRestartState = restartChannelPath !== null && fs.existsSync(restartChannelPath);
    const tagStore = new tags_1.TagStore();
    const restartState = hasRestartState ? (0, restart_1.consumeRestartState)(restartChannelPath, tagStore.tags) : null;
    let defaultCwd = process.cwd();
    let desktopNotifications = true;
    try {
        const cfg = JSON.parse(fs.readFileSync(tagStore.configPath, 'utf8'));
        if (cfg.desktop_notifications === false)
            desktopNotifications = false;
        const dir = path.resolve(String(cfg.default_cwd).replace(/^~(?=$|\/)/, os.homedir()));
        if (fs.statSync(dir).isDirectory())
            defaultCwd = dir;
    }
    catch { }
    let renderer;
    let input;
    let renderEnabled = false;
    let runtimeStopped = false;
    let terminalEntered = false;
    let terminalRestored = false;
    const manager = new sessionManager_1.SessionManager(eventsDir, [...new Set([defaultCwd, process.cwd()])], tagStore, () => {
        if (renderEnabled)
            renderer.schedule();
    }, new notify_1.DesktopNotifier(desktopNotifications));
    const haeinClient = haeinSocket ? new client_1.HaeinClient(haeinSocket) : null;
    let haeinRuntime = null;
    let haeinControl = null;
    if (haeinClient)
        haeinRuntime = new runtime_1.HaeinRuntime(haeinClient, manager, tagStore, () => { if (renderEnabled)
            renderer.schedule(); }, focusTaskId);
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
        renderer.stop();
        manager.discovery.stop();
        tailer.stop();
        haeinRuntime?.stop();
        if (haeinControl)
            void haeinControl.stop();
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
            process.stderr.write(`devin-conductor crashed: ${error instanceof Error ? error.stack || error.message : error}\n`);
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
            throw new Error('Cannot refresh: restart dgui once to enable the launcher');
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
    input = new input_1.InputHandler(manager, () => renderer.schedule(), () => shutdown(0), restartChannelPath !== null, refresh, defaultCwd, haeinRuntime ?? undefined);
    renderer = new renderer_1.Renderer(manager, input, os.homedir(), haeinRuntime ?? undefined);
    haeinRuntime?.setActivationHandler(() => {
        input.mode = 'attached';
        input.attachedMode = 'normal';
        renderer.schedule();
    });
    if (restartState && !haeinRuntime)
        manager.restoreRestartState(restartState);
    if (haeinClient && haeinRuntime && haeinSocket) {
        try {
            await haeinClient.health();
        }
        catch (error) {
            haeinRuntime.notice = error instanceof Error ? `Haein unavailable: ${error.message}` : 'Haein unavailable';
        }
        haeinControl = new control_1.HaeinControlServer((0, control_1.controlSocketPath)(haeinSocket), (taskId) => {
            haeinRuntime.focusTask(taskId);
        });
        try {
            await haeinControl.start();
        }
        catch (error) {
            haeinRuntime.notice = error instanceof Error ? error.message : 'Could not start Haein focus socket';
        }
    }
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
    if (haeinRuntime)
        haeinRuntime.start();
    if (!haeinRuntime && !hasRestartState && !(0, installer_1.hooksInstalled)() && process.env.DEVIN_CONDUCTOR_NO_HOOK_PROMPT !== '1') {
        input.mode = 'confirm';
        input.confirm = {
            question: `Install Devin notification hooks into ${installer_1.CONFIG_PATH}? (backup written first)`,
            onYes: () => (0, installer_1.installHooks)(),
        };
    }
    renderEnabled = true;
    renderer.schedule();
}
void main().catch((error) => {
    process.stderr.write(`devin-conductor failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
