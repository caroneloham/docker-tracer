import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docker, resources } from '../server/docker.mjs';
import { LABEL } from '../shared/model.mjs';
import { resourceRef } from '../shared/workspace.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';
import { openProjectStore } from '../server/project-store.mjs';
import { dockerSshEndpoint } from './docker-ssh.fixture.mjs';
await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-project-docker-')),
  ids = [],
  events = [];
let service, server, ssh, workspace;
const app = express();
app.use(express.json());
try {
  workspace = await mountWorkspaceApi(app, {
    dataDir: dir,
    localDocker: docker,
    emit: (e) => events.push(e),
    labBusy: (id) => service?.hostBusy(id) || false,
    guardHost: (id, next) => service?.guardHost(id, next),
    projectList: () => service?.list() || [],
  });
  service = await createProjectService({ dataDir: dir, workspace, emit: (e) => events.push(e) });
  mountProjectApi(app, service);
  app.use((e, req, res, next) => res.status(e.statusCode || 400).json({ error: e.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const api = async (url, body, revision, method = 'POST') => {
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
    const result = await response.json();
    return { status: response.status, result };
  };
  const ok = async (...args) => {
    const r = await api(...args);
    assert.ok(r.status < 300, JSON.stringify(r));
    return r.result;
  };
  const create = async (hostId, name) => {
    const p = (await ok('/projects', { name, hostId, template: 'example' })).project;
    ids.push(p.id);
    return p;
  };
  const mutate = async (p, url, body) =>
    ok('/projects/' + p.id + url, body, service.store.get(p.id).revision);
  const a = await create('local', 'Infrastructure A');
  await mutate(a, '/deploy', {});
  const before = (await resources(service.store.get(a.id).topology, docker)).containers.map(
    (c) => ({ id: c.Id, state: c.State }),
  );
  assert.equal(before.length, 4);
  console.log('Projet local A déployé : 4 conteneurs.');
  ssh = await dockerSshEndpoint(dir, docker);
  const h = await ok('/hosts', ssh.profile),
    trust = await ok('/hosts/' + h.id + '/test', {});
  assert.equal(trust.state, 'untrusted');
  assert.equal(
    (await ok('/hosts/' + h.id + '/trust', { fingerprint: trust.fingerprint })).state,
    'connected',
  );
  const b = await create(h.id, 'Infrastructure B via SSH');
  await mutate(b, '/deploy', {});
  const bState = await ok('/projects/' + b.id + '/state');
  assert.equal(bState.runtime.connected, true);
  assert.equal(Object.keys(bState.runtime.nodes).length, 4);
  console.log('Projet B déployé par SSH authentifié sur le moteur de test.');
  const remoteEngine = await workspace.hosts.client(h.id);
  const after = (await resources(service.store.get(a.id).topology, docker)).containers.map((c) => ({
    id: c.Id,
    state: c.State,
  }));
  assert.deepEqual(
    after.sort((a, b) => a.id.localeCompare(b.id)),
    before.sort((a, b) => a.id.localeCompare(b.id)),
  );
  const rev = service.store.get(b.id).revision;
  await mutate(b, '/capture', { enabled: true });
  const probe = await mutate(b, '/probe', {
    source: 'client',
    target: 'web',
    protocol: 'ICMP',
    count: 1,
    ttl: 41,
    size: 48,
  });
  assert.equal(probe.exitCode, 0, probe.output);
  for (
    let i = 0;
    i < 20 && !events.some((e) => e.type === 'packet' && e.packet.protocol === 'ICMP');
    i++
  )
    await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    events.some(
      (e) =>
        e.type === 'packet' &&
        e.packet.protocol === 'ICMP' &&
        e.projectId === b.id &&
        e.hostId === h.id,
    ),
    'Enveloppes réelles via le transport SSH, identifiées par projet et serveur',
  );
  await mutate(b, '/capture', { enabled: false });
  const hostInventory = await workspace.hosts.inventory(h.id);
  const ref = (node) =>
    resourceRef(
      h.id,
      hostInventory.containers.find((c) => c.labId === b.id && c.service === node && !c.isProbe),
    );
  const check = await ok('/checks', {
    name: 'HTTP via SSH',
    source: ref('client'),
    target: ref('web'),
    protocol: 'HTTP',
    hostname: 'web',
  });
  const run = await ok('/hosts/' + h.id + '/diagnostics', { checkId: check.id, capture: true });
  await Promise.all([...workspace.diagnostics.tasks]);
  const outcome = await ok('/diagnostics/' + run.id);
  assert.equal(outcome.status, 'passed', JSON.stringify(outcome));
  const captured = workspace.captures.get(outcome.captureId);
  assert.equal(captured.status, 'completed', JSON.stringify(captured.errors));
  assert.equal(captured.files.length, 2);
  assert.ok(captured.count > 0);
  for (const file of captured.files)
    assert.ok((await workspace.captures.file(captured.id, file.index)).buffer.length > 24);
  console.log('Enveloppes, diagnostic HTTP et deux PCAP réels via SSH : OK.');
  const inventory = await ok('/workspace/inventory');
  assert.ok(
    inventory.containers.some((c) => c.labId === a.id && c.project.endsWith('/ Infrastructure A')),
  );
  assert.equal(probe.hostId, undefined);
  assert.equal((await openProjectStore(dir)).get(b.id).tests[0].id, probe.id);
  assert.equal((await openProjectStore(dir)).get(a.id).tests.length, 0);
  assert.equal(
    (await api('/projects/' + b.id + '/topology', bState.topology, rev, 'PUT')).status,
    409,
  );
  const graph = service.store.get(b.id).topology;
  graph.nodes.find((n) => n.id === 'client').data.env = 'PROJECT=B';
  const plan = await mutate(b, '/lab/preview', graph);
  await mutate(b, '/lab/apply', { token: plan.token });
  assert.ok(
    (
      await remoteEngine
        .getContainer(
          (await resources(graph, remoteEngine)).containers.find(
            (c) => c.Labels[LABEL + '.node'] === 'client',
          ).Id,
        )
        .inspect()
    ).Config.Env.includes('PROJECT=B'),
  );
  console.log('Diagnostic ICMP, historique durable et modification progressive via SSH validés.');
  await mutate(a, '/lab/action', { action: 'stop' });
  assert.ok(
    (await resources(service.store.get(a.id).topology, docker)).containers.every(
      (c) => c.State === 'exited',
    ),
  );
  assert.ok(
    (await resources(service.store.get(b.id).topology, remoteEngine)).containers.every(
      (c) => c.State === 'running',
    ),
  );
  assert.equal(
    (await api('/projects/' + b.id + '/archive', { revision: service.store.get(b.id).revision }))
      .status,
    409,
  );
  assert.equal(
    (await api('/hosts/' + h.id, { ...h, address: 'elsewhere' }, undefined, 'PUT')).status,
    409,
  );
  assert.equal((await api('/hosts/' + h.id, {}, undefined, 'DELETE')).status, 409);
  await mutate(b, '/lab/action', { action: 'remove' });
  let archive = await ok('/projects/' + b.id + '/archive', {
    revision: service.store.get(b.id).revision,
  });
  await ok('/projects/' + b.id + '/restore', { revision: archive.project.revision });
  await ssh.close();
  const offline = await service.controller(b.id).state();
  await service.controller(b.id).refresh(true);
  assert.equal((await service.controller(b.id).state()).runtime.connected, false);
  const failed = await api('/projects/' + b.id + '/deploy', {}, service.store.get(b.id).revision);
  assert.ok(failed.status >= 400);
  assert.ok(
    (await resources(service.store.get(a.id).topology, docker)).containers.every(
      (c) => c.State === 'exited',
    ),
    'Aucune retombée sur le moteur local après coupure SSH',
  );
  assert.ok(
    events.filter((e) => e.type === 'notice').every((e) => ids.includes(e.projectId) && e.hostId),
  );
  console.log(
    'Arrêt isolé, archive/restauration, protection du profil et coupure SSH sans mauvaise cible : OK.',
  );
} finally {
  await service?.shutdown();
  await workspace?.shutdown();
  await ssh?.close();
  if (server) await new Promise((r) => server.close(r));
  for (const id of ids) {
    const filters = { label: [LABEL + '.project=' + id] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true, v: false });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-project-docker-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Ressources des projets de test nettoyées.');
}
