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
exports.HaeinControlServer = void 0;
exports.controlSocketPath = controlSocketPath;
exports.parseFocusRequest = parseFocusRequest;
exports.sendFocusRequest = sendFocusRequest;
const fs = __importStar(require("node:fs"));
const net = __importStar(require("node:net"));
/** Derives a deterministic sibling path without reinterpreting the service socket pathname. */
function controlSocketPath(haeinSocketPath) {
    return `${haeinSocketPath}.conductor-control`;
}
/** Validates the newline-delimited focus protocol accepted from Haein. */
function parseFocusRequest(raw) {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('Focus request must be an object');
    const request = parsed;
    if (request.type !== 'focus-task' || typeof request.taskId !== 'string' || !request.taskId.trim())
        throw new Error('Focus request requires type "focus-task" and a taskId');
    return { type: 'focus-task', taskId: request.taskId };
}
/** Owns the private Conductor focus socket for one Haein-mode process. */
class HaeinControlServer {
    socketPath;
    onFocus;
    server = null;
    constructor(socketPath, onFocus) {
        this.socketPath = socketPath;
        this.onFocus = onFocus;
    }
    /** Binds the socket after removing only an abandoned Unix socket file. */
    async start() {
        try {
            const stat = fs.lstatSync(this.socketPath);
            if (!stat.isSocket())
                throw new Error(`Refusing to replace non-socket control path: ${this.socketPath}`);
            const live = await new Promise((resolve) => {
                const probe = net.createConnection(this.socketPath);
                probe.once('connect', () => { probe.destroy(); resolve(true); });
                probe.once('error', () => resolve(false));
            });
            if (live)
                throw new Error(`Haein Conductor is already running at ${this.socketPath}`);
            fs.unlinkSync(this.socketPath);
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
        await new Promise((resolve, reject) => {
            const server = net.createServer((connection) => {
                let data = '';
                connection.setEncoding('utf8');
                connection.on('data', (chunk) => { data += chunk; });
                connection.on('end', () => {
                    let response;
                    try {
                        const request = parseFocusRequest(data.trim());
                        this.onFocus(request.taskId);
                        response = { ok: true };
                    }
                    catch (error) {
                        response = { ok: false, error: error instanceof Error ? error.message : 'Invalid focus request' };
                    }
                    connection.end(JSON.stringify(response) + '\n');
                });
            });
            server.once('error', reject);
            server.listen(this.socketPath, () => {
                server.off('error', reject);
                try {
                    fs.chmodSync(this.socketPath, 0o600);
                }
                catch (error) {
                    server.close();
                    reject(error);
                    return;
                }
                this.server = server;
                resolve();
            });
        });
    }
    /** Closes and removes only the socket this instance owns. */
    async stop() {
        const server = this.server;
        this.server = null;
        try {
            if (fs.lstatSync(this.socketPath).isSocket())
                fs.unlinkSync(this.socketPath);
        }
        catch { }
        if (server)
            await new Promise((resolve) => server.close(() => resolve()));
    }
}
exports.HaeinControlServer = HaeinControlServer;
/** Sends a focus request to an already-running Haein-mode Conductor. */
function sendFocusRequest(socketPath, taskId) {
    return new Promise((resolve, reject) => {
        const connection = net.createConnection(socketPath);
        let raw = '';
        connection.setEncoding('utf8');
        connection.setTimeout(1000);
        connection.on('connect', () => connection.end(JSON.stringify({ type: 'focus-task', taskId }) + '\n'));
        connection.on('data', (chunk) => { raw += chunk; });
        connection.on('timeout', () => connection.destroy(new Error('control socket timed out')));
        connection.on('error', (error) => reject(new Error(`No running Haein Conductor at ${socketPath}: ${error.message}`)));
        connection.on('end', () => {
            try {
                const value = JSON.parse(raw.trim());
                if (typeof value !== 'object' || value === null || Array.isArray(value))
                    throw new Error('invalid response');
                const response = value;
                if (typeof response.ok !== 'boolean' || (response.error !== undefined && typeof response.error !== 'string'))
                    throw new Error('invalid response');
                resolve({ ok: response.ok, error: response.error });
            }
            catch {
                reject(new Error(`No running Haein Conductor at ${socketPath}: invalid response`));
            }
        });
    });
}
