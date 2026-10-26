import test from 'node:test';
import assert from 'node:assert/strict';
import { addComposeEquipment, routerNetworks } from '../shared/compose-equipment.mjs';
import { composeAttention, composeDocument, composeGraph } from '../shared/compose-project.mjs';

const source = `# Infrastructure existante à préserver
x-defaults: &defaults
  image: alpine:3.23
  environment: {LITERAL: '$$unchanged'}
services:
  client:
    <<: *defaults
    command: [sleep, infinity]
    pull_policy: never
    networks:
      front:
        ipv4_address: 172.30.10.10
        aliases: [site]
    x-custom: {kept: true}
  other: *defaults
networks:
  front:
    driver: bridge
    ipam:
      config:
        - subnet: 172.30.10.0/24
          gateway: 172.30.10.1
          aux_addresses: {reserved: 172.30.10.5}
    driver_opts: {custom: retained}
    x-docker-tracer: {label: Site, color: '#2475a7'}
  back:
    driver: bridge
    internal: true
    ipam:
      config:
        - subnet: 172.30.20.0/24
volumes:
  data: {external: true}
secrets:
  password: {file: ./secret.txt}
`;

test('palette Compose : ajouter des équipements conserve les services, ancres, commentaires et réglages réseau existants', () => {
  const original = composeDocument(source).model;
  const bridge = addComposeEquipment(source, 'switch', {
    name: 'management',
    subnet: '172.30.40.0/24',
    internal: true,
  });
  const router = addComposeEquipment(bridge.source, 'router', {
    name: 'routeur',
    networks: { front: '172.30.10.2', back: '172.30.20.2' },
  });
  const volume = addComposeEquipment(router.source, 'volume', { name: 'new_data' });
  const added = composeDocument(volume.source).model;
  for (const name of Object.keys(original.services))
    assert.deepEqual(added.services[name], original.services[name]);
  for (const name of Object.keys(original.networks))
    assert.deepEqual(added.networks[name], original.networks[name]);
  assert.deepEqual(added.volumes.data, original.volumes.data);
  assert.deepEqual(added.secrets, original.secrets);
  assert.deepEqual(added['x-defaults'], original['x-defaults']);
  assert.match(volume.source, /# Infrastructure existante à préserver/);
  assert.match(volume.source, /&defaults/);
  assert.match(volume.source, /\*defaults/);
  assert.equal(added.networks.management.driver, 'bridge');
  assert.equal(added.networks.management.internal, true);
  assert.equal(added.networks.management.ipam.config[0].subnet, '172.30.40.0/24');
});

test('routeur : service réel limité à ses réseaux, avec IPv4 fixe et sans modification des routes clients ou hôte', () => {
  const result = addComposeEquipment(source, 'router', {
    name: 'routeur',
    networks: { front: '172.30.10.2', back: '' },
  });
  const model = composeDocument(result.source).model;
  const router = model.services.routeur;
  assert.equal(result.id, 'service:routeur');
  assert.equal(router.image, 'alpine:3.23');
  assert.equal(router.pull_policy, 'missing');
  assert.deepEqual(router.cap_add, ['NET_ADMIN']);
  assert.deepEqual(router.sysctls, { 'net.ipv4.ip_forward': '1' });
  assert.deepEqual(router.command, ['sleep', 'infinity']);
  assert.deepEqual(router.networks, { front: { ipv4_address: '172.30.10.2' }, back: {} });
  for (const field of ['privileged', 'network_mode', 'ports', 'volumes', 'devices', 'post_start'])
    assert.equal(router[field], undefined);
  assert.deepEqual(model.services.client, composeDocument(source).model.services.client);
  const notes = composeAttention(model, 'existing');
  assert(notes.some((note) => note.includes('NET_ADMIN')));
  assert(notes.some((note) => note.includes('routes aller et retour')));
  const resolved = structuredClone(model);
  delete resolved.services.routeur['x-docker-tracer'];
  const graph = composeGraph(result.source, {}, {}, resolved);
  assert.equal(graph.nodes.find((node) => node.id === result.id).data.icon, 'router');
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.source === result.id)
      .map((edge) => edge.target)
      .sort(),
    ['network:back', 'network:front'],
  );
});

test('switch : attribution automatique par défaut et refus des noms doublons ou sous-réseaux invalides', () => {
  const result = addComposeEquipment(source, 'switch', { name: 'automatic' });
  assert.deepEqual(composeDocument(result.source).model.networks.automatic, { driver: 'bridge' });
  assert.throws(() => addComposeEquipment(source, 'switch', { name: 'front' }), /déjà utilisé/);
  assert.throws(
    () => addComposeEquipment(source, 'switch', { name: 'invalide espace' }),
    /Nom invalide/,
  );
  assert.throws(
    () => addComposeEquipment(source, 'switch', { name: 'new', subnet: '172.30.1.15/24' }),
    /sous-réseau IPv4 valide/,
  );
  assert.throws(
    () =>
      addComposeEquipment(source, 'router', { name: 'client', networks: { front: '', back: '' } }),
    /déjà utilisé/,
  );
});

test('routeur : refuse les adresses réservées, hors plage, dupliquées ou sans IPAM', () => {
  for (const address of [
    'invalid',
    '172.30.99.2',
    '172.30.10.0',
    '172.30.10.255',
    '172.30.10.1',
    '172.30.10.5',
    '172.30.10.10',
  ])
    assert.throws(() =>
      addComposeEquipment(source, 'router', {
        name: 'router',
        networks: { front: address, back: '' },
      }),
    );
  assert.throws(
    () =>
      addComposeEquipment(source, 'router', {
        name: 'router',
        networks: { front: '', back: '172.30.20.1' },
      }),
    /réservée/,
  );
  const automatic = addComposeEquipment(source, 'switch', { name: 'automatic' }).source;
  assert.throws(
    () =>
      addComposeEquipment(automatic, 'router', {
        name: 'router',
        networks: { automatic: '172.30.30.2', back: '' },
      }),
    /sous-réseau IPv4 configuré/,
  );
});

test('routeur : exige deux réseaux bridge déclarés et ne convertit aucun réseau externe ou autre pilote', () => {
  const special = source + 'x-other: unchanged\n';
  assert.throws(
    () => addComposeEquipment(special, 'router', { name: 'router', networks: { front: '' } }),
    /au moins deux/,
  );
  assert.throws(
    () =>
      addComposeEquipment(special, 'router', {
        name: 'router',
        networks: { front: '', missing: '' },
      }),
    /bridge déclaré/,
  );
  const mixed =
    'services: {}\nnetworks:\n  front: {}\n  back: {driver: bridge}\n  ext: {external: true}\n  physical: {driver: macvlan}\n';
  assert.deepEqual(
    routerNetworks(composeDocument(mixed).model).map((network) => network.name),
    ['front', 'back'],
  );
  for (const network of ['ext', 'physical'])
    assert.throws(
      () =>
        addComposeEquipment(mixed, 'router', {
          name: 'router',
          networks: { front: '', [network]: '' },
        }),
      /bridge déclaré/,
    );
});
