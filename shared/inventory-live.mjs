export const OBSERVATION_MOTION_MS = 1700;
export const MAX_MOVING_ENVELOPES = 24;

// Markers use one column per protocol and one row per direction. Packet counters
// and arrival order do not change their positions or which evidence they open.
export function observationLanes(flows) {
  const pairs = new Map();
  const lanes = new Map();
  for (const flow of flows) {
    const key = JSON.stringify([flow.source, flow.target].sort());
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(flow);
  }
  for (const pair of pairs.values()) {
    const protocols = [
      ...new Set(pair.map((flow) => flow.packet?.protocol || flow.protocol || 'OTHER')),
    ].sort();
    for (const flow of pair)
      lanes.set(flow.key, {
        column:
          protocols.indexOf(flow.packet?.protocol || flow.protocol || 'OTHER') -
          (protocols.length - 1) / 2,
        direction: flow.source < flow.target ? 1 : -1,
      });
  }
  return lanes;
}

export function observationEdgePath(
  { sourceX, sourceY, targetX, targetY },
  lane = { column: 0, direction: 1 },
) {
  const dx = (targetX - sourceX) * lane.direction;
  const dy = (targetY - sourceY) * lane.direction;
  // An upright grid keeps all labels legible, including diagonal connections.
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const labelX = midX + (horizontal ? lane.column * 78 : lane.direction * 48);
  const labelY = midY + (horizontal ? lane.direction * 42 : lane.column * 50);
  const controlX = 2 * labelX - midX;
  const controlY = 2 * labelY - midY;
  return [
    `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`,
    labelX,
    labelY,
  ];
}

// Ephemeral client ports must not stack hundreds of identical paths. Counts
// combine connections only within one capture; overlapping sessions never add up.
export function groupedInventoryObservations(captures = [], limit = 150) {
  const latest = new Map();
  for (const capture of captures) {
    const groups = new Map();
    for (const flow of capture.flows || []) {
      if (!flow.source || !flow.target || flow.source === flow.target) continue;
      const key = JSON.stringify([
        flow.source,
        flow.target,
        flow.protocol || flow.packet?.protocol,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = {
          ...flow,
          key,
          count: 0,
          bytes: 0,
          connections: 0,
          captureId: capture.id,
          captureStatus: capture.status,
          live: capture.status === 'running',
        };
        groups.set(key, group);
      }
      group.count += flow.count || 0;
      group.bytes += flow.bytes || 0;
      group.connections++;
      group.firstAt = Math.min(group.firstAt || Infinity, flow.firstAt || Infinity);
      if ((flow.lastAt || 0) >= (group.lastAt || 0)) {
        group.lastAt = flow.lastAt;
        group.packet = flow.packet;
      }
    }
    for (const group of groups.values()) {
      const old = latest.get(group.key);
      if (!old || (group.lastAt || 0) > (old.lastAt || 0)) latest.set(group.key, group);
    }
  }
  return [...latest.values()].sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0)).slice(-limit);
}

// The cursor follows evidence, not renders. Reconnection, filtering and unchanged
// inventory refreshes must not manufacture another arrival for the same packet.
export function advanceObservationActivity(previous, flows, now, connected = true) {
  const seen = new Map();
  const bursts = new Map();
  const current = new Map(flows.map((flow) => [flow.key, flow]));
  if (connected)
    for (const burst of previous?.bursts || []) {
      const flow = current.get(burst.key);
      if (burst.expiresAt > now && flow?.live && flow.captureId === burst.captureId)
        bursts.set(burst.key, burst);
    }
  for (const flow of flows) {
    const cursor = `${flow.captureId}:${flow.key}`;
    const old = previous?.seen?.get(cursor);
    const packet = flow.packet;
    const count = Number(flow.count) || 0;
    seen.set(cursor, old && old.count > count ? old : { packetId: packet?.id, count });
    const age = now - packet?.time;
    if (
      !connected ||
      !flow.live ||
      !packet?.id ||
      !Number.isFinite(age) ||
      age < -1000 ||
      age > 4000 ||
      count <= (old?.count || 0) ||
      old?.packetId === packet.id
    )
      continue;
    bursts.set(flow.key, {
      key: flow.key,
      captureId: flow.captureId,
      id: `${flow.captureId}:${packet.id}`,
      // Without a previous counter, only the supplied packet is proven recent.
      count: old ? count - old.count : 1,
      packet,
      arrivedAt: now,
      expiresAt: now + OBSERVATION_MOTION_MS,
    });
  }
  return {
    seen,
    bursts: [...bursts.values()]
      .sort((a, b) => a.arrivedAt - b.arrivedAt)
      .slice(-MAX_MOVING_ENVELOPES),
  };
}

export function captureSelection(containers = [], ids = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length || unique.length > 2)
    return { targets: [], error: 'Choisis un ou deux conteneurs.' };
  const targets = unique.map((id) => containers.find((container) => container.id === id));
  if (targets.some((container) => !container))
    return { targets: [], error: 'Un conteneur a disparu. Actualise la sélection.' };
  if (
    targets.some(
      (container) => container.isProbe || container.stale || container.state !== 'running',
    )
  )
    return { targets: [], error: 'La capture demande des conteneurs en marche et un état à jour.' };
  if (new Set(targets.map((container) => container.hostId || 'local')).size !== 1)
    return { targets: [], error: 'Les deux conteneurs doivent être sur le même serveur.' };
  return { targets, error: '' };
}

export function captureCoversTargets(capture, targets) {
  return (
    capture.status === 'running' &&
    targets.length > 0 &&
    targets.every((container) =>
      capture.targets?.some(
        (target) =>
          target.hostId === (container.hostId || 'local') &&
          target.containerId === (container.dockerId || container.id),
      ),
    )
  );
}

export function captureObservationSummary(captures = [], visibleIds = []) {
  const visible = new Set(visibleIds);
  const flows = groupedInventoryObservations(captures);
  const mapped = flows.filter((flow) => visible.has(flow.source) && visible.has(flow.target));
  const sessions = captures.filter((capture) => capture.status === 'running');
  const relevant = sessions.length ? sessions : captures.slice(0, 1);
  return {
    sessions,
    flows,
    mapped,
    hidden: flows.length - mapped.length,
    packets: relevant.reduce((total, capture) => total + (capture.count || 0), 0),
    unresolved: relevant.reduce(
      (total, capture) =>
        total +
        (capture.flows || [])
          .filter((flow) => !flow.source || !flow.target || flow.source === flow.target)
          .reduce((sum, flow) => sum + (flow.count || 0), 0),
      0,
    ),
    warnings: [
      ...new Set(
        relevant.flatMap((capture) => [
          ...(capture.errors || []),
          ...(capture.truncated
            ? ['Détails limités : consulte la capture et le PCAP disponibles.']
            : []),
        ]),
      ),
    ],
  };
}
