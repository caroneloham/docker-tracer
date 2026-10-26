import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, composeGraph, patchComposeObject } from '../shared/compose-project.mjs';
test('réseaux : personnalisation visuelle, plages multiples et options inconnues conservées', () => {
  let source =
    'services:\n  web:\n    image: nginx:alpine\n    networks: [front]\nnetworks:\n  front:\n    driver: bridge\n    ipam:\n      config:\n        - subnet: 10.52.0.0/24\n          aux_addresses: {reserve: 10.52.0.5}\n        - subnet: fd25:abcd::/64\n    driver_opts: {custom: retained}\n';
  source = patchComposeObject(source, 'networks', 'front', 'x-docker-tracer', {
    label: 'Site public',
    color: '#2475a7',
    description: 'Réseau du site',
  });
  source = patchComposeObject(source, 'networks', 'front', 'enable_ipv6', true);
  const value = composeDocument(source).model.networks.front;
  assert.equal(value.ipam.config.length, 2);
  assert.equal(value.ipam.config[0].aux_addresses.reserve, '10.52.0.5');
  assert.equal(value.driver_opts.custom, 'retained');
  assert.equal(value.enable_ipv6, true);
  const graph = composeGraph(source),
    n = graph.nodes.find((n) => n.id === 'network:front');
  assert.equal(n.data.displayName, 'Site public');
  assert.equal(graph.edges[0].data.color, '#2475a7');
  assert.equal(n.data.subnet, '10.52.0.0/24 · fd25:abcd::/64');
  assert.throws(
    () => composeDocument(source.replace('config:\n', 'config: nope\n#')),
    /Réseau|YAML|mapping|Map/,
  );
});
test('réseaux : modifier un réseau ancré ne modifie pas ses copies', () => {
  const source =
    'services: {}\nnetworks:\n  a: &net\n    driver: bridge\n    internal: true\n  b: *net\n';
  const changed = composeDocument(
    patchComposeObject(source, 'networks', 'a', 'internal', false),
  ).model;
  assert.equal(changed.networks.a.internal, false);
  assert.equal(changed.networks.b.internal, true);
});
