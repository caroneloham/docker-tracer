import {
  containerSettings,
  networkSettings,
  attachedNetworks,
  endpointSettings,
} from './model.mjs';
import { resetBridgeAddresses } from './bridge.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const connections = (t, n) =>
  attachedNetworks(t, n.id)
    .map((net) => ({ id: net.id, ...endpointSettings(t, n.id, net.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
const reasons = {
  image: 'image',
  command: 'démarrage',
  env: 'variables',
  files: 'fichiers applicatifs',
  proxy: 'reverse proxy',
  startup: 'contrôle de démarrage',
  ports: 'ports publiés',
  volume: 'stockage',
  volumes: 'stockage',
  cpus: 'CPU',
  memoryMb: 'mémoire',
  pidsLimit: 'processus',
  restart: 'redémarrage',
  dns: 'DNS',
  label: 'nom',
};

export function planLabChanges(before, next) {
  const changes = [],
    blocked = [];
  for (const node of next.nodes) {
    const old = before.nodes.find((n) => n.id === node.id);
    const network = node.data.kind === 'network';
    if (!old)
      changes.push({
        id: node.id,
        label: node.data.label,
        kind: network ? 'network-add' : 'add',
        reason: network ? 'Nouveau réseau bridge' : 'Nouveau service',
      });
    else if (old.data.kind !== node.data.kind)
      blocked.push(
        `Le type de ${old.data.label} ne peut pas changer : ajoute un nouvel équipement.`,
      );
    else if (network) {
      if (!same(networkSettings(old), networkSettings(node)))
        changes.push({
          id: node.id,
          label: node.data.label,
          kind: 'network-recreate',
          reason: 'Remplacement du bridge et reconnexion de ses services',
        });
    } else {
      const a = containerSettings(old, before),
        b = containerSettings(node, next);
      const fields = Object.keys(b)
        .filter((key) => !same(a[key], b[key]))
        .map((key) => reasons[key] || key);
      if (!same(connections(before, old), connections(next, node)))
        fields.push('interfaces réseau');
      if (fields.length)
        changes.push({
          id: node.id,
          label: node.data.label,
          kind: 'recreate',
          reason: [...new Set(fields)].join(', '),
        });
    }
  }
  for (const old of before.nodes)
    if (!next.nodes.some((n) => n.id === old.id))
      changes.push({
        id: old.id,
        label: old.data.label,
        kind: old.data.kind === 'network' ? 'network-remove' : 'remove',
        reason: 'Retiré du schéma',
      });
  const replacedNetworks = changes.filter((c) => c.kind === 'network-recreate').map((c) => c.id);
  for (const n of next.nodes.filter(
    (n) => n.data.kind === 'container' && before.nodes.some((o) => o.id === n.id),
  )) {
    if (
      [...attachedNetworks(before, n.id), ...attachedNetworks(next, n.id)].some((net) =>
        replacedNetworks.includes(net.id),
      )
    ) {
      const existing = changes.find((c) => c.id === n.id);
      if (existing?.kind === 'recreate') existing.reason += ', bridge remplacé';
      else if (!existing)
        changes.push({
          id: n.id,
          label: n.data.label,
          kind: 'recreate',
          reason: 'Bridge remplacé',
        });
    }
  }
  return {
    changes,
    blocked,
    unchanged: next.nodes.filter(
      (n) => n.data.kind === 'container' && !changes.some((c) => c.id === n.id),
    ).length,
  };
}

export function duplicateDevice(topology, id, newId) {
  const original = topology.nodes.find((n) => n.id === id);
  const node = structuredClone(original);
  node.id = newId;
  const stem = original.data.label.slice(0, 40);
  let suffix = 2;
  do {
    node.data.label = `${stem}-${suffix++}`;
  } while (topology.nodes.some((n) => n.data.label === node.data.label));
  node.position = { x: node.position.x + 100, y: node.position.y + 90 };
  // Avoid conflicting host ports and fixed addresses. Connections are copied with automatic IPs.
  node.data.ports = [];
  if (node.data.kind === 'network') {
    node.data.subnet = '';
    node.data.bridge = resetBridgeAddresses(node.data.bridge);
    if (node.data.bridge.label) node.data.bridge.label = node.data.label;
  }
  const edges =
    node.data.kind === 'container'
      ? topology.edges
          .filter((e) => e.source === id || e.target === id)
          .map((e, i) => ({
            ...e,
            id: `${newId}-link-${i}`,
            source: e.source === id ? newId : e.source,
            target: e.target === id ? newId : e.target,
            ipv4: '',
            aliases: [],
          }))
      : [];
  return { ...topology, nodes: [...topology.nodes, node], edges: [...topology.edges, ...edges] };
}
