import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HaeinClient, HaeinTask } from '../src/haein/client';
import { HaeinControlServer, parseFocusRequest, sendFocusRequest } from '../src/haein/control';
import { HaeinRuntime } from '../src/haein/runtime';
import { groupTasks } from '../src/haein/tasks';
import { DesktopNotifier } from '../src/notify';
import { SessionManager } from '../src/sessionManager';
import { TagStore } from '../src/tags';

function task(id: string, stage = 'Running', tag = ''): HaeinTask {
  return { id, title: `Task ${id}`, stage, agent: 'test-agent', worktree: '/tmp', branch: 'main', sessionId: '', logPath: '', renderedPrompt: '', prompt: '', tag, agentPid: 0, attention: '', prs: [], createdAt: '', updatedAt: '' };
}

function wireTask(id: string): Record<string, unknown> {
  const value = task(id);
  return { id: value.id, title: value.title, stage: value.stage, agent: value.agent, worktree: value.worktree, branch: value.branch, session_id: value.sessionId, log_path: value.logPath, rendered_prompt: value.renderedPrompt, prompt: value.prompt, tag: value.tag, agent_pid: value.agentPid, attention: value.attention, prs: value.prs, created_at: value.createdAt, updated_at: value.updatedAt };
}

async function listen(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
}

/** Exercises typed Unix-socket Haein requests against a real Node HTTP server. */
test('Haein client lists tasks and sends launch/process/tag requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgui-haein-client-'));
  const socketPath = path.join(root, 'haein.sock');
  const received: Array<{ method: string; url: string; body: string }> = [];
  let taskResponse = wireTask('one');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      received.push({ method: request.method || '', url: request.url || '', body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/health') response.end('{"ok":true}');
      else if (request.url === '/v1/tasks') response.end(JSON.stringify({ tasks: [taskResponse] }));
      else if (request.url === '/v1/tasks/one/launch') response.end(JSON.stringify({ task_id: 'one', title: 'Task one', agent: 'test-agent', cwd: root, argv: ['/bin/sh', '-c', 'sleep 1'], session_id: 'native' }));
      else response.end('{}');
    });
  });
  try {
    await listen(server, socketPath);
    const client = new HaeinClient(socketPath);
    assert.deepEqual(await client.health(), { ok: true });
    const listed = (await client.listTasks()).tasks[0];
    assert.equal(listed.id, 'one');
    assert.equal(listed.agentPid, 0);
    assert.equal(listed.attention, '');
    taskResponse = { ...wireTask('invalid'), agent_pid: null };
    await assert.rejects(client.listTasks(), /agent_pid must be a number/);
    taskResponse = { ...wireTask('invalid'), attention: false };
    await assert.rejects(client.listTasks(), /attention must be a string/);
    assert.deepEqual((await client.launch('one')).argv, ['/bin/sh', '-c', 'sleep 1']);
    await client.reportProcess('one', 76, '');
    assert.deepEqual(received.at(-1), { method: 'POST', url: '/v1/tasks/one/process', body: '{"pid":76}' });
    await client.reportProcess('one', 77, 'native');
    await client.reportProcessExited('one', 77);
    await client.tag('one', 'review');
    assert.deepEqual(received.slice(-3), [
      { method: 'POST', url: '/v1/tasks/one/process', body: '{"pid":77,"session_id":"native"}' },
      { method: 'POST', url: '/v1/tasks/one/process-exited', body: '{"pid":77}' },
      { method: 'POST', url: '/v1/tasks/one/tag', body: '{"tag":"review"}' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Haein grouping follows pipeline order and tag labels', () => {
  const tasks = [task('unknown', 'Elsewhere', 'z'), task('merge', 'Merged', 'a'), task('run', 'Running', ''), task('attention', 'Needs Attention', 'a')];
  assert.deepEqual(groupTasks(tasks, 'pipeline_stage').map((group) => group.label), ['Running', 'Needs Attention', 'Merged', 'Elsewhere']);
  assert.deepEqual(groupTasks(tasks, 'tag').map((group) => group.label), ['a', 'Untagged', 'z']);
});

test('Haein control socket parses and delivers typed focus messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgui-haein-control-'));
  const socketPath = path.join(root, 'control.sock');
  const focused: string[] = [];
  const server = new HaeinControlServer(socketPath, (taskId) => focused.push(taskId));
  try {
    assert.throws(() => parseFocusRequest('{"type":"other"}'));
    await server.start();
    assert.deepEqual(await sendFocusRequest(socketPath, 'task-1'), { ok: true, error: undefined });
    assert.deepEqual(focused, ['task-1']);
    assert.equal((fs.statSync(socketPath).mode & 0o777), 0o600);
  } finally {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Verifies deferred focus auto-launches once and later focus reattaches the owned PTY. */
test('Haein deferred focus activates once and reattaches an owned session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgui-haein-focus-'));
  const socketPath = path.join(root, 'haein.sock');
  const executable = path.join(root, 'agent');
  let launchCalls = 0;
  fs.writeFileSync(executable, '#!/bin/sh\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n', { mode: 0o700 });
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/v1/tasks') response.end(JSON.stringify({ tasks: [wireTask('one')] }));
      else if (request.url === '/v1/tasks/one/launch') {
        launchCalls++;
        response.end(JSON.stringify({ task_id: 'one', title: 'Task one', agent: 'test-agent', cwd: root, argv: [executable], session_id: '' }));
      } else response.end('{}');
    });
  });
  try {
    await listen(server, socketPath);
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    const manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const runtime = new HaeinRuntime(new HaeinClient(socketPath), manager, manager.tagStore, () => {}, 'one');
    await runtime.store.refresh();
    runtime.focusTask('one');
    runtime.focusTask('one');
    for (let attempt = 0; attempt < 50 && !manager.attachedSession; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const session = manager.attachedSession;
    assert.ok(session);
    assert.equal(launchCalls, 1);
    await runtime.store.refresh();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(launchCalls, 1);
    manager.detach();
    runtime.focusTask('one');
    assert.equal(manager.attachedSession, session);
    assert.equal(launchCalls, 1);
    manager.killAll();
    session!.term.dispose();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Verifies a Haein launch's executable is used in a real PTY and lifecycle posts occur. */
test('Haein generic PTY uses launch argv and reports lifecycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgui-haein-pty-'));
  const socketPath = path.join(root, 'haein.sock');
  const executable = path.join(root, 'agent');
  const processBodies: string[] = [];
  const exitedBodies: string[] = [];
  fs.writeFileSync(executable, '#!/bin/sh\necho generic-agent\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n', { mode: 0o700 });
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      if (request.url === '/v1/tasks') response.end(JSON.stringify({ tasks: [wireTask('one')] }));
      else if (request.url === '/v1/tasks/one/launch') response.end(JSON.stringify({ task_id: 'one', title: 'Task one', agent: 'test-agent', cwd: root, argv: [executable], session_id: 'native' }));
      else if (request.url === '/v1/tasks/one/process') { processBodies.push(body); response.end('{}'); }
      else if (request.url === '/v1/tasks/one/process-exited') { exitedBodies.push(body); response.end('{}'); }
      else response.end('{}');
    });
  });
  try {
    await listen(server, socketPath);
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ tags: ['code'] }));
    const manager = new SessionManager(root, [root], new TagStore(configPath), () => {}, new DesktopNotifier(false));
    const runtime = new HaeinRuntime(new HaeinClient(socketPath), manager, manager.tagStore, () => {});
    await runtime.store.refresh();
    const session = await runtime.launchOrAttach();
    assert.ok(session);
    assert.equal(session!.cwd, root);
    assert.match(await new Promise<string>((resolve) => session!.term.onWriteParsed(() => resolve(session!.term.buffer.active.getLine(0)?.translateToString() || ''))), /generic-agent/);
    assert.equal(processBodies.length, 1);
    assert.match(processBodies[0], /"pid":\d+/);
    session!.kill();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(exitedBodies.length, 1);
    manager.killAll();
    session!.term.dispose();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
