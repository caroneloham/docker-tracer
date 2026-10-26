import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import YAML from 'yaml';
import { docker, deploy, ensureImage, resources, execute } from '../server/docker.mjs';
import { createLabEditor } from '../server/lab-editor.mjs';
import { LABEL, newNode, topologySchema, composeObject } from '../shared/model.mjs';

await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-lab-editor-'));
const id = `edit-${Date.now().toString(36)}`,
  notices = [];
const socket = createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const octet = 100 + Math.floor(Math.random() * 120),
  subnet = `10.243.${octet}.0/24`;
let topology = {
  id,
  name: 'Validation graphique isolée',
  nodes: [
    newNode('client', 'client', { x: 0, y: 0 }, 'client'),
    newNode('network', 'front', { x: 200, y: 0 }, 'front'),
    newNode('nginx', 'web', { x: 400, y: 0 }, 'web'),
    newNode('client', 'spare', { x: 400, y: 200 }, 'spare'),
  ],
  edges: [
    ['client', 'front'],
    ['web', 'front'],
    ['spare', 'front'],
  ].map(([source, target], i) => ({ id: `link-${i}`, source, target, type: 'traffic' })),
};
Object.assign(topology.nodes[0].data, {
  cpus: 0.5,
  memoryMb: 96,
  pidsLimit: 64,
  restart: 'unless-stopped',
  volume: '/data',
  volumes: [{ id: 'config', target: '/config', readOnly: false }],
  env: 'VALUE=a=b',
});
topology.nodes[1].data.subnet = subnet;
topology.nodes[2].data.ports = [
  { host: port, container: 80, protocol: 'tcp' },
  { host: port, container: 80, protocol: 'udp' },
];
Object.assign(topology.edges[0], { ipv4: `10.243.${octet}.10`, aliases: ['probe'] });
Object.assign(topology.edges[1], { ipv4: `10.243.${octet}.20`, aliases: ['website'] });
topology = topologySchema.parse(topology);
const labels = { label: [`${LABEL}.project=${id}`] };
const find = async (name) => {
  const r = await resources(topology),
    row = r.containers.find((c) => c.Labels[`${LABEL}.node`] === name);
  return docker.getContainer(row.Id);
};
const config = {
  engine: docker,
  readTopology: () => topology,
  persist: async (next) => {
    await writeFile(path.join(dir, 'topology.json'), JSON.stringify(next));
    topology = next;
  },
  ensureImage,
  stopCapture: async () => {},
  notify: (n) => notices.push(n),
};
const editor = createLabEditor(config);
try {
  await deploy(topology, (n) => notices.push(n));
  const client = await find('client'),
    web = await find('web'),
    spare = await find('spare');
  const info = await client.inspect(),
    originalWeb = await web.inspect();
  assert.equal(info.HostConfig.Memory, 96 * 1024 ** 2);
  assert.equal(info.HostConfig.NanoCpus, 5e8);
  assert.equal(info.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(info.Mounts.length, 2);
  assert.ok(info.Config.Env.includes('VALUE=a=b'));
  assert.ok(originalWeb.HostConfig.PortBindings['80/udp']);
  assert.equal(
    (
      await execute(topology, 'client', [
        '/bin/sh',
        '-c',
        'printf persistent > /data/marker; printf writable > /tmp/marker',
      ])
    ).exitCode,
    0,
  );
  assert.equal((await execute(topology, 'client', ['nslookup', 'website'])).exitCode, 0);
  const composeFile = path.join(dir, 'compose.yaml');
  await writeFile(composeFile, YAML.stringify(composeObject(topology)));
  await promisify(execFile)('docker', ['compose', '-f', composeFile, 'config', '--quiet'], {
    windowsHide: true,
  });
  await spare.stop({ t: 1 });
  const next = structuredClone(topology);
  next.nodes[0].data.memoryMb = 128;
  next.nodes[3].data.cpus = 0.2;
  next.nodes.push(
    newNode('network', 'back', { x: 200, y: 200 }, 'back'),
    newNode('client', 'extra', { x: 600, y: 200 }, 'extra'),
  );
  next.edges.push(
    { id: 'extra-back', source: 'extra', target: 'back', type: 'traffic' },
    { id: 'client-back', source: 'client', target: 'back', type: 'traffic' },
  );
  const plan = await editor.preview(next);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.blocked.length, 0);
  const applied = await editor.apply(plan.token);
  assert.deepEqual(applied.warnings, []);
  assert.equal((await find('web')).id, web.id);
  assert.equal((await web.inspect()).State.StartedAt, originalWeb.State.StartedAt);
  assert.equal((await (await find('spare')).inspect()).State.Running, false);
  assert.equal((await execute(topology, 'client', ['cat', '/data/marker'])).output, 'persistent');
  assert.equal((await (await find('client')).inspect()).HostConfig.Memory, 128 * 1024 ** 2);
  console.log(
    'PASS : limites, ports TCP/UDP, IP fixe, alias, volumes, Compose valide, application partielle, service intact et arrêt conservé.',
  );

  // Force a failure after the first replacement was already created and started.
  const stableClient = await find('client'),
    stableWeb = await find('web');
  await execute(topology, 'client', ['/bin/sh', '-c', 'printf rollback > /tmp/rollback']);
  const failingEngine = new Proxy(docker, {
    get(target, key) {
      if (key === 'createContainer')
        return (options) => {
          if (options.Hostname === 'web') throw Error('Création volontairement refusée');
          return target.createContainer(options);
        };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  const failingEditor = createLabEditor({ ...config, engine: failingEngine });
  const broken = structuredClone(topology);
  broken.nodes[0].data.cpus = 0.3;
  broken.nodes[2].data.memoryMb = 128;
  const rollbackPlan = await failingEditor.preview(broken);
  await assert.rejects(
    failingEditor.apply(rollbackPlan.token),
    /anciens conteneurs ont été conservés et restaurés/,
  );
  assert.equal((await find('client')).id, stableClient.id);
  assert.equal((await find('web')).id, stableWeb.id);
  assert.equal((await execute(topology, 'client', ['cat', '/tmp/rollback'])).output, 'rollback');
  assert.equal((await execute(topology, 'client', ['nslookup', 'website'])).exitCode, 0);
  assert.equal(topology.nodes[0].data.cpus, 0.5);
  const stale = await editor.preview(broken);
  await stableWeb.stop({ t: 1 });
  await assert.rejects(editor.apply(stale.token), /Docker a changé/);
  await stableWeb.start();
  console.log(
    'PASS : échec injecté après création → restauration des anciens conteneurs, fichiers et DNS ; aperçu périmé refusé.',
  );
  const trimmed = structuredClone(topology);
  trimmed.nodes = trimmed.nodes.filter((n) => !['extra', 'back'].includes(n.id));
  trimmed.edges = trimmed.edges.filter(
    (e) => ![e.source, e.target].some((id) => ['extra', 'back'].includes(id)),
  );
  const removal = await editor.preview(trimmed);
  await editor.apply(removal.token);
  assert.equal((await resources(topology)).networks.length, 1);
  assert.equal((await resources(topology)).containers.length, 3);
  console.log('PASS : retrait graphique de services et réseaux, autres services conservés.');
} finally {
  const containers = await docker.listContainers({ all: true, filters: labels });
  for (const c of containers) await docker.getContainer(c.Id).remove({ force: true, v: false });
  for (const n of await docker.listNetworks({ filters: labels }))
    await docker.getNetwork(n.Id).remove();
  for (const v of (await docker.listVolumes({ filters: labels })).Volumes || [])
    await docker.getVolume(v.Name).remove();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-lab-editor-'))
    throw Error('Chemin de test inattendu');
  await rm(dir, { recursive: true, force: true });
  assert.equal((await docker.listContainers({ all: true, filters: labels })).length, 0);
  console.log('Nettoyage des seules ressources de test terminé.');
}
