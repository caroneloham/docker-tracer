import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkStartup, startupCommand, verifyStartup } from '../server/startup.mjs';
import { openDeploymentStore } from '../server/deployments.mjs';
import { startupSchema, assertStartupSupport } from '../shared/startup.mjs';
import { newNode, topologySchema, composeObject } from '../shared/model.mjs';
const fixture = (mode = 'http') => {
  let time = 0,
    removed = 0,
    creation;
  const n = newNode('nginx', 'web', { x: 0, y: 0 }, 'web');
  n.data.startup = startupSchema.parse({ mode, timeoutSeconds: 5 });
  const state = {
    Running: true,
    Status: 'running',
    StartedAt: 'generation-1',
    Health: { Status: 'healthy' },
  };
  const container = {
    id: 'actual-container',
    inspect: async () => ({ State: state, RestartCount: 0 }),
    logs: async () => Buffer.from('evidence'),
  };
  const helper = {
    id: 'helper',
    start: async () => {},
    remove: async () => {
      removed++;
    },
  };
  const engine = {
    createContainer: async (options) => {
      creation = options;
      return helper;
    },
  };
  const clock = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  return {
    n,
    container,
    engine,
    clock,
    state,
    get removed() {
      return removed;
    },
    get creation() {
      return creation;
    },
  };
};
test('startup HTTP retries, requires stable success, scopes and cleans its probe', async () => {
  const f = fixture();
  let attempt = 0;
  const result = await checkStartup(f.engine, { id: 'test' }, f.n, f.container, {
    ...f.clock,
    exec: async () => ({ exitCode: 0, stdout: ++attempt < 2 ? '503' : '200', stderr: '' }),
  });
  assert.equal(result.status, 'passed');
  assert.ok(result.attempts >= 5);
  assert.equal(f.creation.HostConfig.NetworkMode, 'container:actual-container');
  assert.equal(f.creation.HostConfig.AutoRemove, true);
  assert.equal(f.creation.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(f.creation.HostConfig.CapDrop, ['ALL']);
  assert.equal(f.removed, 1);
});
test('startup separates failed checks, absent image health, interrupted transport and missing tools', async () => {
  const f = fixture('tcp');
  let r = await checkStartup(f.engine, { id: 'test' }, f.n, f.container, {
    ...f.clock,
    exec: async () => ({ exitCode: 1, stdout: '', stderr: 'closed' }),
  });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /Délai/);
  assert.equal(r.applicationLog, 'evidence');
  const h = fixture('health');
  delete h.state.Health;
  r = await checkStartup(h.engine, { id: 'test' }, h.n, h.container, h.clock);
  assert.equal(r.status, 'inconclusive');
  const offline = fixture();
  offline.container.inspect = async () => {
    throw Error('SSH interrompu');
  };
  r = await checkStartup(
    offline.engine,
    { id: 'test' },
    offline.n,
    offline.container,
    offline.clock,
  );
  assert.equal(r.status, 'inconclusive');
  assert.match(r.summary, /SSH/);
  const tool = fixture();
  r = await checkStartup(tool.engine, { id: 'test' }, tool.n, tool.container, {
    ...tool.clock,
    exec: async () => ({ exitCode: 127, stdout: '', stderr: 'missing', output: 'missing' }),
  });
  assert.equal(r.status, 'inconclusive');
  assert.equal(tool.removed, 1);
});
test('startup process exit and restart reset cannot become success; inherited health is supported', async () => {
  const f = fixture('running');
  f.state.Running = false;
  f.state.ExitCode = 1;
  f.state.Status = 'exited';
  assert.equal(
    (await checkStartup(f.engine, { id: 'test' }, f.n, f.container, f.clock)).status,
    'failed',
  );
  const h = fixture('health');
  assert.equal(
    (await checkStartup(h.engine, { id: 'test' }, h.n, h.container, h.clock)).status,
    'passed',
  );
  const r = fixture('running');
  let generations = 0;
  r.container.inspect = async () => ({ State: { ...r.state, StartedAt: String(generations++) } });
  assert.equal(
    (await checkStartup(r.engine, { id: 'test' }, r.n, r.container, r.clock)).status,
    'failed',
  );
  const disabled = fixture('none');
  disabled.container.inspect = () => {
    throw Error('must not inspect');
  };
  assert.equal(
    (await checkStartup(disabled.engine, { id: 'test' }, disabled.n, disabled.container)).status,
    'skipped',
  );
});
test('startup schema bounds checks and older servers cannot silently discard them', () => {
  for (const input of [
    { timeoutSeconds: 0 },
    { port: 65536 },
    { path: 'http://elsewhere' },
    { path: '/a\nb' },
    { expectedStatus: 999 },
  ])
    assert.equal(startupSchema.safeParse(input).success, false);
  const f = fixture();
  assert.throws(() => assertStartupSupport({ nodes: [f.n] }, undefined), /Redémarre/);
  assert.doesNotThrow(() => assertStartupSupport({ nodes: [f.n] }, { startupChecks: true }));
  const command = startupCommand({ ...f.n.data.startup, path: '/health?value=$HOME' });
  assert.equal(command.at(-1), 'http://127.0.0.1:80/health?value=$HOME');
  assert.ok(!command.includes('/bin/sh'));
  const t = topologySchema.parse({ id: 'test', name: 'test', nodes: [f.n], edges: [] });
  assert.equal(composeObject(t).services.web['x-docker-tracer-startup'].mode, 'http');
});
test('deployment evidence survives reopening; interrupted operations stay inconclusive and retention is bounded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-startup-store-'));
  try {
    const s = await openDeploymentStore(dir),
      p = { id: 'p', hostId: 'local' };
    await s.record(p, 'deploy', async () => ({ startupChecks: [{ status: 'passed' }] }));
    await assert.rejects(
      s.record(p, 'apply', async () => {
        throw Object.assign(Error('bad config'), {
          rollback: 'restored',
          startupChecks: [{ status: 'failed' }],
        });
      }),
      /bad config/,
    );
    let reopened = await openDeploymentStore(dir);
    assert.equal(reopened.list('p').length, 2);
    assert.equal(reopened.list('p').find((r) => r.kind === 'apply').rollback, 'restored');
    for (let i = 0; i < 21; i++) await reopened.record(p, 'apply', async () => ({}));
    assert.equal(reopened.list('p').length, 20);
    const file = path.join(dir, 'deployments-v1.json'),
      state = JSON.parse(await readFile(file, 'utf8'));
    state.runs[0].status = 'running';
    await writeFile(file, JSON.stringify(state));
    reopened = await openDeploymentStore(dir);
    assert.equal(reopened.list('p')[0].status, 'inconclusive');
  } finally {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-startup-store-'))
      throw Error('Unexpected path');
    await rm(dir, { recursive: true, force: true });
  }
});
