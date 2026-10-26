export const tsharkFields = [
  'frame.time_epoch',
  'ip.src',
  'ip.dst',
  'ipv6.src',
  'ipv6.dst',
  'eth.src',
  'eth.dst',
  'frame.len',
  'frame.protocols',
  'tcp.srcport',
  'tcp.dstport',
  'udp.srcport',
  'udp.dstport',
  '_ws.col.Info',
  'arp.src.proto_ipv4',
  'arp.dst.proto_ipv4',
  'ip.ttl',
  'ipv6.hlim',
  'ip.id',
  'tcp.flags',
  'tcp.seq',
  'tcp.ack',
  'tcp.window_size_value',
  'icmp.type',
  'icmp.code',
  'icmp.seq',
  'dns.qry.name',
  'dns.flags.response',
  'http.request.method',
  'http.request.uri',
  'http.response.code',
];
export function parsePacket(line, nodeId, addressMap, sequence) {
  const f = line.replace(/\r$/, '').split('\t');
  if (f.length < 9 || !Number.isFinite(Number(f[0])) || !f[0]) return null;
  const src = f[1] || f[3] || f[14] || f[5],
    dst = f[2] || f[4] || f[15] || f[6];
  if (!src || !dst) return null;
  const stack = f[8] || '';
  const protocol =
    ['http', 'dns', 'arp', 'icmpv6', 'icmp', 'tls', 'tcp', 'udp']
      .find((p) => stack.split(':').includes(p))
      ?.toUpperCase() || 'OTHER';
  const sourceEndpoint = addressMap.get(src),
    targetEndpoint = addressMap.get(dst);
  return {
    id: `p-${sequence}`,
    time: Number(f[0]) * 1000,
    source: src,
    target: dst,
    sourceNode: sourceEndpoint?.nodeId || sourceEndpoint || null,
    targetNode: targetEndpoint?.nodeId || targetEndpoint || null,
    sourceNetwork: sourceEndpoint?.networkId || null,
    targetNetwork: targetEndpoint?.networkId || null,
    captureNode: nodeId,
    protocol,
    bytes: Number(f[7]) || 0,
    sourcePort: f[9] || f[11] || '',
    targetPort: f[10] || f[12] || '',
    info: f[13] || stack,
    layers: {
      ethernet: { source: f[5] || '', target: f[6] || '' },
      network: {
        version: f[1] ? 'IPv4' : f[3] ? 'IPv6' : protocol === 'ARP' ? 'ARP' : '',
        ttl: f[16] || f[17] || '',
        id: f[18] || '',
      },
      transport: {
        flags: f[19] || '',
        sequence: f[20] || '',
        ack: f[21] || '',
        window: f[22] || '',
        icmpType: f[23] || '',
        icmpCode: f[24] || '',
        icmpSequence: f[25] || '',
      },
      application: {
        dnsQuery: f[26] || '',
        dnsResponse: /^(1|true)$/i.test(f[27] || '')
          ? '1'
          : /^(0|false)$/i.test(f[27] || '')
            ? '0'
            : '',
        method: f[28] || '',
        uri: f[29] || '',
        status: f[30] || '',
      },
    },
  };
}
export function packetRoute(topology, packet) {
  // Only highlight a path proven by both endpoints sharing the same bridge.
  // Unknown/external destinations stay in the packet list without an invented path.
  if (!packet.sourceNode || !packet.targetNode || packet.sourceNode === packet.targetNode)
    return [];
  const source = topology.edges.filter(
    (e) => e.source === packet.sourceNode || e.target === packet.sourceNode,
  );
  const target = topology.edges.filter(
    (e) => e.source === packet.targetNode || e.target === packet.targetNode,
  );
  if (packet.sourceNetwork && packet.targetNetwork && packet.sourceNetwork !== packet.targetNetwork)
    return [];
  const candidates = [];
  for (const a of source) {
    const network = a.source === packet.sourceNode ? a.target : a.source;
    if (packet.sourceNetwork && network !== packet.sourceNetwork) continue;
    const b = target.find((e) => e.source === network || e.target === network);
    if (b)
      candidates.push([
        { id: a.id, reverse: a.source !== packet.sourceNode },
        { id: b.id, reverse: b.source === packet.targetNode },
      ]);
  }
  return candidates.length === 1 ? candidates[0] : [];
}
