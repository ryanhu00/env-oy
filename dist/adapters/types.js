"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ADAPTER_ID = exports.ADAPTER_IDS = void 0;
exports.sessionKey = sessionKey;
exports.ADAPTER_IDS = ['devin', 'claude', 'codex'];
exports.DEFAULT_ADAPTER_ID = 'devin';
/**
 * Builds the persistence key for a CLI session so ids from different CLIs never collide.
 * Devin ids are stored bare; every other adapter is prefixed with `<adapter>:`.
 * @param adapterId Adapter that owns the session.
 * @param sessionId Real session id reported by that CLI.
 * @returns Key used for aliases, saved order, tag assignment and resume bookkeeping.
 */
function sessionKey(adapterId, sessionId) {
    return adapterId === 'devin' ? sessionId : `${adapterId}:${sessionId}`;
}
