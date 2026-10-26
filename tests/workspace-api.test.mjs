import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureEngine } from './fixtures/engine.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { resourceRef } from '../shared/workspace.mjs';
test('API workspace : contrôles persistants, preuves, cible explicite, actions et rejeu', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-api-')),
    f = fixtureEngine(),
    app = express();
  app.use(express.json());
  const w = await mountWorkspaceApi(app, { dataDir: dir, localDocker: f.docker, emit: () => {} }),
    server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await w.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`,
    call = async (url, body, method = body ? 'POST' : 'GET') => {
      const r = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    };
  let r = await call('/api/hosts');
  assert.equal(r.body[0].id, 'local');
  r = await call('/api/hosts/local/inventory');
  const inv = r.body,
    source = resourceRef('local', inv.containers[0]),
    target = resourceRef('local', inv.containers[1]);
  r = await call('/api/checks', {
    name: 'API test',
    source,
    target,
    protocol: 'TCP',
    hostname: 'web',
  });
  assert.equal(r.status, 200);
  const check = r.body;
  r = await call('/api/hosts/wrong/diagnostics', { checkId: check.id });
  assert.equal(r.status, 400);
  r = await call('/api/hosts/local/diagnostics', { checkId: check.id, capture: true });
  assert.equal(r.status, 202);
  await Promise.all([...w.diagnostics.tasks]);
  const run = (await call(`/api/diagnostics/${r.body.id}`)).body;
  assert.equal(run.status, 'passed');
  const pcap = await fetch(base + `/api/captures/${run.captureId}/files/0`);
  assert.equal(pcap.status, 200);
  assert.match(pcap.headers.get('content-type'), /pcap/);
  assert.equal((await pcap.arrayBuffer()).byteLength, 24);
  const action = `/api/hosts/local/containers/${target.containerId}/action`;
  r = await call(action, { action: 'stop', expectedName: 'wrong' });
  assert.equal(r.status, 400);
  assert.equal(f.apps.get(target.containerId).State, 'running');
  r = await call(action, { action: 'stop', expectedName: target.name });
  assert.equal(r.status, 200);
  assert.equal(r.body.checks[0].id, check.id);
  assert.equal(f.apps.get(target.containerId).State, 'exited');
  r = await call('/api/hosts/local/diagnostics', { checkId: check.id });
  await Promise.all([...w.diagnostics.tasks]);
  assert.equal((await call(`/api/diagnostics/${r.body.id}`)).body.status, 'failed');
  assert.equal(
    (await call(`/api/hosts/local/containers/${target.containerId}/logs`)).body.output,
    'fixture log\n',
  );
  r = await call('/api/workspace/inventory');
  assert.equal(r.body.checks.length, 1);
  assert.equal(r.body.runs.length, 2);
  assert.equal(r.body.captures[0].packets, undefined);
  assert.equal((await call('/api/hosts/local', {}, 'DELETE')).status, 400);
  assert.equal(
    (await call('/api/hosts/local/captures', { targets: [source], runId: run.id })).status,
    400,
  );
  const labels = {
    'io.dockertracer.workspace': '1',
    'io.dockertracer.host': 'local',
    'io.dockertracer.role': 'observer',
    'io.dockertracer.session': 'expired-session',
  };
  const own = await f.docker.createContainer({
    Labels: { ...labels, 'io.dockertracer.instance': w.store.read((s) => s.instanceId) },
  });
  const foreign = await f.docker.createContainer({
    Labels: { ...labels, 'io.dockertracer.instance': 'another-workspace' },
  });
  r = await call('/api/hosts/local/recover', {});
  assert.equal(r.body.removed, 1);
  assert.ok(!f.helpers.has(own.id));
  assert.ok(f.helpers.has(foreign.id));
});
