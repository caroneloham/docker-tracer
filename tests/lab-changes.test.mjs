import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialTopology,
  topologySchema,
  composeObject,
  deploymentSignature,
} from '../shared/model.mjs';
import { planLabChanges, duplicateDevice } from '../shared/lab-changes.mjs';

test('les paramètres graphiques sont conservés dans Compose, y compris UDP, alias et IP fixes', () => {
  const t = initialTopology();
  Object.assign(t.nodes[0].data, {
    cpus: 0.5,
    memoryMb: 128,
    restart: 'unless-stopped',
    dns: ['1.1.1.1'],
    env: 'VALUE=a=b',
    volumes: [{ id: 'config', target: '/config', readOnly: true }],
    ports: [{ host: 5353, container: 53, protocol: 'udp', hostIp: '0.0.0.0' }],
  });
  t.nodes[1].data.subnet = '172.28.0.0/24';
  Object.assign(t.edges[0], { ipv4: '172.28.0.10', aliases: ['dns'] });
  const c = composeObject(t).services.client;
  assert.equal(c.cpus, 0.5);
  assert.equal(c.mem_limit, '128m');
  assert.equal(c.restart, 'unless-stopped');
  assert.equal(c.environment.VALUE, 'a=b');
  assert.deepEqual(c.ports, ['0.0.0.0:5353:53/udp']);
  assert.deepEqual(c.networks.frontend, {
    aliases: ['client', 'dns'],
    ipv4_address: '172.28.0.10',
  });
  assert.deepEqual(c.volumes, ['client-config:/config:ro']);
});

test('validation avant déploiement : IP réservée, dupliquée ou hors sous-réseau, ressources et variables', () => {
  const t = initialTopology();
  t.nodes[1].data.subnet = '172.28.0.0/24';
  for (const ipv4 of ['172.28.0.0', '172.28.0.1', '172.28.0.255', '172.29.0.4', '172.28.0.999']) {
    t.edges[0].ipv4 = ipv4;
    assert.equal(topologySchema.safeParse(t).success, false, ipv4);
  }
  t.edges[0].ipv4 = '172.28.0.10';
  t.edges[1].ipv4 = '172.28.0.10';
  assert.equal(topologySchema.safeParse(t).success, false);
  t.edges[1].ipv4 = '';
  t.nodes[0].data.env = 'PORT=1\nPORT=2';
  assert.equal(topologySchema.safeParse(t).success, false);
  t.nodes[0].data.env = '';
  t.nodes[0].data.memoryMb = 0;
  assert.equal(topologySchema.safeParse(t).success, false);
  t.nodes[0].data.memoryMb = 128;
  assert.equal(topologySchema.safeParse(t).success, true);
});

test('TCP et UDP peuvent publier le même numéro, deux publications TCP ne le peuvent pas', () => {
  const t = initialTopology();
  t.nodes[0].data.ports = [
    { host: 5353, container: 53, protocol: 'tcp' },
    { host: 5353, container: 53, protocol: 'udp' },
  ];
  assert.equal(topologySchema.safeParse(t).success, true);
  t.nodes[0].data.ports[1].protocol = 'tcp';
  assert.equal(topologySchema.safeParse(t).success, false);
});

test('aperçu : une interface modifiée remplace seulement son service, le dessin ne redéploie rien', () => {
  const before = topologySchema.parse(initialTopology()),
    next = structuredClone(before);
  next.nodes[0].data.icon = 'globe';
  next.nodes[1].data.label = 'public';
  next.nodes[0].position.x += 40;
  assert.deepEqual(planLabChanges(before, next).changes, []);
  assert.equal(deploymentSignature(before), deploymentSignature(next));
  next.edges[0].aliases = ['application'];
  assert.deepEqual(
    planLabChanges(before, next).changes.map((c) => [c.id, c.kind]),
    [['client', 'recreate']],
  );
  next.nodes[1].data.internal = true;
  const networkPlan = planLabChanges(before, next);
  assert.equal(networkPlan.blocked.length, 0);
  assert.ok(networkPlan.changes.some((c) => c.id === 'frontend' && c.kind === 'network-recreate'));
  assert.ok(networkPlan.changes.some((c) => c.id === 'web' && c.kind === 'recreate'));
  assert.ok(!networkPlan.changes.some((c) => c.id === 'redis'));
});

test('dupliquer préserve le modèle et évite les collisions de ports, noms, IP et volumes', () => {
  const before = initialTopology();
  before.nodes[0].data.ports = [{ host: 8080, container: 80 }];
  before.nodes[0].data.volume = '/data';
  before.edges[0].aliases = ['shared'];
  const after = duplicateDevice(before, 'client', 'copy');
  const n = after.nodes.find((n) => n.id === 'copy');
  assert.equal(n.data.label, 'client-2');
  assert.deepEqual(n.data.ports, []);
  assert.deepEqual(after.edges.at(-1).aliases, []);
  assert.equal(composeObject(after).services['client-2'].volumes[0], 'copy-data:/data');
  assert.equal(before.nodes.length, 6);
});
