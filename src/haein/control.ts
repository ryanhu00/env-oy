import * as fs from 'node:fs';
import * as net from 'node:net';

export interface FocusRequest { type: 'focus-task'; taskId: string; }
export interface FocusResponse { ok: boolean; error?: string; }

/** Derives a deterministic sibling path without reinterpreting the service socket pathname. */
export function controlSocketPath(haeinSocketPath: string): string {
  return `${haeinSocketPath}.conductor-control`;
}

/** Validates the newline-delimited focus protocol accepted from Haein. */
export function parseFocusRequest(raw: string): FocusRequest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Focus request must be an object');
  const request = parsed as Record<string, unknown>;
  if (request.type !== 'focus-task' || typeof request.taskId !== 'string' || !request.taskId.trim()) throw new Error('Focus request requires type "focus-task" and a taskId');
  return { type: 'focus-task', taskId: request.taskId };
}

/** Owns the private Conductor focus socket for one Haein-mode process. */
export class HaeinControlServer {
  private server: net.Server | null = null;

  constructor(readonly socketPath: string, private readonly onFocus: (taskId: string) => void) {}

  /** Binds the socket after removing only an abandoned Unix socket file. */
  async start(): Promise<void> {
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket control path: ${this.socketPath}`);
      const live = await new Promise<boolean>((resolve) => {
        const probe = net.createConnection(this.socketPath);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (live) throw new Error(`Haein Conductor is already running at ${this.socketPath}`);
      fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((connection) => {
        let data = '';
        connection.setEncoding('utf8');
        connection.on('data', (chunk: string) => { data += chunk; });
        connection.on('end', () => {
          let response: FocusResponse;
          try {
            const request = parseFocusRequest(data.trim());
            this.onFocus(request.taskId);
            response = { ok: true };
          } catch (error) {
            response = { ok: false, error: error instanceof Error ? error.message : 'Invalid focus request' };
          }
          connection.end(JSON.stringify(response) + '\n');
        });
      });
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        try { fs.chmodSync(this.socketPath, 0o600); } catch (error) { server.close(); reject(error); return; }
        this.server = server;
        resolve();
      });
    });
  }

  /** Closes and removes only the socket this instance owns. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    try {
      if (fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
    } catch {}
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Sends a focus request to an already-running Haein-mode Conductor. */
export function sendFocusRequest(socketPath: string, taskId: string): Promise<FocusResponse> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let raw = '';
    connection.setEncoding('utf8');
    connection.setTimeout(1000);
    connection.on('connect', () => connection.end(JSON.stringify({ type: 'focus-task', taskId } satisfies FocusRequest) + '\n'));
    connection.on('data', (chunk: string) => { raw += chunk; });
    connection.on('timeout', () => connection.destroy(new Error('control socket timed out')));
    connection.on('error', (error: Error) => reject(new Error(`No running Haein Conductor at ${socketPath}: ${error.message}`)));
    connection.on('end', () => {
      try {
        const value: unknown = JSON.parse(raw.trim());
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid response');
        const response = value as Record<string, unknown>;
        if (typeof response.ok !== 'boolean' || (response.error !== undefined && typeof response.error !== 'string')) throw new Error('invalid response');
        resolve({ ok: response.ok, error: response.error as string | undefined });
      } catch { reject(new Error(`No running Haein Conductor at ${socketPath}: invalid response`)); }
    });
  });
}
