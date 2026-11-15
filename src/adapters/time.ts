/**
 * Formats an elapsed time the way RECENT rows show it.
 * @param elapsedSeconds Seconds since the last activity; negative values count as zero.
 * @returns `just now`, `Nm ago` or `Nh ago`.
 */
export function agoLabel(elapsedSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  return elapsed < 60 ? 'just now' : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m ago` : `${Math.floor(elapsed / 3600)}h ago`;
}
