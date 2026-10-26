import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeSchema,
  bridgeIpam,
  bridgeDriverOptions,
  cidrOverlap,
  ipv6Range,
  assertBridgeSupport,
  resetBridgeAddresses,
} from '../shared/bridge.mjs';
import {
  initialTopology,
  topologySchema,
  composeObject,
  deploymentSignature,
  usableAddress,
} from '../shared/model.mjs';
import { planLabChanges, duplicateDevice } from '../shared/lab-changes.mjs';
test('bridges : passerelle personnalisée, réservations, IPAM et export Compose concordants', () => {
  const t = initialTopology(),
    net = t.nodes.find((n) => n.id === 'frontend');
  net.data.subnet = '10.249.10.0/24';
  net.data.bridge = bridgeSchema.parse({
    gateway: '10.249.10.254',
    ipRange: '10.249.10.128/25',
    mtu: 1400,
    icc: false,
    masquerade: true,
    ipv6: true,
    ipv6Subnet: 'fd42:ab00::/64',
  });
  t.edges[0].ipv4 = '10.249.10.1';
  assert.ok(topologySchema.safeParse(t).success);
  const compose = composeObject(t).networks.frontend;
  assert.deepEqual(compose.ipam.config, bridgeIpam(net.data));
  assert.deepEqual(compose.driver_opts, bridgeDriverOptions(net.data));
  assert.equal(compose.enable_ipv6, true);
  assert.equal(usableAddress('10.249.10.1', net.data.subnet, net.data.bridge.gateway), true);
  t.edges[0].ipv4 = '10.249.10.254';
  assert.equal(topologySchema.safeParse(t).success, false);
  t.edges[0].ipv4 = '';
  net.data.bridge.ipRange = '10.249.9.0/24';
  assert.equal(topologySchema.safeParse(t).success, false);
  net.data.bridge.ipRange = '';
  net.data.bridge.mtu = 1000;
  assert.equal(topologySchema.safeParse(t).success, false);
});
test('bridges : dessins sans redéploiement et duplication sans plages conflictuelles', () => {
  const t = topologySchema.parse(initialTopology()),
    next = structuredClone(t);
  Object.assign(next.nodes[1].data.bridge, {
    label: 'Réseau public',
    description: 'Site de la maison',
    color: '#2475a7',
  });
  assert.equal(deploymentSignature(t), deploymentSignature(next));
  assert.deepEqual(planLabChanges(t, next).changes, []);
  Object.assign(next.nodes[1].data.bridge, { gateway: '172.23.0.254', ipRange: '172.23.0.128/25' });
  const copy = duplicateDevice(next, 'frontend', 'new-net').nodes.at(-1);
  assert.equal(copy.data.subnet, '');
  assert.equal(copy.data.bridge.gateway, '');
  assert.equal(copy.data.bridge.ipRange, '');
  assert.equal(copy.data.bridge.color, '#2475a7');
  assert.equal(resetBridgeAddresses({ ipv6: true, ipv6Subnet: 'fd42::/64' }).ipv6Subnet, '');
});
test('bridges : anciens serveurs protégés et plages IPv4/IPv6 sans recouvrement', () => {
  const t = initialTopology();
  assert.doesNotThrow(() => assertBridgeSupport(t, {}));
  t.nodes[1].data.bridge.mtu = 1400;
  assert.throws(() => assertBridgeSupport(t, {}), /Redémarre/);
  assert.doesNotThrow(() => assertBridgeSupport(t, { advancedBridges: true }));
  assert.equal(cidrOverlap('10.249.0.0/16', '10.249.5.0/24'), true);
  assert.equal(cidrOverlap('fd42::/48', 'fd42:0:0:1::/64'), true);
  assert.equal(cidrOverlap('fd42::/64', '10.249.0.0/16'), false);
  assert.equal(ipv6Range('fd42::1/64'), null);
  assert.ok(ipv6Range('fd42::/64'));
  t.nodes.find((n) => n.id === 'frontend').data.subnet = '172.23.0.0/16';
  t.nodes.find((n) => n.id === 'backend').data.subnet = '172.23.5.0/24';
  assert.equal(topologySchema.safeParse(t).success, false);
});
