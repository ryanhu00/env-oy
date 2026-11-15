"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopNotifier = void 0;
const child_process_1 = require("child_process");
const BODY = {
    stop: 'finished its turn',
    permission: 'needs permission',
    exit: 'session ended',
};
class DesktopNotifier {
    enabled;
    lastSentAt = new Map();
    /**
     * Sends macOS notification banners plus a terminal bell when a session gains a new
     * unread notification while the user is elsewhere.
     * @param enabled When false (config `desktop_notifications: false`), send() is a no-op.
     */
    constructor(enabled) {
        this.enabled = enabled;
    }
    /**
     * Fires a fire-and-forget `osascript` banner and writes a BEL to stdout, debounced to
     * at most one alert per session per 3 seconds; osascript errors are swallowed and the
     * session name is escaped (backslashes then double quotes) against AppleScript injection.
     * @param sessionId Conductor session id used as the debounce key.
     * @param name Session display name shown in the banner body.
     * @param type Notification kind selecting the body text.
     * @returns Nothing.
     */
    send(sessionId, name, type) {
        if (!this.enabled)
            return;
        const now = Date.now();
        if (now - (this.lastSentAt.get(sessionId) ?? 0) < 3000)
            return;
        this.lastSentAt.set(sessionId, now);
        const body = `${name}: ${BODY[type]}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        (0, child_process_1.execFile)('osascript', ['-e', `display notification "${body}" with title "devin-conductor"`], () => { });
        process.stdout.write('\x07');
    }
}
exports.DesktopNotifier = DesktopNotifier;
