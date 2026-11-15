import { execFile } from 'child_process';
import { NotificationType } from './session';

const BODY: Record<NotificationType, string> = {
  stop: 'finished its turn',
  permission: 'needs permission',
  exit: 'session ended',
};

export class DesktopNotifier {
  private readonly lastSentAt = new Map<string, number>();

  /**
   * Sends macOS notification banners plus a terminal bell when a session gains a new
   * unread notification while the user is elsewhere.
   * @param enabled When false (config `desktop_notifications: false`), send() is a no-op.
   */
  constructor(private readonly enabled: boolean) {}

  /**
   * Fires a fire-and-forget `osascript` banner and writes a BEL to stdout, debounced to
   * at most one alert per session per 3 seconds; osascript errors are swallowed and the
   * session name is escaped (backslashes then double quotes) against AppleScript injection.
   * @param sessionId Conductor session id used as the debounce key.
   * @param name Session display name shown in the banner body.
   * @param type Notification kind selecting the body text.
   * @returns Nothing.
   */
  send(sessionId: string, name: string, type: NotificationType): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - (this.lastSentAt.get(sessionId) ?? 0) < 3000) return;
    this.lastSentAt.set(sessionId, now);
    const body = `${name}: ${BODY[type]}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${body}" with title "Envoy"`], () => {});
    process.stdout.write('\x07');
  }
}
