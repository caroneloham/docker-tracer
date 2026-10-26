import YAML from 'yaml';
import { z } from 'zod';
export const composeName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
export const composeSettings = z.object({
  source: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
  directory: z.string().max(2048).default(''),
  projectName: composeName,
  adopt: z.boolean().default(false),
  useDotEnv: z.boolean().default(false),
  variables: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32000))
    .default({}),
  profiles: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/))
    .max(50)
    .default([]),
  waitSeconds: z.number().int().min(10).max(7200).default(120),
  positions: z
    .record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }))
    .default({}),
});
export const composeRecord = composeSettings.extend({
  lastApplied: composeSettings.nullable().default(null),
  previousApplied: composeSettings.nullable().default(null),
  resolved: z.record(z.string(), z.unknown()).nullable().default(null),
  positions: z
    .record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }))
    .default({}),
});
const serviceView = z
  .object({
    image: z.string().nullish(),
    environment: z
      .union([
        z.array(z.string()),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      ])
      .nullish(),
    ports: z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])).nullish(),
    volumes: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).nullish(),
    networks: z
      .union([
        z.array(z.string()),
        z.record(
          z.string(),
          z
            .object({ aliases: z.array(z.string()).optional() })
            .passthrough()
            .nullable(),
        ),
      ])
      .nullish(),
  })
  .passthrough();
const networkView = z
  .object({
    driver: z.string().nullish(),
    name: z.string().nullish(),
    internal: z.boolean().nullish(),
    enable_ipv6: z.boolean().nullish(),
    ipam: z
      .object({
        config: z
          .array(
            z
              .object({
                subnet: z.string().optional(),
                gateway: z.string().optional(),
                ip_range: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .nullish(),
    driver_opts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullish(),
    'x-docker-tracer': z
      .object({
        label: z.string().max(60).optional(),
        description: z.string().max(140).optional(),
        color: z.string().optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()
  .nullable();
export function composeDocument(source) {
  const doc = YAML.parseDocument(source, { merge: true, uniqueKeys: true });
  if (doc.errors.length) throw Error(doc.errors[0].message);
  const model = doc.toJS({ maxAliasCount: 100 });
  if (!model || typeof model !== 'object' || Array.isArray(model))
    throw Error('Le fichier Compose doit contenir un objet YAML.');
  if (
    (!model.services && !model.include) ||
    (model.services && (typeof model.services !== 'object' || Array.isArray(model.services)))
  )
    throw Error('Ajoute une section services ou include au fichier Compose.');
  if (Object.keys(model.services || {}).length > 200)
    throw Error('Maximum de 200 services dans cette carte.');
  for (const [name, service] of Object.entries(model.services || {})) {
    const checked = serviceView.safeParse(service);
    if (!checked.success)
      throw Error(
        `Service ${name} : ${checked.error.issues.map((i) => i.path.join('.') + ' : ' + i.message).join('; ')}`,
      );
  }
  for (const kind of ['volumes', 'networks'])
    if (model[kind] != null && (typeof model[kind] !== 'object' || Array.isArray(model[kind])))
      throw Error(`${kind} doit être une liste de déclarations nommées.`);
  for (const [name, value] of Object.entries(model.networks || {})) {
    const checked = networkView.safeParse(value);
    if (!checked.success)
      throw Error(
        `Réseau ${name} : ${checked.error.issues.map((i) => i.path.join('.') + ' : ' + i.message).join('; ')}`,
      );
  }
  return { doc, model };
}
export function patchComposeService(source, name, field, value) {
  const { doc, model } = composeDocument(source);
  if (!Object.hasOwn(model.services || {}, name))
    throw Error('Service absent du fichier principal.');
  if (
    ![
      'image',
      'pull_policy',
      'deploy',
      'gpus',
      'environment',
      'ports',
      'volumes',
      'networks',
      'network_mode',
      'restart',
      'healthcheck',
      'cpus',
      'mem_limit',
      'command',
      'labels',
    ].includes(field)
  )
    throw Error('Champ graphique inconnu.');
  const service = doc.getIn(['services', name], true);
  // Changing an alias must affect only the selected service, not the shared anchor.
  let anchored = false;
  YAML.visit(service, (_key, node) => {
    if (YAML.isPair(node) && String(node.key?.value || '').startsWith('x-docker-tracer-original-'))
      return YAML.visit.SKIP;
    if (node?.anchor) anchored = true;
  });
  if (anchored) {
    // Keep the old node at its original position: it can itself refer to earlier
    // anchors. A top-level prepend would create forward aliases and invalid YAML.
    let extension = 'x-docker-tracer-original-' + name;
    while (Object.hasOwn(model.services[name], extension)) extension += '-saved';
    const replacement = doc.createNode(structuredClone(model.services[name]));
    replacement.items.unshift(doc.createPair(extension, service));
    doc.setIn(['services', name], replacement);
  } else if (!YAML.isMap(service))
    doc.setIn(['services', name], doc.createNode(structuredClone(model.services[name])));
  if (value === undefined) doc.deleteIn(['services', name, field]);
  else doc.setIn(['services', name, field], value);
  return doc.toString();
}
export function addComposeObject(source, kind, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) throw Error('Nom invalide.');
  const { doc, model } = composeDocument(source);
  if (!['services', 'networks', 'volumes'].includes(kind) || Object.hasOwn(model[kind] || {}, name))
    throw Error('Ce nom est déjà utilisé.');
  doc.setIn([kind, name], kind === 'services' ? { image: 'nginx:alpine' } : {});
  return doc.toString();
}
export function patchComposeObject(source, kind, name, field, value) {
  if (kind === 'services') return patchComposeService(source, name, field, value);
  if (
    !['networks', 'volumes'].includes(kind) ||
    ![
      'driver',
      'internal',
      'external',
      'name',
      'ipam',
      'driver_opts',
      'labels',
      'enable_ipv6',
      'x-docker-tracer',
    ].includes(field)
  )
    throw Error('Champ graphique inconnu.');
  const { doc, model } = composeDocument(source);
  if (!Object.hasOwn(model[kind] || {}, name)) {
    if (kind !== 'networks' || name !== 'default') throw Error('Ressource introuvable.');
  }
  const object = doc.getIn([kind, name], true);
  let anchored = false;
  YAML.visit(object, (_key, node) => {
    if (node?.anchor) anchored = true;
  });
  if (anchored) {
    let extension = 'x-docker-tracer-original-' + kind + '-' + name;
    while (doc.has(extension)) extension += '-saved';
    doc.contents.items.unshift(doc.createPair(extension, object));
  }
  if (anchored || !YAML.isMap(object))
    doc.setIn([kind, name], doc.createNode(structuredClone(model[kind]?.[name] || {})));
  if (value === undefined) doc.deleteIn([kind, name, field]);
  else doc.setIn([kind, name, field], value);
  return doc.toString();
}
export function composeServiceNetworks(service = {}) {
  if (service.network_mode) return {};
  const names = Array.isArray(service.networks)
    ? Object.fromEntries(service.networks.map((name) => [name, null]))
    : { ...(service.networks || {}) };
  // Compose treats omitted AND empty network declarations as the default network.
  return Object.keys(names).length ? names : { default: null };
}
export function connectComposeNetwork(source, service, network, connected) {
  const { model } = composeDocument(source),
    s = model.services?.[service];
  if (!s) throw Error('Service introuvable.');
  if (s.network_mode)
    throw Error('Retire d’abord le mode réseau spécial dans la configuration du service.');
  const nets = composeServiceNetworks(s);
  if (connected) nets[network] ??= null;
  else delete nets[network];
  if (!Object.keys(nets).length) {
    source = patchComposeService(source, service, 'networks', undefined);
    return patchComposeService(source, service, 'network_mode', 'none');
  }
  return patchComposeService(source, service, 'networks', nets);
}
export function removeComposeObject(source, kind, name) {
  const { doc, model } = composeDocument(source);
  for (const [service, s] of Object.entries(model.services || {})) {
    if (
      kind === 'services' &&
      service !== name &&
      (s.network_mode === 'service:' + name ||
        s.pid === 'service:' + name ||
        s.ipc === 'service:' + name ||
        (Array.isArray(s.depends_on)
          ? s.depends_on.includes(name)
          : Object.hasOwn(s.depends_on || {}, name)))
    )
      throw Error(
        `${service} dépend encore de ${name}. Modifie sa dépendance avant la suppression.`,
      );
    if (kind === 'networks' && Object.hasOwn(composeServiceNetworks(s), name))
      throw Error(`${service} utilise encore ce réseau. Déconnecte-le depuis sa configuration.`);
    if (
      kind === 'volumes' &&
      s.volumes?.some((v) => (typeof v === 'string' ? v.split(':')[0] === name : v.source === name))
    )
      throw Error(
        `${service} utilise encore ce volume. Retire son montage avant de supprimer la déclaration.`,
      );
  }
  if (!doc.deleteIn([kind, name])) throw Error('Ressource introuvable dans le fichier principal.');
  return doc.toString();
}
export function composeGraph(source, positions = {}, runtime = {}, resolved = null) {
  const { model: original } = composeDocument(source),
    model = structuredClone(resolved || original),
    nodes = [],
    edges = [],
    nets = new Set(Object.keys(model.networks || {}));
  model.services ||= {};
  for (const [name, instances] of Object.entries(runtime))
    if (!Object.hasOwn(model.services, name))
      model.services[name] = { image: instances[0]?.image, network_mode: 'unknown' };
  const serviceNames = [
    ...new Set([...Object.keys(original.services || {}), ...Object.keys(model.services)]),
  ];
  const services = serviceNames
    .filter((n) => Object.hasOwn(model.services, n))
    .map((n) => [n, model.services[n]]);
  for (const [name, s] of services) {
    if (!s || typeof s !== 'object') continue;
    if (!s.network_mode)
      for (const network of Object.keys(composeServiceNetworks(s))) nets.add(network);
  }
  let i = 0;
  for (const name of nets) {
    const id = 'network:' + name;
    const config = model.networks?.[name] || {},
      visual = original.networks?.[name]?.['x-docker-tracer'] || {};
    nodes.push({
      id,
      type: 'composeDevice',
      position: positions[id] || { x: 360, y: i++ * 160 },
      data: {
        name,
        kind: 'network',
        displayName: typeof visual.label === 'string' ? visual.label.slice(0, 60) : '',
        color: /^#[a-f0-9]{6}$/i.test(visual.color || '') ? visual.color : '',
        note: typeof visual.description === 'string' ? visual.description.slice(0, 140) : '',
        icon: 'network',
        description: config.external
          ? 'Réseau existant'
          : config.internal
            ? 'Réseau isolé'
            : config.driver && config.driver !== 'bridge'
              ? config.driver
              : 'Réseau bridge',
        subnet: (config.ipam?.config || [])
          .map((p) => p.subnet)
          .filter(Boolean)
          .join(' · '),
      },
    });
  }
  services.forEach(([name, s], index) => {
    s ||= {};
    const id = 'service:' + name,
      instances = runtime[name] || [];
    nodes.push({
      id,
      type: 'composeDevice',
      position: positions[id] || { x: index % 2 ? 660 : 60, y: Math.floor(index / 2) * 150 },
      data: {
        name,
        kind: 'service',
        icon:
          original.services?.[name]?.['x-docker-tracer']?.kind === 'router'
            ? 'router'
            : /redis|mysql|postgres|mariadb/.test(s.image || '')
              ? 'database'
              : /nginx|httpd|wordpress/.test(s.image || '')
                ? 'globe'
                : 'server',
        description: s.image || 'Image à construire',
        instances,
        plannedReplicas:
          Number(original.services?.[name]?.deploy?.replicas ?? original.services?.[name]?.scale) ||
          1,
      },
    });
    if (!s.network_mode)
      for (const nameNet of Object.keys(composeServiceNetworks(s)))
        edges.push({ id: id + '@' + nameNet, source: id, target: 'network:' + nameNet });
  });
  for (const edge of edges) {
    const sourceNode = nodes.find((n) => n.id === edge.source),
      targetNode = nodes.find((n) => n.id === edge.target),
      dx = targetNode.position.x - sourceNode.position.x,
      dy = targetNode.position.y - sourceNode.position.y;
    edge.type = 'composeCable';
    edge.sourceHandle =
      Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
    edge.targetHandle = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[
      edge.sourceHandle
    ];
    edge.data = {
      running: sourceNode.data.instances.some((i) => i.state === 'running'),
      color: targetNode.data.color,
    };
  }
  return { nodes, edges, model };
}
export function composeAttention(model, projectName) {
  const notes = [];
  for (const [name, s] of Object.entries(model.services || {})) {
    if (s.privileged || s.pid === 'host' || s.network_mode === 'host' || s.devices?.length)
      notes.push(
        `${name} demande un accès particulier à l’hôte (privilèges, périphériques ou espace hôte).`,
      );
    if (
      Array.isArray(s.cap_add) &&
      s.cap_add.some((capability) => ['NET_ADMIN', 'CAP_NET_ADMIN', 'ALL'].includes(capability))
    )
      notes.push(`${name} demande le droit NET_ADMIN pour administrer le réseau de son conteneur.`);
    if (s['x-docker-tracer']?.kind === 'router')
      notes.push(
        `${name} est un routeur Linux : les routes aller et retour des clients restent à configurer. Aucune route de l’hôte ou du LAN n’est ajoutée automatiquement.`,
      );
    if (s.build) notes.push(`${name} construit une image à partir de son contexte.`);
    if (s.post_start || s.pre_stop)
      notes.push(`${name} définit des commandes lors du démarrage ou de l’arrêt.`);
    if (s.volumes?.some((v) => typeof v === 'object' && v.type === 'bind'))
      notes.push(`${name} utilise des dossiers du serveur Docker (bind mounts).`);
  }
  for (const [kind, objects] of Object.entries({
    volumes: model.volumes,
    networks: model.networks,
  }))
    for (const [name, v] of Object.entries(objects || {}))
      if (v?.external || (v?.name && v.name !== projectName + '_' + name))
        notes.push(
          `${kind} · ${name} : nom explicite ou ressource externe, conservé tel que déclaré.`,
        );
  return notes;
}
