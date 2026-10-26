import { z } from 'zod';
import { startupSchema } from './startup.mjs';
import {
  bridgeSchema,
  bridgeIssues,
  bridgeRuntimeSettings,
  bridgeDriverOptions,
  bridgeIpam,
  cidrOverlap,
} from './bridge.mjs';
import {
  appFilesSchema,
  proxySchema,
  configurationFiles,
  pathsOverlap,
  textBytes,
  PROJECT_FILE_LIMIT,
  isNginx,
} from './configuration.mjs';

export const LABEL = 'io.dockertracer';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const port = z.object({
  host: z.number().int().min(1).max(65535),
  container: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  hostIp: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
});
const mountPath = z
  .string()
  .max(100)
  .regex(/^\/[a-zA-Z0-9_./-]+$/);
const alias = z
  .string()
  .max(63)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/);
const data = z.object({
  label: identifier,
  kind: z.enum(['container', 'network']),
  icon: z.string().max(30).default('server'),
  image: z.string().max(200).default('alpine:3.23'),
  command: z.string().max(4000).default(''),
  env: z.string().max(8000).default(''),
  files: appFilesSchema,
  proxy: proxySchema.nullable().default(null),
  startup: startupSchema,
  ports: z.array(port).max(12).default([]),
  volume: z.string().max(100).default(''),
  volumes: z
    .array(z.object({ id: identifier, target: mountPath, readOnly: z.boolean().default(false) }))
    .max(8)
    .default([]),
  cpus: z.number().min(0.1).max(64).default(1),
  memoryMb: z.number().int().min(16).max(65536).default(512),
  pidsLimit: z.number().int().min(16).max(65536).default(256),
  restart: z.enum(['no', 'unless-stopped', 'always', 'on-failure']).default('no'),
  dns: z.array(z.string().ipv4()).max(4).default([]),
  subnet: z.string().max(50).default(''),
  internal: z.boolean().default(false),
  bridge: bridgeSchema,
});
export const topologySchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(80),
    nodes: z
      .array(
        z.object({
          id: identifier,
          type: z.literal('device').default('device'),
          position: z.object({ x: z.number().finite(), y: z.number().finite() }),
          data,
        }),
      )
      .max(32),
    edges: z
      .array(
        z.object({
          id: identifier,
          source: identifier,
          target: identifier,
          sourceHandle: z.string().nullable().optional(),
          targetHandle: z.string().nullable().optional(),
          type: z.literal('traffic').default('traffic'),
          ipv4: z.string().max(15).default(''),
          aliases: z.array(alias).max(12).default([]),
        }),
      )
      .max(100),
  })
  .superRefine((t, ctx) => {
    const ids = new Set(),
      names = new Set(),
      links = new Set(),
      edgeIds = new Set(),
      hostPorts = new Set(),
      assignedIps = new Set();
    const fail = (message) => ctx.addIssue({ code: 'custom', message });
    let fileBytes = 0;
    for (const n of t.nodes) {
      if (ids.has(n.id) || names.has(n.data.label))
        fail('Les identifiants et noms des équipements doivent être uniques.');
      ids.add(n.id);
      names.add(n.data.label);
      if (n.data.kind === 'container' && !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(n.data.image))
        fail('Image Docker invalide.');
      if (n.data.subnet && !validCidr(n.data.subnet))
        fail('Sous-réseau IPv4 CIDR invalide (ex. 172.28.0.0/24).');
      if (n.data.kind === 'network')
        for (const issue of bridgeIssues(n.data)) fail(n.data.label + ' : ' + issue);
      if (n.data.volume && !/^\/[a-zA-Z0-9_./-]+$/.test(n.data.volume))
        fail('Le volume doit être un chemin absolu dans le conteneur.');
      for (const p of n.data.ports) {
        const key = `${p.host}/${p.protocol}`;
        if (hostPorts.has(key)) fail(`Le port hôte ${key} est utilisé plusieurs fois.`);
        hostPorts.add(key);
      }
      const envKeys = new Set();
      for (const line of n.data.env
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))) {
        const key = line.slice(0, line.indexOf('='));
        if (!line.includes('=') || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
          fail('Variable invalide : utilise un nom comme PORT et une valeur.');
        if (envKeys.has(key)) fail(`Variable dupliquée : ${key}.`);
        envKeys.add(key);
      }
      const mounts = volumeMounts(n);
      if (n.data.kind === 'network' && (n.data.files.length || n.data.proxy))
        fail('Les fichiers appartiennent à un service.');
      if (n.data.proxy) {
        const p = n.data.proxy,
          target = t.nodes.find((x) => x.id === p.targetId),
          net = t.nodes.find((x) => x.id === p.networkId);
        if (!isNginx(n.data.image))
          fail('L’assistant reverse proxy utilise l’image officielle Nginx.');
        if (
          !target ||
          target.id === n.id ||
          target.data.kind !== 'container' ||
          net?.data.kind !== 'network'
        )
          fail('Choisis un service cible et son réseau pour le proxy.');
        else if (
          ![n.id, target.id].every((id) =>
            t.edges.some(
              (e) => [e.source, e.target].includes(id) && [e.source, e.target].includes(net.id),
            ),
          )
        )
          fail('Le proxy et sa cible doivent rejoindre le réseau choisi.');
      }
      let files = n.data.files;
      try {
        files = configurationFiles(t, n);
      } catch (e) {
        fail(e.message);
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        fileBytes += textBytes(file.content);
        if (files.slice(0, i).some((f) => pathsOverlap(f.path, file.path)))
          fail('Les fichiers doivent avoir des chemins distincts, sans recouvrement.');
        if (mounts.some((m) => pathsOverlap(m.target, file.path)))
          fail('Un fichier applicatif ne peut pas recouvrir un volume de données.');
      }
      if (
        new Set(mounts.map((m) => m.id)).size !== mounts.length ||
        new Set(mounts.map((m) => m.target)).size !== mounts.length
      )
        fail('Les volumes doivent avoir des identifiants et chemins distincts.');
    }
    if (fileBytes > PROJECT_FILE_LIMIT)
      fail('Maximum de 1 Mio de fichiers applicatifs par projet.');
    for (const start of t.nodes) {
      const visited = new Set([start.id]);
      let next = start;
      while (next?.data.proxy) {
        next = t.nodes.find((n) => n.id === next.data.proxy.targetId);
        if (!next) break;
        if (visited.has(next.id)) {
          fail('Une boucle de reverse proxies n’est pas autorisée.');
          break;
        }
        visited.add(next.id);
      }
    }
    for (const e of t.edges) {
      const a = t.nodes.find((n) => n.id === e.source),
        b = t.nodes.find((n) => n.id === e.target);
      if (!a || !b || a.data.kind === b.data.kind) fail('Relie un conteneur à un réseau.');
      if (e.ipv4) {
        const net = a?.data.kind === 'network' ? a : b;
        if (!net?.data.subnet || !usableAddress(e.ipv4, net.data.subnet, net.data.bridge?.gateway))
          fail(
            `L’adresse ${e.ipv4} doit appartenir au sous-réseau configuré, hors adresse réseau, passerelle et broadcast.`,
          );
        const addressKey = `${net?.id}:${e.ipv4}`;
        if (assignedIps.has(addressKey)) fail(`Adresse IP dupliquée sur ce réseau : ${e.ipv4}.`);
        assignedIps.add(addressKey);
      }
      const key = [e.source, e.target].sort().join(':');
      if (links.has(key) || edgeIds.has(e.id)) fail('Connexion dupliquée.');
      links.add(key);
      edgeIds.add(e.id);
    }
    const networks = t.nodes.filter((n) => n.data.kind === 'network');
    for (let i = 0; i < networks.length; i++)
      for (let j = 0; j < i; j++)
        if (
          bridgeIpam(networks[i].data).some((a) =>
            bridgeIpam(networks[j].data).some((b) => cidrOverlap(a.subnet, b.subnet)),
          )
        )
          fail(
            `Les plages de ${networks[i].data.label} et ${networks[j].data.label} se recouvrent.`,
          );
  });
function validCidr(value) {
  const [ip, bits] = value.split('/');
  const parts = ip?.split('.');
  return (
    parts?.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) &&
    /^\d{1,2}$/.test(bits || '') &&
    Number(bits) >= 8 &&
    Number(bits) <= 30 &&
    ipNumber(ip) % 2 ** (32 - Number(bits)) === 0
  );
}
const ipNumber = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
export function usableAddress(ip, cidr, gateway = '') {
  if (
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ||
    ip.split('.').some((p) => Number(p) > 255 || String(Number(p)) !== p) ||
    !validCidr(cidr)
  )
    return false;
  const [base, bits] = cidr.split('/'),
    offset = ipNumber(ip) - ipNumber(base);
  return (
    offset > 0 &&
    offset < 2 ** (32 - Number(bits)) - 1 &&
    ipNumber(ip) !== (gateway ? ipNumber(gateway) : ipNumber(base) + 1)
  );
}
export const volumeMounts = (n) => [
  ...(n.data.volume ? [{ id: 'data', target: n.data.volume, readOnly: false }] : []),
  ...(n.data.volumes || []),
];
export function endpointSettings(t, nodeId, networkId) {
  const node = t.nodes.find((n) => n.id === nodeId);
  const edge = t.edges.find(
    (e) => [e.source, e.target].includes(nodeId) && [e.source, e.target].includes(networkId),
  );
  return {
    Aliases: [...new Set([node.data.label, ...(edge?.aliases || [])])],
    ...(edge?.ipv4 ? { IPAMConfig: { IPv4Address: edge.ipv4 } } : {}),
  };
}
export function containerSettings(n, t) {
  const { icon, subnet, internal, bridge, ...settings } = data.parse(n.data);
  return { ...settings, files: t ? configurationFiles(t, n) : settings.files };
}
export function networkSettings(n) {
  return {
    subnet: n.data.subnet,
    internal: n.data.internal,
    bridge: bridgeRuntimeSettings(n.data),
  };
}
export const attachedNetworks = (t, id) =>
  t.edges
    .filter((e) => e.source === id || e.target === id)
    .map((e) => t.nodes.find((n) => n.id === (e.source === id ? e.target : e.source)))
    .filter((n) => n?.data.kind === 'network');
export const deploymentSignature = (t) => {
  t = topologySchema.parse(t);
  return JSON.stringify({
    id: t.id,
    nodes: t.nodes
      .map((n) => ({
        id: n.id,
        data: n.data.kind === 'container' ? containerSettings(n, t) : networkSettings(n),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: t.edges
      .map((e) => ({
        key: [e.source, e.target].sort().join(':'),
        ipv4: e.ipv4,
        aliases: [...e.aliases].sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
};
export function composeObject(t) {
  t = topologySchema.parse(t);
  return {
    name: `dtr-${t.id}`,
    services: Object.fromEntries(
      t.nodes
        .filter((n) => n.data.kind === 'container')
        .map((n) => {
          const d = n.data;
          const env = Object.fromEntries(
            d.env
              .split('\n')
              .filter((l) => l.includes('='))
              .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
          );
          const nets = attachedNetworks(t, n.id);
          const files = configurationFiles(t, n);
          return [
            d.label,
            {
              image: d.image,
              cpus: d.cpus,
              mem_limit: `${d.memoryMb}m`,
              pids_limit: d.pidsLimit,
              restart: d.restart,
              ...(d.startup.mode !== 'none'
                ? {
                    'x-docker-tracer-startup': {
                      ...d.startup,
                      path: d.startup.path.replaceAll('$', () => '$$'),
                    },
                  }
                : {}),
              ...(d.dns.length ? { dns: d.dns } : {}),
              ...(files.length
                ? {
                    configs: files.map((f, i) => ({ source: n.id + '-file-' + i, target: f.path })),
                  }
                : {}),
              ...(d.command ? { command: ['/bin/sh', '-lc', d.command] } : {}),
              ...(Object.keys(env).length ? { environment: env } : {}),
              ...(d.ports.length
                ? {
                    ports: d.ports.map(
                      (p) =>
                        `${p.hostIp}:${p.host}:${p.container}${p.protocol === 'udp' ? '/udp' : ''}`,
                    ),
                  }
                : {}),
              ...(volumeMounts(n).length
                ? {
                    volumes: volumeMounts(n).map(
                      (m) => `${n.id}-${m.id}:${m.target}${m.readOnly ? ':ro' : ''}`,
                    ),
                  }
                : {}),
              ...(nets.length
                ? {
                    networks: Object.fromEntries(
                      nets.map((net) => {
                        const config = endpointSettings(t, n.id, net.id);
                        return [
                          net.data.label,
                          {
                            aliases: config.Aliases,
                            ...(config.IPAMConfig
                              ? { ipv4_address: config.IPAMConfig.IPv4Address }
                              : {}),
                          },
                        ];
                      }),
                    ),
                  }
                : { network_mode: 'none' }),
            },
          ];
        }),
    ),
    ...(t.nodes.some((n) => configurationFiles(t, n).length)
      ? {
          configs: Object.fromEntries(
            t.nodes.flatMap((n) =>
              configurationFiles(t, n).map((f, i) => [
                n.id + '-file-' + i,
                { content: f.content.replaceAll('$', () => '$$') },
              ]),
            ),
          ),
        }
      : {}),
    networks: Object.fromEntries(
      t.nodes
        .filter((n) => n.data.kind === 'network')
        .map((n) => [
          n.data.label,
          {
            driver: 'bridge',
            internal: n.data.internal,
            ...(bridgeIpam(n.data).length ? { ipam: { config: bridgeIpam(n.data) } } : {}),
            ...(n.data.bridge.ipv6 ? { enable_ipv6: true } : {}),
            ...(Object.keys(bridgeDriverOptions(n.data)).length
              ? { driver_opts: bridgeDriverOptions(n.data) }
              : {}),
            'x-docker-tracer': {
              label: n.data.bridge.label,
              description: n.data.bridge.description,
              color: n.data.bridge.color,
            },
          },
        ]),
    ),
    volumes: Object.fromEntries(
      t.nodes.flatMap((n) => volumeMounts(n).map((m) => [`${n.id}-${m.id}`, {}])),
    ),
  };
}
export const templates = [
  {
    key: 'client',
    label: 'Client Linux',
    description: 'Ping, DNS et requêtes HTTP',
    icon: 'terminal',
    kind: 'container',
    image: 'alpine:3.23',
    command: 'sleep infinity',
  },
  {
    key: 'nginx',
    label: 'Serveur web',
    description: 'Nginx · HTTP',
    icon: 'globe',
    kind: 'container',
    image: 'nginx:alpine',
    command: '',
  },
  {
    key: 'redis',
    label: 'Base Redis',
    description: 'Cache et stockage',
    icon: 'database',
    kind: 'container',
    image: 'redis:7-alpine',
    command: '',
    volume: '/data',
  },
  {
    key: 'custom',
    label: 'Conteneur',
    description: 'Ton image Docker',
    icon: 'server',
    kind: 'container',
    image: 'alpine:3.23',
    command: 'sleep infinity',
  },
  {
    key: 'network',
    label: 'Réseau bridge',
    description: 'Relier les équipements',
    icon: 'network',
    kind: 'network',
    image: '',
    command: '',
  },
];
export function newNode(key, id, position, label) {
  const t = templates.find((t) => t.key === key) || templates[0];
  return {
    id,
    type: 'device',
    position,
    data: data.parse({
      label: label || `${key}-${id.slice(-4)}`,
      kind: t.kind,
      icon: t.icon,
      image: t.image,
      ...(key === 'nginx' ? { startup: { mode: 'running' } } : {}),
      command: t.command,
      volume: t.volume || '',
      env: '',
      ports: [],
      subnet: '',
      internal: false,
    }),
  };
}
export function initialTopology() {
  return {
    id: 'atelier-01',
    name: 'Mon premier réseau',
    nodes: [
      newNode('client', 'client', { x: 20, y: 20 }, 'client'),
      newNode('network', 'frontend', { x: 275, y: 20 }, 'frontend'),
      newNode('nginx', 'web', { x: 530, y: 20 }, 'web'),
      newNode('client', 'worker', { x: 530, y: 235 }, 'worker'),
      newNode('network', 'backend', { x: 275, y: 235 }, 'backend'),
      newNode('redis', 'redis', { x: 20, y: 235 }, 'redis'),
    ],
    edges: [
      ['client', 'frontend'],
      ['web', 'frontend'],
      ['worker', 'frontend'],
      ['worker', 'backend'],
      ['redis', 'backend'],
    ].map(([source, target], i) => ({
      id: `link-${i}`,
      source,
      target,
      sourceHandle: source === 'web' || source === 'worker' ? 'left' : 'right',
      targetHandle: source === 'web' || source === 'worker' ? 'right' : 'left',
      type: 'traffic',
    })),
  };
}
