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
exports.HaeinClient = void 0;
const http = __importStar(require("node:http"));
function object(value, context) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`Malformed Haein response: ${context} must be an object`);
    return value;
}
function stringField(source, key) {
    if (typeof source[key] !== 'string')
        throw new Error(`Malformed Haein response: ${key} must be a string`);
    return source[key];
}
function jsonValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return true;
    if (Array.isArray(value))
        return value.every(jsonValue);
    if (typeof value === 'object')
        return Object.values(value).every(jsonValue);
    return false;
}
function serviceError(raw) {
    try {
        const parsed = object(JSON.parse(raw), 'error');
        for (const key of ['error', 'message', 'detail'])
            if (typeof parsed[key] === 'string' && parsed[key])
                return parsed[key];
    }
    catch { }
    return null;
}
function parseTask(value) {
    const task = object(value, 'task');
    const pid = task.agent_pid;
    if (typeof pid !== 'number' || !Number.isFinite(pid))
        throw new Error('Malformed Haein response: agent_pid must be a number');
    if (typeof task.attention !== 'string')
        throw new Error('Malformed Haein response: attention must be a string');
    if (!Array.isArray(task.prs) || !task.prs.every(jsonValue))
        throw new Error('Malformed Haein response: prs must be a JSON array');
    return {
        id: stringField(task, 'id'), title: stringField(task, 'title'), stage: stringField(task, 'stage'), agent: stringField(task, 'agent'),
        worktree: stringField(task, 'worktree'), branch: stringField(task, 'branch'), sessionId: stringField(task, 'session_id'),
        logPath: stringField(task, 'log_path'), renderedPrompt: stringField(task, 'rendered_prompt'), prompt: stringField(task, 'prompt'),
        tag: stringField(task, 'tag'), agentPid: pid, attention: task.attention, prs: task.prs,
        createdAt: stringField(task, 'created_at'), updatedAt: stringField(task, 'updated_at'),
    };
}
/** Typed HTTP-over-Unix-socket client for the Haein service. */
class HaeinClient {
    socketPath;
    timeoutMs;
    constructor(socketPath, timeoutMs = 1500) {
        this.socketPath = socketPath;
        this.timeoutMs = timeoutMs;
    }
    /** Performs a quick health probe before the TUI starts polling. */
    async health() {
        const data = await this.request('GET', '/v1/health');
        const parsed = object(data, 'health');
        if (parsed.ok !== true)
            throw new Error('Malformed Haein response: ok must be true');
        return { ok: true };
    }
    /** Lists every Haein task with wire names translated to TypeScript names. */
    async listTasks() {
        const data = await this.request('GET', '/v1/tasks');
        const parsed = object(data, 'tasks');
        if (!Array.isArray(parsed.tasks))
            throw new Error('Malformed Haein response: tasks must be an array');
        return { tasks: parsed.tasks.map(parseTask) };
    }
    /** Requests an agent command for a task without assuming a vendor CLI. */
    async launch(taskId) {
        const data = await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/launch`);
        const parsed = object(data, 'launch');
        if (!Array.isArray(parsed.argv) || parsed.argv.some((arg) => typeof arg !== 'string') || parsed.argv.length === 0)
            throw new Error('Malformed Haein response: argv must be a non-empty string array');
        return { taskId: stringField(parsed, 'task_id'), title: stringField(parsed, 'title'), agent: stringField(parsed, 'agent'), cwd: stringField(parsed, 'cwd'), argv: [...parsed.argv], sessionId: stringField(parsed, 'session_id') };
    }
    /** Reports the Conductor-owned PTY pid to Haein. */
    async reportProcess(taskId, pid, sessionId) {
        const body = sessionId ? { pid, session_id: sessionId } : { pid };
        await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/process`, body);
    }
    /** Reports that a Conductor-owned PTY terminated. */
    async reportProcessExited(taskId, pid) {
        await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/process-exited`, { pid });
    }
    /** Updates a task tag in Haein. */
    async tag(taskId, tag) {
        await this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/tag`, { tag });
    }
    request(method, requestPath, body) {
        return new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const request = http.request({ socketPath: this.socketPath, method, path: requestPath, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined, timeout: this.timeoutMs }, (response) => {
                let raw = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { raw += chunk; });
                response.on('end', () => {
                    if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
                        const detail = serviceError(raw);
                        return reject(new Error(`Haein request ${method} ${requestPath} failed (${response.statusCode ?? 0})${detail ? `: ${detail}` : ''}`));
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
                        reject(new Error(`Malformed Haein response from ${requestPath}`));
                    }
                });
            });
            request.on('timeout', () => request.destroy(new Error(`Haein request ${method} ${requestPath} timed out`)));
            request.on('error', (error) => reject(new Error(`Haein unavailable: ${error.message}`)));
            if (payload)
                request.write(payload);
            request.end();
        });
    }
}
exports.HaeinClient = HaeinClient;
