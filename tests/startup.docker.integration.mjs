import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docker, deploy, resources, ensureImage } from '../server/docker.mjs';
import { createLabEditor } from '../server/lab-editor.mjs';
import { checkStartup } from '../server/startup.mjs';
import { openDeploymentStore } from '../server/deployments.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { dockerSshEndpoint } from './docker-ssh.fixture.mjs';
import { LABEL, newNode, topologySchema } from '../shared/model.mjs';
import { configureProxy } from '../shared/proxy.mjs';

await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-startup-docker-')),
  ids = [];
let ssh;
async function run(engine, mode) {
  const id = 'startup-' + mode + '-' + Date.now().toString(36);
  ids.push(id);
  const store = await openDeploymentStore(path.join(dir, mode)),
    project = { id, hostId: mode };
  let topology = topologySchema.parse({
    id,
    name: 'Validation du démarrage',
    nodes: [
      newNode('nginx', 'proxy', { x: 0, y: 0 }, 'proxy'),
      newNode('nginx', 'web', { x: 200, y: 0 }, 'web'),
      newNode('client', 'spare', { x: 0, y: 200 }, 'spare'),
      newNode('network', 'front', { x: 200, y: 200 }, 'front'),
    ],
    edges: ['web', 'spare'].map((source) => ({
      id: source + '-front',
      source,
      target: 'front',
      type: 'traffic',
    })),
  });
  topology = configureProxy(topology, 'proxy', { targetId: 'web', networkId: 'front' });
  topology.nodes[0].data.startup = {
    mode: 'http',
    port: 80,
    path: '/',
    expectedStatus: 200,
    timeoutSeconds: 10,
  };
  topology.nodes[1].data.startup = {
    mode: 'http',
    port: 80,
    path: '/',
    expectedStatus: 200,
    timeoutSeconds: 5,
  };
  topology.nodes[1].data.files = [
    { path: '/usr/share/nginx/html/index.html', content: 'version stable' },
  ];
  const find = async (name) => {
    const r = await resources(topology, engine);
    return engine.getContainer(
      r.containers.find(
        (c) => c.Labels[LABEL + '.node'] === name && c.Labels[LABEL + '.role'] === 'node',
      ).Id,
    );
  };
  const result = await store.record(project, 'deploy', () => deploy(topology, () => {}, engine));
  assert.equal(result.startupChecks.filter((c) => c.status === 'passed').length, 2);
  const proxy = await find('proxy'),
    web = await find('web'),
    spare = await find('spare'),
    proxyInfo = await proxy.inspect();
  await spare.stop({ t: 1 });
  const editor = createLabEditor({
    engine,
    readTopology: () => topology,
    persist: async (t) => {
      topology = t;
    },
    ensureImage: (i, n) => ensureImage(i, n, engine),
    stopCapture: async () => {},
    notify: () => {},
  });
  const bad = structuredClone(topology);
  bad.nodes[1].data.files.push({
    path: '/etc/nginx/conf.d/default.conf',
    content: 'this is not nginx configuration;',
  });
  const plan = await editor.preview(bad);
  assert.equal(plan.startupChecks.find((c) => c.nodeId === 'web').enabled, true);
  await assert.rejects(
    store.record(project, 'apply', () => editor.apply(plan.token)),
    /restaurés/,
  );
  assert.equal((await find('web')).id, web.id);
  assert.equal((await web.inspect()).State.Running, true);
  let failure = store.list(id).find((r) => r.status === 'failed');
  assert.ok(
    failure,
    JSON.stringify(
      store.list(id).map((r) => ({ status: r.status, message: r.message, checks: r.checks })),
    ),
  );
  assert.equal(failure.rollback, 'restored');
  assert.match(
    failure.checks.find((c) => c.nodeId === 'web').applicationLog,
    /unknown directive|emerg/i,
  );
  assert.equal((await find('proxy')).id, proxy.id);
  assert.equal((await proxy.inspect()).State.StartedAt, proxyInfo.State.StartedAt);
  console.log(
    'PASS ' +
      mode +
      ' : proxy et application contrôlés ; configuration Nginx invalide refusée, logs conservés, ancien conteneur restauré.',
  );

  const wrong = structuredClone(topology);
  wrong.nodes[1].data.files.push({
    path: '/etc/nginx/conf.d/default.conf',
    content: 'server { listen 80; location / { return 503; } }',
  });
  const wrongPlan = await editor.preview(wrong);
  await assert.rejects(
    store.record(project, 'apply', () => editor.apply(wrongPlan.token)),
    /503/,
  );
  failure = store.list(id).find((r) => r.message.includes('503'));
  assert.equal(failure.checks[0].status, 'failed');
  assert.ok(failure.checks[0].observations.some((o) => o.httpStatus === 503));
  assert.equal((await find('web')).id, web.id);
  const fixed = structuredClone(topology);
  fixed.nodes[1].data.files[0].content = 'nouvelle version';
  fixed.nodes[2].data.env = 'CHANGED=true';
  fixed.nodes[2].data.startup = {
    mode: 'http',
    port: 8123,
    path: '/',
    expectedStatus: 200,
    timeoutSeconds: 5,
  };
  const fixedPlan = await editor.preview(fixed);
  assert.equal(fixedPlan.startupChecks.find((c) => c.nodeId === 'spare').stopped, true);
  await store.record(project, 'apply', () => editor.apply(fixedPlan.token));
  assert.notEqual((await find('web')).id, web.id);
  assert.equal((await (await find('spare')).inspect()).State.Running, false);
  assert.equal((await find('proxy')).id, proxy.id);
  const reopened = await openDeploymentStore(path.join(dir, mode));
  assert.equal(reopened.list(id).length, 4);
  assert.equal(reopened.list(id).filter((r) => r.status === 'failed').length, 2);
  assert.equal(
    (
      await engine.listContainers({
        all: true,
        filters: { label: [LABEL + '.project=' + id, LABEL + '.role=startup'] },
      })
    ).length,
    0,
  );
  console.log(
    'PASS ' +
      mode +
      ' : HTTP 503 refuse la validation ; correction appliquée, service arrêté conservé, quatre opérations relues sans perte.',
  );

  if (mode === 'local') {
    const n = newNode('custom', 'minimal', { x: 0, y: 0 }, 'minimal');
    n.data.startup = { mode: 'http', port: 80, path: '/', expectedStatus: 200, timeoutSeconds: 5 };
    const image = 'registry.k8s.io/pause:3.10.1';
    await ensureImage(image, () => {}, engine);
    const minimal = await engine.createContainer({
      Image: image,
      Labels: { [LABEL + '.project']: id, [LABEL + '.role']: 'fixture' },
      HostConfig: { NetworkMode: 'container:' + (await find('web')).id },
    });
    await minimal.start();
    assert.equal((await checkStartup(engine, topology, n, minimal)).status, 'passed');
    n.data.startup = { mode: 'tcp', port: 80, path: '/', expectedStatus: 200, timeoutSeconds: 5 };
    assert.equal((await checkStartup(engine, topology, n, minimal)).status, 'passed');
    n.data.startup.port = 12345;
    assert.equal((await checkStartup(engine, topology, n, minimal)).status, 'failed');
    await minimal.remove({ force: true });
    console.log(
      'PASS image sans shell : HTTP et TCP par sonde séparée, port fermé détecté, sondes retirées.',
    );
  }
}
try {
  await run(docker, 'local');
  ssh = await dockerSshEndpoint(dir, docker);
  const hosts = new HostRegistry(await openWorkspaceStore(dir), docker),
    h = await hosts.save(ssh.profile),
    challenge = await hosts.test(h.id);
  await hosts.trust(h.id, challenge.fingerprint);
  await run(await hosts.client(h.id), 'ssh');
  // A failed first deployment must clean only its new containers and networks.
  const id = 'startup-initial-' + Date.now().toString(36);
  ids.push(id);
  const n = newNode('nginx', 'broken', { x: 0, y: 0 }, 'broken');
  n.data.files = [{ path: '/etc/nginx/conf.d/default.conf', content: 'invalid directive;' }];
  const t = topologySchema.parse({ id, name: 'Échec initial', nodes: [n], edges: [] });
  await assert.rejects(
    deploy(t, () => {}),
    /marche/,
  );
  assert.equal((await resources(t)).containers.length, 0);
  console.log('PASS : premier déploiement invalide nettoyé.');
} finally {
  for (const id of ids) {
    const filters = { label: [LABEL + '.project=' + id] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true, v: false });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
    assert.equal((await docker.listContainers({ all: true, filters })).length, 0);
  }
  await ssh?.close();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-startup-docker-'))
    throw Error('Unexpected path');
  await rm(dir, { recursive: true, force: true });
  console.log('Nettoyage des seules ressources de validation terminé.');
}
