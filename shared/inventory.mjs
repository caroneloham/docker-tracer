const compare = (a, b) => a.name.localeCompare(b.name);
export function buildInventory(rawContainers, rawNetworks, engine = {}, observedAt = Date.now()) {
  const networks = rawNetworks
    .map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver || 'unknown',
      internal: !!n.Internal,
      scope: n.Scope || 'local',
      subnets: (n.IPAM?.Config || []).map((c) => c.Subnet).filter(Boolean),
    }))
    .sort(compare);
  const byId = new Map(networks.map((n) => [n.id, n]));
  const byName = new Map(networks.map((n) => [n.name, n]));
  const containers = rawContainers
    .map((c) => {
      const labels = c.Labels || {},
        project = labels['com.docker.compose.project'];
      const lab = labels['io.dockertracer.project'];
      const networkMode = c.HostConfig?.NetworkMode || '';
      const attachments = Object.entries(c.NetworkSettings?.Networks || {}).flatMap(
        ([name, endpoint]) => {
          if (name === 'none' || networkMode === 'none') return [];
          let network = byId.get(endpoint.NetworkID) || byName.get(name);
          if (!network) {
            // A container can outlive the network-list snapshot during concurrent Docker changes.
            network = {
              id: endpoint.NetworkID || `name:${name}`,
              name,
              driver: 'unknown',
              subnets: [],
              internal: false,
              scope: 'unknown',
            };
            networks.push(network);
            byId.set(network.id, network);
            byName.set(name, network);
          }
          return [
            {
              networkId: network.id,
              ip: endpoint.IPAddress || '',
              ipv6: endpoint.GlobalIPv6Address || '',
              mac: endpoint.MacAddress || '',
            },
          ];
        },
      );
      if (networkMode === 'host' && !attachments.length && byName.has('host'))
        attachments.push({ networkId: byName.get('host').id, ip: '', ipv6: '', mac: '' });
      const health = /\(unhealthy\)/i.test(c.Status || '')
        ? 'unhealthy'
        : /\(healthy\)/i.test(c.Status || '')
          ? 'healthy'
          : /health: starting/i.test(c.Status || '')
            ? 'starting'
            : '';
      return {
        id: c.Id,
        name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status || '',
        health,
        service: labels['com.docker.compose.service'] || labels['io.dockertracer.node'] || '',
        project: project || (lab ? `Docker Tracer / ${lab}` : 'Sans projet Compose'),
        projectKey: project ? `compose:${project}` : lab ? `dtr:${lab}` : 'ungrouped',
        labId: lab || '',
        isProbe: ['capture', 'observer', 'diagnostic', 'startup', 'backup'].includes(
          labels['io.dockertracer.role'],
        ),
        networkMode,
        attachments,
        ports: (c.Ports || []).map((p) => ({
          hostIp: p.IP || '',
          host: p.PublicPort || null,
          container: p.PrivatePort,
          protocol: p.Type || 'tcp',
        })),
        attention: health === 'unhealthy' || ['dead', 'restarting'].includes(c.State),
      };
    })
    .sort(compare);
  const containerById = new Map(containers.map((c) => [c.id, c]));
  const containerByName = new Map(containers.map((c) => [c.name, c]));
  const links = containers.flatMap((c) => {
    if (c.networkMode.startsWith('container:')) {
      const ref = c.networkMode.slice(10);
      const exact = containerById.get(ref) || containerByName.get(ref);
      const matches = exact ? [exact] : containers.filter((other) => other.id.startsWith(ref));
      return matches.length === 1 && matches[0].id !== c.id
        ? [
            {
              id: `shared:${c.id}`,
              source: `c:${c.id}`,
              target: `c:${matches[0].id}`,
              kind: 'shared',
              ip: '',
            },
          ]
        : [];
    }
    return c.attachments.map((a) => ({
      id: `link:${c.id}:${a.networkId}`,
      source: `c:${c.id}`,
      target: `n:${a.networkId}`,
      kind: 'network',
      ip: a.ip || a.ipv6,
    }));
  });
  return {
    observedAt,
    engine: {
      name: engine.Name || 'Docker local',
      version: engine.ServerVersion || '',
      os: engine.OSType || '',
    },
    containers,
    networks: networks.sort(compare),
    links,
  };
}

export function inventoryView(
  inventory,
  {
    search = '',
    project = 'all',
    state = 'all',
    showProbes = false,
    showUnused = false,
    focus = null,
  } = {},
) {
  if (!inventory) return { containers: [], networks: [], links: [] };
  const networkNames = new Map(inventory.networks.map((n) => [n.id, n.name]));
  const query = search.trim().toLowerCase();
  let containers = inventory.containers.filter(
    (c) =>
      (showProbes || !c.isProbe) &&
      (project === 'all' || c.projectKey === project) &&
      (state === 'all' ||
        (state === 'attention'
          ? c.attention
          : state === 'stopped'
            ? c.state !== 'running'
            : c.state === state)) &&
      (!query ||
        [
          c.name,
          c.service,
          c.image,
          c.project,
          ...c.attachments.flatMap((a) => [a.ip, a.ipv6, networkNames.get(a.networkId)]),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)),
  );
  if (focus) {
    const links = inventory.links.filter((l) => l.source === focus || l.target === focus);
    const neighbours = new Set([focus, ...links.flatMap((l) => [l.source, l.target])]);
    const nets = new Set([...neighbours].filter((id) => id.startsWith('n:')));
    for (const l of inventory.links) if (nets.has(l.target)) neighbours.add(l.source);
    containers = containers.filter((c) => neighbours.has(`c:${c.id}`));
  }
  const visible = new Set(containers.map((c) => `c:${c.id}`));
  const connected = new Set(
    inventory.links
      .filter((l) => visible.has(l.source) && l.kind === 'network')
      .map((l) => l.target.slice(2)),
  );
  const networks = inventory.networks.filter(
    (n) =>
      connected.has(n.id) ||
      (showUnused && !focus && (!query || n.name.toLowerCase().includes(query))),
  );
  networks.forEach((n) => visible.add(`n:${n.id}`));
  return {
    containers,
    networks,
    links: inventory.links.filter((l) => visible.has(l.source) && visible.has(l.target)),
  };
}

// Layout is linear apart from stable sorting. No physics loop runs on every refresh.
export function layoutInventory(view) {
  const nodes = [
    ...view.networks.map((n) => ({ id: `n:${n.id}`, name: n.name, kind: 'network' })),
    ...view.containers.map((c) => ({ id: `c:${c.id}`, name: c.name, kind: 'container' })),
  ];
  const adjacency = new Map(nodes.map((n) => [n.id, []])),
    byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of view.links) {
    adjacency.get(l.source)?.push(l.target);
    adjacency.get(l.target)?.push(l.source);
  }
  const seen = new Set(),
    components = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const component = [],
      queue = [node.id];
    seen.add(node.id);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      component.push(byId.get(id));
      for (const other of adjacency.get(id) || [])
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
    }
    components.push(component);
  }
  const positions = new Map();
  let y = 40;
  for (let i = 0; i < components.length; i += 2) {
    let rowHeight = 0;
    let baseX = 40;
    for (let j = i; j < Math.min(i + 2, components.length); j++) {
      const comp = components[j],
        nets = comp.filter((n) => n.kind === 'network').sort(compare),
        ctrs = comp.filter((n) => n.kind === 'container').sort(compare);
      const width = Math.max(Math.min(nets.length, 4) * 165, Math.min(ctrs.length, 5) * 145),
        netRows = Math.ceil(nets.length / 4);
      nets.forEach((n, k) =>
        positions.set(n.id, {
          x: baseX + Math.max(0, (width - Math.min(nets.length, 4) * 165) / 2) + (k % 4) * 165,
          y: y + Math.floor(k / 4) * 120,
        }),
      );
      ctrs.forEach((n, k) =>
        positions.set(n.id, {
          x: baseX + (k % 5) * 145,
          y: y + netRows * 140 + Math.floor(k / 5) * 115,
        }),
      );
      rowHeight = Math.max(rowHeight, netRows * 140 + Math.ceil(ctrs.length / 5) * 115 + 55);
      baseX += width + 120;
    }
    y += rowHeight;
  }
  return positions;
}
