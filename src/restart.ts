import * as fs from 'fs';
import * as path from 'path';
import type { Notification, NotificationType, SessionStatus } from './session';
import { defaultDataDir } from './paths';
import { ADAPTER_IDS, sessionKey } from './adapters/types';
import type { AdapterId } from './adapters/types';

export const RESTART_STATE_VERSION = 2;
/** Version-1 handoffs (Devin only, `devinSessionId`) are still readable and upgraded on write. */
const LEGACY_RESTART_STATE_VERSION = 1;
export const RESTART_CHANNEL_PREFIX = 'restart-channel-';

export interface RestartSessionState {
  adapterId: AdapterId;
  cliSessionId: string;
  cwd: string;
  name: string;
  tag: string;
  unread: Notification[];
  status: Exclude<SessionStatus, 'exited'>;
  markedDone?: boolean;
}

export interface RestartState {
  version: typeof RESTART_STATE_VERSION;
  /** Session key (see `sessionKey`) of the selected ACTIVE session. */
  selectedSessionId: string | null;
  sessions: RestartSessionState[];
  lastPromptAt?: number;
}

const NOTIFICATION_TYPES = new Set<NotificationType>(['stop', 'permission', 'exit']);
const RESTORABLE_STATUSES = new Set<SessionStatus>(['working', 'waiting', 'needs-permission']);

/**
 * Validates one unread notification from a handoff record.
 * @param value Parsed JSON value checked for a known type and finite timestamp.
 * @returns A copied notification, or null when invalid.
 */
function validateNotification(value: unknown): Notification | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !NOTIFICATION_TYPES.has(record.type as NotificationType)) return null;
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts) || record.ts < 0) return null;
  return { type: record.type as NotificationType, ts: record.ts };
}

/**
 * Validates one resumable ACTIVE-session record against current tags.
 * @param value Parsed JSON value to inspect.
 * @param tags Current canonical tags allowed during restore.
 * @param legacy True for version-1 records, which are Devin-only and use `devinSessionId`.
 * @returns A safe copied record, or null when any field is invalid.
 */
function validateSession(value: unknown, tags: ReadonlySet<string>, legacy: boolean): RestartSessionState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const adapterId = legacy ? 'devin' : record.adapterId;
  if (typeof adapterId !== 'string' || !ADAPTER_IDS.includes(adapterId as AdapterId)) return null;
  const cliSessionId = legacy ? record.devinSessionId : record.cliSessionId;
  if (typeof cliSessionId !== 'string' || !cliSessionId.trim() || cliSessionId !== cliSessionId.trim()) return null;
  if (typeof record.cwd !== 'string' || !record.cwd.trim()) return null;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (typeof record.tag !== 'string' || !record.tag.trim() || !tags.has(record.tag)) return null;
  if (typeof record.status !== 'string' || !RESTORABLE_STATUSES.has(record.status as SessionStatus)) return null;
  if (record.markedDone !== undefined && typeof record.markedDone !== 'boolean') return null;
  if (!Array.isArray(record.unread)) return null;
  const unread = record.unread.map(validateNotification);
  if (unread.some((entry) => entry === null)) return null;
  return {
    adapterId: adapterId as AdapterId,
    cliSessionId,
    cwd: record.cwd,
    name: record.name,
    tag: record.tag,
    unread: unread as Notification[],
    status: record.status as Exclude<SessionStatus, 'exited'>,
    // absent stays absent so older handoffs round-trip without gaining fields
    ...(record.markedDone === undefined ? {} : { markedDone: record.markedDone as boolean }),
  };
}

/**
 * Validates a complete versioned handoff (current or version-1) while skipping malformed
 * session records; the result is always the current version.
 * @param value Parsed JSON value to inspect.
 * @param tags Current canonical tags allowed during restore.
 * @returns Sanitized state, or null when the top-level schema/version is invalid.
 */
export function validateRestartState(value: unknown, tags: readonly string[]): RestartState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.version !== RESTART_STATE_VERSION && record.version !== LEGACY_RESTART_STATE_VERSION) || !Array.isArray(record.sessions)) return null;
  const legacy = record.version === LEGACY_RESTART_STATE_VERSION;
  const selectedSessionId = record.selectedSessionId === null
    ? null
    : typeof record.selectedSessionId === 'string' && record.selectedSessionId.trim() && record.selectedSessionId === record.selectedSessionId.trim()
      ? record.selectedSessionId
      : null;
  const seen = new Set<string>();
  const sessions: RestartSessionState[] = [];
  const allowedTags = new Set(tags);
  for (const value of record.sessions) {
    const session = validateSession(value, allowedTags, legacy);
    if (!session) continue;
    const key = sessionKey(session.adapterId, session.cliSessionId);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  const lastPromptAt = typeof record.lastPromptAt === 'number' && Number.isFinite(record.lastPromptAt) && record.lastPromptAt >= 0 ? record.lastPromptAt : undefined;
  return {
    version: RESTART_STATE_VERSION,
    selectedSessionId,
    sessions,
    // absent stays absent so older handoffs round-trip without gaining fields
    ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
  };
}

/**
 * Validates a launcher channel as a direct child of the private conductor data directory.
 * @param filePath Untrusted channel path from the process environment.
 * @param dataDir Expected private data directory; tests may provide an isolated directory.
 * @returns Normalized absolute channel path, or null when unavailable or unsafe.
 */
export function validateRestartChannelPath(filePath: string | undefined, dataDir = defaultDataDir()): string | null {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  const root = path.resolve(dataDir);
  const target = path.resolve(filePath);
  if (target !== filePath || path.dirname(target) !== root || !path.basename(target).startsWith(RESTART_CHANNEL_PREFIX)) return null;
  return target;
}

/**
 * Atomically writes validated handoff state to an exact private launcher channel.
 * @param state Complete restart snapshot containing only resumable session metadata.
 * @param target Absolute launcher channel path to replace atomically.
 * @param dataDir Expected private data directory; tests may provide an isolated directory.
 * @returns The validated absolute target path.
 */
export function writeRestartState(state: RestartState, target: string, dataDir = defaultDataDir()): string {
  const channel = validateRestartChannelPath(target, dataDir);
  if (!channel) throw new Error('Invalid restart channel');
  const validated = validateRestartState(state, [...new Set(state.sessions.map((session) => session.tag))]);
  if (!validated || validated.sessions.length !== state.sessions.length) throw new Error('Invalid restart state');
  const parent = path.dirname(channel);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  let temp = `${channel}.tmp-${process.pid}-${Date.now()}`;
  let suffix = 0;
  while (fs.existsSync(temp)) temp = `${channel}.tmp-${process.pid}-${Date.now()}-${++suffix}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(validated) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, channel);
    fs.chmodSync(channel, 0o600);
    return channel;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

/**
 * Reads and immediately deletes one launcher channel before parsing and validation.
 * @param filePath Validated channel path received through ENVOY_RESTART_CHANNEL.
 * @param tags Current canonical tags allowed during restore.
 * @returns Sanitized state, or null after read, parse, or schema failure.
 */
export function consumeRestartState(filePath: string, tags: readonly string[]): RestartState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    return null;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {}
  try {
    return validateRestartState(JSON.parse(raw), tags);
  } catch {
    return null;
  }
}
