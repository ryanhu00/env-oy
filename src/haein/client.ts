import * as http from 'node:http';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface HaeinTask {
  id: string;
  title: string;
  stage: string;
  agent: string;
  worktree: string;
  branch: string;
  sessionId: string;
  logPath: string;
  renderedPrompt: string;
  prompt: string;
  tag: string;
  agentPid: number;
  attention: string;
  prs: JsonValue[];
  createdAt: string;
  updatedAt: string;
}

export interface HaeinLaunchResponse {
  taskId: string;
  title: string;
  agent: string;
  cwd: string;
  argv: string[];
  sessionId: string;
}

interface HealthResponse { ok: true; }
interface TasksResponse { tasks: HaeinTask[]; }

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Malformed Haein response: ${context} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string {
  if (typeof source[key] !== 'string') throw new Error(`Malformed Haein response: ${key} must be a string`);
  return source[key] as string;
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(jsonValue);
  return false;
}

function serviceError(raw: string): string | null {
  try {
    const parsed = object(JSON.parse(raw) as unknown, 'error');
    for (const key of ['error', 'message', 'detail']) if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key] as string;
  } catch {}
  return null;
}

function parseTask(value: unknown): HaeinTask {
  const task = object(value, 'task');
  const pid = task.agent_pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid)) throw new Error('Malformed Haein response: agent_pid must be a number');
  if (typeof task.attention !== 'string') throw new Error('Malformed Haein response: attention must be a string');
  if (!Array.isArray(task.prs) || !task.prs.every(jsonValue)) throw new Error('Malformed Haein response: prs must be a JSON array');
  return {
    id: stringField(task, 'id'), title: stringField(task, 'title'), stage: stringField(task, 'stage'), agent: stringField(task, 'agent'),
    worktree: stringField(task, 'worktree'), branch: stringField(task, 'branch'), sessionId: stringField(task, 'session_id'),
    logPath: stringField(task, 'log_path'), renderedPrompt: stringField(task, 'rendered_prompt'), prompt: stringField(task, 'prompt'),
    tag: stringField(task, 'tag'), agentPid: pid, attention: task.attention, prs: task.prs as JsonValue[],
    createdAt: stringField(task, 'created_at'), updatedAt: stringField(task, 'updated_at'),
  };
}

/** Typed HTTP-over-Unix-socket client for the Haein service. */
export class HaeinClient {
  constructor(readonly socketPath: string, private readonly timeoutMs = 1500) {}

  /** Performs a quick health probe before the TUI starts polling. */
  async health(): Promise<HealthResponse> {
    const data = await this.request('GET', '/v1/health');
    const parsed = object(data, 'health');
    if (parsed.ok !== true) throw new Error('Malformed Haein response: ok must be true');
    return { ok: true };
  }

  /** Lists every Haein task with wire names translated to TypeScript names. */
  async listTasks(): Promise<TasksResponse> {
    const data = await this.request('GET', '/v1/tasks');
    const parsed = object(data, 'tasks');
    if (!Array.isArray(parsed.tasks)) throw new Error('Malformed Haein response: tasks must be an array');
    return { tasks: parsed.tasks.map(parseTask) };
  }

  /** Requests an agent command for a task without assuming a vendor CLI. */
  async launch(taskId: string): Promise<HaeinLaunchResponse> {
    const data = await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/launch`);
    const parsed = object(data, 'launch');
    if (!Array.isArray(parsed.argv) || parsed.argv.some((arg) => typeof arg !== 'string') || parsed.argv.length === 0) throw new Error('Malformed Haein response: argv must be a non-empty string array');
    return { taskId: stringField(parsed, 'task_id'), title: stringField(parsed, 'title'), agent: stringField(parsed, 'agent'), cwd: stringField(parsed, 'cwd'), argv: [...parsed.argv] as string[], sessionId: stringField(parsed, 'session_id') };
  }

  /** Reports the Conductor-owned PTY pid to Haein. */
  async reportProcess(taskId: string, pid: number, sessionId?: string): Promise<void> {
    const body: { pid: number; session_id?: string } = sessionId ? { pid, session_id: sessionId } : { pid };
    await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/process`, body);
  }

  /** Reports that a Conductor-owned PTY terminated. */
  async reportProcessExited(taskId: string, pid: number): Promise<void> {
    await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/process-exited`, { pid });
  }

  /** Updates a task tag in Haein. */
  async tag(taskId: string, tag: string): Promise<void> {
    await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/tag`, { tag });
  }

  private request(method: 'GET' | 'POST', requestPath: string, body?: JsonValue): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({ socketPath: this.socketPath, method, path: requestPath, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined, timeout: this.timeoutMs }, (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { raw += chunk; });
        response.on('end', () => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const detail = serviceError(raw);
            return reject(new Error(`Haein request ${method} ${requestPath} failed (${response.statusCode ?? 0})${detail ? `: ${detail}` : ''}`));
          }
          try { resolve(JSON.parse(raw) as unknown); } catch { reject(new Error(`Malformed Haein response from ${requestPath}`)); }
        });
      });
      request.on('timeout', () => request.destroy(new Error(`Haein request ${method} ${requestPath} timed out`)));
      request.on('error', (error: Error) => reject(new Error(`Haein unavailable: ${error.message}`)));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
