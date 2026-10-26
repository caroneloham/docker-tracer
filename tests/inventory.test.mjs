import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventory, inventoryView, layoutInventory } from '../shared/inventory.mjs';
import { createInventoryService } from '../server/inventory.mjs';
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const networks = [
  { Id: 'net-1', Name: 'app', Driver: 'bridge', IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] } },
  { Id: 'net-2', Name: 'isolated', Driver: 'bridge', Internal: true },
  { Id: 'host', Name: 'host', Driver: 'host' },
  { Id: 'none', Name: 'none', Driver: 'null' },
];
const container = (Id, name, extras = {}) => ({
  Id,
  Names: [`/${name}`],
  Image: 'alpine:3.23',
  State: 'running',
  Status: 'Up 2 minutes',
  Labels: {},
  NetworkSettings: {
    Networks: { app: { NetworkID: 'net-1', IPAddress: `172.30.0.${Id === a ? 2 : 3}` } },
  },
  ...extras,
});
const fixtures = () => [
  container(a, 'outside-compose', {
    Labels: {
      'com.docker.compose.project': 'existing',
      'com.docker.compose.service': 'web',
      'private.token': 'TOPSECRET',
    },
    Env: ['SECRET=TOPSECRET'],
  }),
  container(b, 'lab-client', {
    Labels: {
      'io.dockertracer.project': 'atelier-01',
      'io.dockertracer.node': 'client',
      'io.dockertracer.role': 'node',
    },
    Status: 'Up 2 minutes (unhealthy)',
  }),
  container(c, 'probe', {
    Labels: { 'io.dockertracer.role': 'capture' },
    HostConfig: { NetworkMode: `container:${b}` },
    NetworkSettings: { Networks: {} },
  }),
];

test('inventaire : inclut les projets externes sans divulguer variables ou labels libres', () => {
  const s = buildInventory(fixtures(), networks, {}, 1234);
  assert.equal(s.observedAt, 1234);
  assert.equal(s.containers.length, 3);
  assert.equal(s.containers.find((c) => c.id === a).project, 'existing');
  assert.equal(s.containers.find((c) => c.id === b).attention, true);
  assert.ok(!JSON.stringify(s).includes('TOPSECRET'));
  assert.equal(s.links.length, 3);
  assert.deepEqual(
    s.links.find((l) => l.kind === 'shared'),
    { id: `shared:${c}`, source: `c:${c}`, target: `c:${b}`, kind: 'shared', ip: '' },
  );
});
test('inventaire : distingue host, none et espace réseau partagé sans inventer de bridge', () => {
  const s = buildInventory(
    [
      container(a, 'no-network', { HostConfig: { NetworkMode: 'none' } }),
      container(b, 'host-mode', {
        HostConfig: { NetworkMode: 'host' },
        NetworkSettings: { Networks: {} },
      }),
      container(c, 'unknown-owner', {
        HostConfig: { NetworkMode: 'container:missing' },
        NetworkSettings: { Networks: {} },
      }),
    ],
    networks,
  );
  assert.equal(s.links.length, 1);
  assert.equal(s.links[0].target, 'n:host');
  assert.equal(s.containers.find((c) => c.id === a).attachments.length, 0);
});
test('inventaire : filtres par IP, projet, état, voisinage et sondes', () => {
  const s = buildInventory(fixtures(), networks);
  assert.equal(inventoryView(s).containers.length, 2);
  assert.equal(inventoryView(s).networks.length, 1);
  assert.equal(inventoryView(s, { showProbes: true }).links.length, 3);
  assert.equal(inventoryView(s, { search: '172.30.0.2' }).containers[0].id, a);
  assert.equal(inventoryView(s, { project: 'compose:existing' }).containers.length, 1);
  assert.equal(inventoryView(s, { state: 'attention' }).containers[0].id, b);
  assert.equal(inventoryView(s, { focus: `c:${a}` }).containers.length, 2);
  assert.equal(inventoryView(s, { showUnused: true }).networks.length, 4);
});
test('inventaire : dispose 1 000 conteneurs sans coordonnées invalides ni perte', () => {
  const containers = Array.from({ length: 1000 }, (_, i) =>
    container(i.toString(16).padStart(64, '0'), `service-${i}`),
  );
  const view = inventoryView(buildInventory(containers, networks));
  const positions = layoutInventory(view);
  assert.equal(positions.size, 1001);
  assert.equal(new Set([...positions.values()].map((p) => `${p.x}:${p.y}`)).size, 1001);
  assert.ok([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});
test('inventaire : coalescence, cache et métriques chargées uniquement à la demande', async () => {
  let time = 0,
    lists = 0,
    stats = 0,
    inspections = 0;
  const fake = {
    listContainers: async () => {
      lists++;
      return fixtures();
    },
    listNetworks: async () => networks,
    info: async () => ({ Name: 'test-engine' }),
    getContainer: () => ({
      inspect: async () => {
        inspections++;
        return {
          Created: 'today',
          State: { Running: true, StartedAt: 'today', ExitCode: 0 },
          RestartCount: 2,
        };
      },
      stats: async () => {
        stats++;
        return {
          cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 100, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 0 },
          memory_stats: { usage: 1024, stats: {} },
          networks: { eth0: { rx_bytes: 5, tx_bytes: 8 } },
        };
      },
    }),
  };
  const service = createInventoryService(fake, () => time);
  const [first, second] = await Promise.all([service.read(), service.read()]);
  assert.equal(first, second);
  assert.equal(lists, 1);
  assert.equal(stats, 0);
  assert.equal(inspections, 0);
  await service.read();
  assert.equal(lists, 1);
  const detail = await service.inspect(a);
  assert.equal(detail.metrics.rx, 5);
  assert.equal(detail.restartCount, 2);
  await service.inspect(a);
  assert.equal(inspections, 1);
  assert.equal(stats, 1);
  time = 5000;
  await service.read();
  assert.equal(lists, 2);
  await assert.rejects(
    () => service.inspect('not-an-id'),
    (e) => e.statusCode === 400,
  );
  await assert.rejects(
    () => service.inspect('f'.repeat(64)),
    (e) => e.statusCode === 404,
  );
});
test('inventaire : une panne ne transforme pas un état périmé en nouvel état frais', async () => {
  let time = 0,
    fail = false;
  const service = createInventoryService(
    {
      listContainers: async () => {
        if (fail) throw Error('offline');
        return [];
      },
      listNetworks: async () => [],
      info: async () => ({}),
    },
    () => time,
  );
  const first = await service.read();
  assert.equal(first.observedAt, 0);
  time = 5000;
  fail = true;
  await assert.rejects(() => service.read(), /offline/);
  time = 6000;
  fail = false;
  assert.equal((await service.read()).observedAt, 6000);
});
