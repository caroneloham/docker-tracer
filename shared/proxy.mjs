import { topologySchema } from './model.mjs';
import { proxySchema, configurationFiles } from './configuration.mjs';
export function configureProxy(topology, nodeId, input) {
  const next = structuredClone(topology),
    node = next.nodes.find((n) => n.id === nodeId),
    p = proxySchema.parse(input);
  if (!node) throw Error('Proxy introuvable.');
  node.data.proxy = p;
  if (
    !next.edges.some(
      (e) => [e.source, e.target].includes(nodeId) && [e.source, e.target].includes(p.networkId),
    )
  )
    next.edges.push({
      id: 'e-' + crypto.randomUUID(),
      source: nodeId,
      target: p.networkId,
      type: 'traffic',
      ipv4: '',
      aliases: [],
    });
  topologySchema.parse(next);
  return next;
}
export function detachProxy(topology, nodeId, keepFile = false) {
  const next = structuredClone(topology),
    node = next.nodes.find((n) => n.id === nodeId);
  if (keepFile && node.data.proxy) node.data.files = configurationFiles(next, node);
  node.data.proxy = null;
  topologySchema.parse(next);
  return next;
}
