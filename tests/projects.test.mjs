import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initialTopology, topologySchema } from '../shared/model.mjs';
import { openProjectStore } from '../server/project-store.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-project-unit-'));
  t.after(async () => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-project-unit-'))
      throw Error('Unexpected temp path');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test('projets : migration sans changer les identités ni le fichier original, historique durable', async (t) => {
  const dir = await temp(t),
    legacy = initialTopology();
  legacy.name = 'Existant';
  const original = JSON.stringify(legacy);
  await writeFile(path.join(dir, 'topology.json'), original);
  const store = await openProjectStore(dir);
  assert.equal(store.defaultId, legacy.id);
  assert.deepEqual(store.get(legacy.id).topology, topologySchema.parse(legacy));
  const r = await store.update(legacy.id, 1, (r) => {
    r.tests = [{ id: 'test-a', exitCode: 0, finishedAt: Date.now() }];
  });
  assert.equal(r.revision, 2);
  assert.equal((await openProjectStore(dir)).get(legacy.id).tests[0].id, 'test-a');
  assert.equal(await readFile(path.join(dir, 'topology.json'), 'utf8'), original);
  await writeFile(
    path.join(dir, 'projects-v1.json'),
    JSON.stringify({ version: 99, defaultId: legacy.id }),
  );
  await assert.rejects(openProjectStore(dir));
});
test('projets : copie indépendante, collisions évitées, révisions et archives', async (t) => {
  const store = await openProjectStore(await temp(t));
  assert.equal(store.get(store.defaultId).everDeployed, false);
  let a = await store.create({ name: 'A', hostId: 'local', template: 'example' });
  a = await store.update(a.id, a.revision, (r) => {
    r.topology.nodes.find((n) => n.id === 'client').data.ports = [
      { host: 50123, container: 80, protocol: 'tcp', hostIp: '127.0.0.1' },
    ];
    r.topology.nodes.find((n) => n.id === 'frontend').data.subnet = '10.44.0.0/24';
    r.topology.edges[0].ipv4 = '10.44.0.10';
  });
  const b = await store.create({ name: 'A', hostId: 'remote', copyFrom: a.id });
  assert.notEqual(b.id, a.id);
  assert.equal(b.tests.length, 0);
  assert.deepEqual(b.topology.nodes.find((n) => n.id === 'client').data.ports, []);
  assert.equal(b.topology.nodes.find((n) => n.id === 'frontend').data.subnet, '');
  assert.equal(b.topology.edges[0].ipv4, '');
  assert.equal(store.get(a.id).topology.edges[0].ipv4, '10.44.0.10');
  await assert.rejects(store.create({ name: 'A', hostId: 'local' }), /déjà/);
  const writes = await Promise.allSettled([
    store.update(a.id, a.revision, (r) => {
      r.topology.name = 'B';
    }),
    store.update(a.id, a.revision, (r) => {
      r.topology.name = 'C';
    }),
  ]);
  assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    store.update(a.id, undefined, (r) => {
      r.hostId = 'other';
    }),
    /immuable/,
  );
  const archived = await store.update(a.id, undefined, (r) => {
    r.archivedAt = Date.now();
  });
  await store.create({ name: archived.topology.name, hostId: 'local' });
  await assert.rejects(
    store.update(a.id, undefined, (r) => {
      r.archivedAt = null;
    }),
    /déjà/,
  );
});
test('API projets : hôte exact, brouillon hors ligne, révision obligatoire, verrou par serveur et archive', async (t) => {
  const dir = await temp(t),
    calls = [];
  const engines = new Map([
    [
      'local',
      {
        version: async () => {
          calls.push('local');
          throw Error('offline local');
        },
      },
    ],
    [
      'remote',
      {
        version: async () => {
          calls.push('remote');
          throw Error('offline remote');
        },
        listContainers: async () => [],
        listNetworks: async () => [],
      },
    ],
  ]);
  const workspace = {
    hosts: {
      profile: (id) => {
        if (!engines.has(id)) throw Object.assign(Error('Hôte inconnu'), { statusCode: 404 });
        return { id, name: id, kind: id === 'local' ? 'local' : 'ssh' };
      },
      client: async (id) => {
        if (!engines.has(id)) throw Error('Unknown');
        return engines.get(id);
      },
    },
    hostBusy: () => false,
    captures: { list: () => [] },
  };
  const service = await createProjectService({ dataDir: dir, workspace, emit: () => {} }),
    app = express();
  app.use(express.json());
  mountProjectApi(app, service);
  app.use((e, req, res, next) => res.status(e.statusCode || 400).json({ error: e.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await service.shutdown();
    await new Promise((r) => server.close(r));
  });
  const req = async (url, body, revision, method = 'POST') => {
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + '/api' + url,
      body === undefined
        ? {}
        : {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(revision ? { 'If-Match': String(revision) } : {}),
            },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await req('/projects', { name: 'bad', hostId: 'missing' })).status, 404);
  const p = (await req('/projects', { name: 'Remote', hostId: 'remote', template: 'example' })).body
    .project;
  const state = (await req('/projects/' + p.id + '/state')).body;
  assert.equal(state.runtime.connected, false);
  assert.deepEqual(calls, ['remote']);
  const graph = state.topology;
  graph.nodes[0].data.env = 'DEMO=1';
  assert.equal((await req('/projects/' + p.id + '/topology', graph, undefined, 'PUT')).status, 428);
  assert.equal(
    (await req('/projects/' + p.id + '/topology', graph, p.revision, 'PUT')).status,
    200,
  );
  assert.equal(
    (await req('/projects/' + p.id + '/topology', graph, p.revision, 'PUT')).status,
    409,
  );
  assert.throws(() => service.guardHost('remote', null), /utilisé/);
  assert.throws(() => service.guardHost('remote', { address: 'elsewhere' }), /lié/);
  let release;
  const gate = new Promise((r) => (release = r)),
    operation = service.controller(p.id).run(undefined, () => gate);
  assert.equal(service.hostBusy('remote'), true);
  assert.equal(service.hostBusy('local'), false);
  await assert.rejects(
    service.controller(p.id).run(undefined, () => {}),
    /opération/,
  );
  release();
  await operation;
  const revision = service.store.get(p.id).revision;
  assert.equal((await req('/projects/' + p.id + '/archive', { revision })).status, 200);
  assert.equal(
    (await req('/projects/' + p.id + '/topology', graph, revision + 1, 'PUT')).status,
    409,
  );
  assert.equal(
    (await req('/projects/' + p.id + '/restore', { revision: revision + 1 })).status,
    200,
  );
});
