"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSafeSessionId = isSafeSessionId;
exports.hookSessionId = hookSessionId;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * Checks that a value is a plain, bounded token safe to use as a session id and persistence key.
 * @param value Candidate id from a hook payload, registry file or transcript name.
 * @returns True for strings made only of letters, digits, `.`, `_`, `:` and `-`.
 */
function isSafeSessionId(value) {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}
/**
 * Extracts a usable CLI session id from a hook payload. Devin, Claude and Codex all send
 * `session_id`; anything that is not a plain, bounded token is ignored so a malformed hook
 * can never become a persistence key.
 * @param payload Parsed hook stdin, when the hook delivered a JSON object.
 * @returns The session id, or null when absent or unsafe.
 */
function hookSessionId(payload) {
    const value = payload?.session_id;
    return isSafeSessionId(value) ? value : null;
}
