"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseColorFgBg = parseColorFgBg;
exports.forcedAppearance = forcedAppearance;
exports.systemAppearance = systemAppearance;
exports.detectAppearance = detectAppearance;
const child_process_1 = require("child_process");
const runCommand = (file, args) => new Promise((resolve, reject) => {
    (0, child_process_1.execFile)(file, args, { timeout: 2000, windowsHide: true }, (error, stdout) => {
        if (error)
            reject(error);
        else
            resolve(String(stdout));
    });
});
/**
 * Parses COLORFGBG ("fg;bg" or "fg;default;bg"), which many terminals export.
 * @param value Raw COLORFGBG value.
 * @returns The appearance implied by the background color index, or undefined.
 */
function parseColorFgBg(value) {
    if (!value)
        return undefined;
    const bg = Number(value.split(';').pop());
    if (!Number.isInteger(bg) || bg < 0 || bg > 15)
        return undefined;
    // ANSI 0-6 and 8 are dark backgrounds; 7 and 9-15 are light
    return bg === 7 || bg >= 9 ? 'light' : 'dark';
}
/**
 * Reads the user's forced appearance from ENVOY_THEME.
 * @param value Raw value (light | dark | auto).
 * @returns 'light' or 'dark' when forced; undefined for auto/unset/invalid.
 */
function forcedAppearance(value) {
    const v = (value ?? '').trim().toLowerCase();
    return v === 'light' || v === 'dark' ? v : undefined;
}
/**
 * Asks the operating system for its light/dark setting.
 * @param platform Node platform name.
 * @param run Command runner (injectable for tests).
 * @returns The system appearance, or undefined when it cannot be determined.
 */
async function systemAppearance(platform = process.platform, run = runCommand) {
    if (platform === 'darwin') {
        try {
            return /dark/i.test(await run('defaults', ['read', '-g', 'AppleInterfaceStyle'])) ? 'dark' : 'light';
        }
        catch (error) {
            // the key only exists in dark mode: a plain non-zero exit means light mode
            return error.code === 1 ? 'light' : undefined;
        }
    }
    if (platform === 'linux') {
        try {
            const scheme = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
            if (/prefer-dark/.test(scheme))
                return 'dark';
            if (/prefer-light|default/.test(scheme))
                return 'light';
        }
        catch { }
    }
    return undefined;
}
/**
 * Resolves the appearance to paint with: ENVOY_THEME if forced, else the configured `theme`,
 * else the system setting, else the terminal's COLORFGBG hint, else dark.
 * @param env Environment (injectable for tests).
 * @param platform Node platform name.
 * @param run Command runner.
 * @param configured The `theme` config value ('auto' follows the system).
 * @returns 'light' or 'dark'.
 */
async function detectAppearance(env = process.env, platform = process.platform, run = runCommand, configured = 'auto') {
    const forced = forcedAppearance(env.ENVOY_THEME) ?? forcedAppearance(configured);
    if (forced)
        return forced;
    return (await systemAppearance(platform, run)) ?? parseColorFgBg(env.COLORFGBG) ?? 'dark';
}
