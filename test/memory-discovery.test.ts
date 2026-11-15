import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Discovery, OwnedSessionSample, parsePsDevinPids, parsePsDevinProcesses } from '../src/discovery';

/**
 * Verifies RSS validation, command filtering, compatibility parsing, and PID deduplication.
 * @returns Nothing after synchronous parser assertions.
 */
function testProcessParser(): void {
  const output = [
    '  11 1024 devin',
    '  12 2048 devin --debug',
    '  13 4096 devin list',
    '  14 512 devin auth',
    '  15 nope devin',
    '  16 -1 devin',
    '  17 1.5 devin',
    '  18 8796093022208 devin',
    '  19 900 node devin',
    '  11 9999 devin',
    '  20 0 devin --resume saved',
    '  bad 20 devin',
  ].join('\n');
  assert.deepEqual(parsePsDevinProcesses(output), [
    { pid: 11, rssBytes: 1024 ** 2 },
    { pid: 12, rssBytes: 2 * 1024 ** 2 },
    { pid: 20, rssBytes: 0 },
  ]);
  assert.deepEqual(parsePsDevinPids('  21 devin\n  22 devin --flag\n  23 devin rules\n'), [21, 22]);
  assert.deepEqual(parsePsDevinPids('  24 10 devin\n  25 20 devin update\n'), [24]);
}

/**
 * Exercises one synthetic discovery sample and confirms failed ps retains every memory value.
 * @returns Promise resolved after scripts, environment, and temporary files are restored.
 */
async function testDiscoveryMemoryMapping(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-memory-discovery-'));
  const bin = path.join(root, 'bin');
  const failMarker = path.join(root, 'fail-ps');
  const previousPath = process.env.PATH;
  const previousMarker = process.env.PS_FAIL_MARKER;
  const updates: Map<number, OwnedSessionSample>[] = [];
  let redraws = 0;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
if [ -f "$PS_FAIL_MARKER" ]; then exit 1; fi
cat <<'EOF'
  101 100 devin --owned
  202 200 devin
  303 300 devin --unmapped
  404 400 devin list
EOF
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
cat <<'EOF'
p101
fcwd
n${root}
p202
fcwd
n${root}
f10
n${path.join(root, 'session_locks', 'external-id.lock')}
EOF
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'devin'), `#!/bin/sh
printf '[{"id":"external-id","working_directory":"${root}","title":"External title","last_activity_ago":"now","last_activity_at":1}]\\n'
`, { mode: 0o700 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.PS_FAIL_MARKER = failMarker;
    const discovery = new Discovery(
      () => new Set([101]),
      () => new Set<string>(),
      [root],
      (sample) => updates.push(new Map([...sample].map(([pid, value]) => [pid, { ...value }]))),
      () => {
        redraws++;
      }
    );
    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.equal(discovery.totalMemoryBytes, 600 * 1024);
    assert.deepEqual(updates, [new Map([[101, { memoryBytes: 100 * 1024 }]])]);
    assert.deepEqual(discovery.externals, [{
      pid: 202,
      sessionId: 'external-id',
      cwd: root,
      title: 'External title',
      lastAgo: 'now',
      memoryBytes: 200 * 1024,
    }]);
    assert.equal(redraws, 1);

    fs.writeFileSync(failMarker, 'fail');
    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.equal(discovery.totalMemoryBytes, 600 * 1024);
    assert.equal(discovery.externals[0].memoryBytes, 200 * 1024);
    assert.equal(updates.length, 1);
    assert.equal(redraws, 2);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.PS_FAIL_MARKER;
    else process.env.PS_FAIL_MARKER = previousMarker;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Verifies the single read-only SQLite fallback, validation, retention, sorting, and capping.
 * @returns Promise resolved after isolated commands, database, and environment are removed.
 */
async function testRecentSqliteFallback(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-conductor-recent-fallback-'));
  const bin = path.join(root, 'bin');
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  const unknownDir = path.join(root, 'unknown');
  const dbPath = path.join(root, 'sessions.db');
  const sqliteLog = path.join(root, 'sqlite.log');
  const primarySuccess = path.join(root, 'primary-success');
  const fallbackFailure = path.join(root, 'fallback-failure');
  const previousPath = process.env.PATH;
  const previousSqliteLog = process.env.SQLITE_LOG;
  const previousFallbackFailure = process.env.SQLITE_FAIL_MARKER;
  const previousPrimarySuccess = process.env.PRIMARY_SUCCESS_MARKER;
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.mkdirSync(unknownDir);
    fs.writeFileSync(path.join(bin, 'ps'), "#!/bin/sh\nprintf '  909 1024 devin --external\\n'\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
cat <<'EOF'
p909
fcwd
n${dirA}
f10
n${path.join(root, 'session_locks', 'running-id.lock')}
EOF
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'devin'), `#!/bin/sh
if [ -f "$PRIMARY_SUCCESS_MARKER" ]; then
  printf '[{"id":"primary-id","working_directory":"${dirA}","title":"primary","last_activity_ago":"just now","last_activity_at":%s}]\\n' "$(date +%s)"
  exit 0
fi
printf 'Error: database disk image is malformed\\n' >&2
exit 1
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SQLITE_LOG"
if [ -f "$SQLITE_FAIL_MARKER" ]; then exit 1; fi
exec /usr/bin/sqlite3 "$@"
`, { mode: 0o700 });
    const now = Math.floor(Date.now() / 1000);
    const statements = [
      'CREATE TABLE sessions (id, working_directory, last_activity_at, title, hidden)',
      ...Array.from({ length: 12 }, (_, index) => `INSERT INTO sessions VALUES ('recent-${String(index).padStart(2, '0')}', '${index % 2 === 0 ? dirA : dirB}', ${now - index * 300}, 'Recent ${index}', 0)`),
      `INSERT INTO sessions VALUES ('running-id', '${dirA}', ${now + 20}, 'Running', 0)`,
      `INSERT INTO sessions VALUES ('owned-id', '${dirB}', ${now + 10}, 'Owned', 0)`,
      `INSERT INTO sessions VALUES ('hidden-id', '${dirA}', ${now}, 'Hidden', 1)`,
      `INSERT INTO sessions VALUES ('old-id', '${dirA}', ${now - 90000}, 'Old', 0)`,
      `INSERT INTO sessions VALUES ('unknown-id', '${unknownDir}', ${now}, 'Unknown', 0)`,
      `INSERT INTO sessions VALUES ('', '${dirA}', ${now}, 'Empty id', 0)`,
      `INSERT INTO sessions VALUES ('empty-cwd', '', ${now}, 'Empty cwd', 0)`,
      `INSERT INTO sessions VALUES ('bad-activity', '${dirA}', 'bad', 'Bad activity', 0)`,
      `INSERT INTO sessions VALUES ('bad-title', '${dirA}', ${now}, 42, 0)`,
    ];
    execFileSync('/usr/bin/sqlite3', [dbPath, statements.join(';')]);
    const initialDb = fs.readFileSync(dbPath);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.SQLITE_LOG = sqliteLog;
    process.env.SQLITE_FAIL_MARKER = fallbackFailure;
    process.env.PRIMARY_SUCCESS_MARKER = primarySuccess;
    const discovery = new Discovery(
      () => new Set<number>(),
      () => new Set(['owned-id']),
      [dirA, dirB],
      () => {},
      () => {},
      dbPath
    );

    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.equal(fs.readFileSync(sqliteLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(discovery.recentFallbackActive, true);
    assert.equal(discovery.recents.length, 10);
    assert.deepEqual(discovery.recents.map((recent) => recent.sessionId), Array.from({ length: 10 }, (_, index) => `recent-${String(index).padStart(2, '0')}`));
    assert.equal(discovery.recents.every((recent) => recent.cwd === dirA || recent.cwd === dirB), true);
    assert.equal(discovery.recents[0].lastAgo, 'just now');
    assert.match(discovery.recents[1].lastAgo, /^5m ago$/);
    assert.deepEqual(fs.readFileSync(dbPath), initialDb);

    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.equal(fs.readFileSync(sqliteLog, 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(fs.readFileSync(dbPath), initialDb);

    fs.writeFileSync(primarySuccess, 'success');
    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.equal(fs.readFileSync(sqliteLog, 'utf8').trim().split('\n').length, 2);
    assert.equal(discovery.recentFallbackActive, false);
    assert.equal(discovery.recents.some((recent) => recent.sessionId === 'primary-id'), true);

    fs.rmSync(primarySuccess);
    fs.writeFileSync(fallbackFailure, 'fail');
    const retained = discovery.recents.map((recent) => recent.sessionId);
    await (discovery as unknown as { poll: () => Promise<void> }).poll();
    assert.deepEqual(discovery.recents.map((recent) => recent.sessionId), retained);
    assert.equal(discovery.recentFallbackActive, false);
    assert.deepEqual(fs.readFileSync(dbPath), initialDb);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSqliteLog === undefined) delete process.env.SQLITE_LOG;
    else process.env.SQLITE_LOG = previousSqliteLog;
    if (previousFallbackFailure === undefined) delete process.env.SQLITE_FAIL_MARKER;
    else process.env.SQLITE_FAIL_MARKER = previousFallbackFailure;
    if (previousPrimarySuccess === undefined) delete process.env.PRIMARY_SUCCESS_MARKER;
    else process.env.PRIMARY_SUCCESS_MARKER = previousPrimarySuccess;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('ps parser validates and deduplicates Devin main-process RSS', testProcessParser);
test('discovery maps owned/external RSS, totals unmapped PIDs, and retains failed samples', testDiscoveryMemoryMapping);
test('discovery uses one read-only SQLite fallback per failed poll and retains cached recents', testRecentSqliteFallback);
