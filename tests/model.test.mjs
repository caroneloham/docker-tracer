import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialTopology,
  topologySchema,
  composeObject,
  deploymentSignature,
  newNode,
} from '../shared/model.mjs';
import { parsePacket, packetRoute } from '../server/packets.mjs';

test('un conteneur avec deux connexions rejoint les deux réseaux dans Compose', () => {
  const t = topologySchema.parse(initialTopology()),
    compose = composeObject(t);
  assert.deepEqual(compose.services.worker.networks, {
    frontend: { aliases: ['worker'] },
    backend: { aliases: ['worker'] },
  });
  assert.deepEqual(compose.services.redis.networks, { backend: { aliases: ['redis'] } });
  assert.deepEqual(compose.services.redis.volumes, ['redis-data:/data']);
});
test('un conteneur isolé ne rejoint pas implicitement le réseau par défaut', () => {
  const t = initialTopology();
  t.edges = [];
  assert.equal(composeObject(t).services.client.network_mode, 'none');
});
test('le schéma refuse une connexion conteneur-conteneur et les doublons', () => {
  const t = initialTopology();
  t.edges.push({ id: 'invalid', source: 'client', target: 'web', type: 'traffic' });
  assert.equal(topologySchema.safeParse(t).success, false);
  t.edges.pop();
  t.edges.push({ ...t.edges[0], id: 'duplicate' });
  assert.equal(topologySchema.safeParse(t).success, false);
});
test('validation des ports publiés et sous-réseaux avant tout appel Docker', () => {
  const t = initialTopology();
  t.nodes[0].data.ports = [{ host: 8080, container: 80 }];
  t.nodes[2].data.ports = [{ host: 8080, container: 80 }];
  assert.equal(topologySchema.safeParse(t).success, false);
  t.nodes[2].data.ports = [];
  t.nodes[1].data.subnet = '999.28.0.0/24';
  assert.equal(topologySchema.safeParse(t).success, false);
  t.nodes[1].data.subnet = '172.28.0.0/24';
  assert.equal(topologySchema.safeParse(t).success, true);
});
test('les positions restent modifiables sans modifier le déploiement', () => {
  const a = initialTopology(),
    b = structuredClone(a);
  b.nodes[0].position.x += 100;
  b.name = 'Nouveau nom';
  assert.equal(deploymentSignature(a), deploymentSignature(b));
  b.nodes[0].data.image = 'nginx:alpine';
  assert.notEqual(deploymentSignature(a), deploymentSignature(b));
});
test('un port exporté est limité à la boucle locale', () => {
  const t = initialTopology();
  t.nodes[2].data.ports = [{ host: 8080, container: 80 }];
  assert.deepEqual(composeObject(t).services.web.ports, ['127.0.0.1:8080:80']);
});
test('un paquet ICMP capturé associe les vraies IP aux équipements', () => {
  const map = new Map([
    ['172.28.0.2', 'client'],
    ['172.28.0.3', 'web'],
  ]);
  const p = parsePacket(
    [
      '1788711000.123456',
      '172.28.0.2',
      '172.28.0.3',
      '',
      '',
      '',
      '',
      '98',
      'eth:ethertype:ip:icmp',
      '',
      '',
      '',
      '',
      'Echo (ping) request',
      '',
      '',
    ].join('\t'),
    'client',
    map,
    1,
  );
  assert.equal(p.protocol, 'ICMP');
  assert.equal(p.sourceNode, 'client');
  assert.equal(p.targetNode, 'web');
  assert.equal(p.bytes, 98);
  assert.deepEqual(packetRoute(initialTopology(), p), [
    { id: 'link-0', reverse: false },
    { id: 'link-1', reverse: true },
  ]);
});
test('aucun trajet n’est inventé entre deux réseaux isolés ou une IP externe', () => {
  const t = initialTopology();
  assert.deepEqual(packetRoute(t, { sourceNode: 'client', targetNode: 'redis' }), []);
  assert.deepEqual(packetRoute(t, { sourceNode: 'client', targetNode: null }), []);
});
test('les messages de diagnostic tshark ne deviennent pas de faux paquets', () => {
  assert.equal(parsePacket('Capturing on any', 'client', new Map(), 1), null);
  assert.equal(parsePacket('1 packet captured', 'client', new Map(), 2), null);
});
test('deux conteneurs multiréseaux sont animés sur le réseau identifié par leurs IP', () => {
  const t = initialTopology();
  t.edges.push({ id: 'client-back', source: 'client', target: 'backend', type: 'traffic' });
  assert.deepEqual(packetRoute(t, { sourceNode: 'client', targetNode: 'worker' }), []);
  assert.deepEqual(
    packetRoute(t, {
      sourceNode: 'client',
      targetNode: 'worker',
      sourceNetwork: 'backend',
      targetNetwork: 'backend',
    }),
    [
      { id: 'client-back', reverse: false },
      { id: 'link-3', reverse: true },
    ],
  );
});
test('IPv6 et ARP sont identifiés même sans champs IPv4', () => {
  const ipv6 = [
    '1788711000.1',
    '',
    '',
    'fe80::1',
    'fe80::2',
    '',
    '',
    '86',
    'eth:ethertype:ipv6:icmpv6',
    '',
    '',
    '',
    '',
    'Neighbor solicitation',
  ];
  assert.equal(parsePacket(ipv6.join('\t'), 'client', new Map(), 3).protocol, 'ICMPV6');
  const arp = [
    '1788711000.2',
    '',
    '',
    '',
    '',
    'aa:bb',
    'ff:ff',
    '42',
    'eth:ethertype:arp',
    '',
    '',
    '',
    '',
    'Who has 172.28.0.3?',
    '172.28.0.2',
    '172.28.0.3',
  ];
  assert.equal(parsePacket(arp.join('\t'), 'client', new Map(), 4).source, '172.28.0.2');
});
