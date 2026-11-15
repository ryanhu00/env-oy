import type { ProcessInfo, ProcessSample } from './types';

/**
 * Parses validated REPL RSS samples from `ps -axo pid=,rss=,command=` output.
 * @param output Raw ps stdout with RSS in KiB.
 * @param isRepl Predicate selecting the command lines that belong to one CLI.
 * @returns Deduplicated process samples with byte counts.
 */
export function parsePsProcesses(output: string, isRepl: (command: string) => boolean): ProcessSample[] {
  const processes: ProcessSample[] = [];
  const seen = new Set<number>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || !isRepl(match[3])) continue;
    const pid = Number(match[1]);
    const rssKiB = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    if (!Number.isSafeInteger(rssKiB) || rssKiB < 0 || rssKiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024)) continue;
    seen.add(pid);
    processes.push({ pid, rssBytes: rssKiB * 1024 });
  }
  return processes;
}

/**
 * Parses batched `lsof -a -p pid1,pid2 -Fn` output into per-pid cwd and session id, using
 * `p<pid>` marker lines, the `n` line following `fcwd`, and any open lock-file path.
 * @param output Raw lsof -Fn stdout.
 * @param lockPattern Matches a lock path and captures the session id in group 1.
 * @returns Map from pid to its discovered cwd and/or session id.
 */
export function parseLsofLocks(output: string, lockPattern: RegExp): Map<number, ProcessInfo> {
  const map = new Map<number, ProcessInfo>();
  let pid = 0;
  let awaitingCwd = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = parseInt(line.slice(1), 10);
      if (!map.has(pid)) map.set(pid, {});
      awaitingCwd = false;
    } else if (line === 'fcwd') {
      awaitingCwd = true;
    } else if (line.startsWith('f')) {
      awaitingCwd = false;
    } else if (line.startsWith('n') && pid) {
      const entry = map.get(pid)!;
      if (awaitingCwd) {
        entry.cwd = line.slice(1);
        awaitingCwd = false;
      }
      const m = line.match(lockPattern);
      if (m) entry.sessionId = m[1];
    }
  }
  return map;
}
