import {
  addComposeObject,
  composeDocument,
  composeServiceNetworks,
  connectComposeNetwork,
  patchComposeObject,
} from './compose-project.mjs';
import { z } from 'zod';
import { ipv4Range } from './bridge.mjs';

export const serviceNetworks = composeServiceNetworks;

function editableService(model, name, connecting = true) {
  const service = model.services?.[name];
  if (!service) throw Error(`${name} est absent du fichier principal. Modifie son fichier source.`);
  if (service.extends)
    throw Error(`${name} hérite d’un autre fichier. Vérifie ses réseaux dans le fichier Compose.`);
  if (service.network_mode && !(connecting && service.network_mode === 'none'))
    throw Error(
      `${name} utilise le mode ${service.network_mode}. Change ce mode dans ses réglages Réseaux avant de brancher un câble.`,
    );
  return service;
}

export function composeConnectionTarget(source, first, second) {
  if (first === second) throw Error('Choisis deux équipements différents.');
  const { model } = composeDocument(source);
  const endpoints = [first, second].map((id) => {
    const match = /^(service|network):(.+)$/.exec(id || '');
    if (!match) throw Error('Relie un service à un réseau, ou deux services du même projet.');
    return { kind: match[1], name: match[2] };
  });
  const services = endpoints.filter((item) => item.kind === 'service').map((item) => item.name);
  if (!services.length)
    throw Error(
      'Deux réseaux ne se branchent pas directement. Utilise un routeur relié aux deux réseaux.',
    );
  for (const name of services) editableService(model, name);
  const network = endpoints.find((item) => item.kind === 'network')?.name;
  if (network) assertNetwork(model, network);
  return { services, network };
}

function assertNetwork(model, name) {
  if (typeof name !== 'string' || !name) throw Error('Choisis un réseau.');
  if (name !== 'default' && !Object.hasOwn(model.networks || {}, name))
    throw Error(`${name} est absent du fichier principal. Modifie son fichier source.`);
  const network = model.networks?.[name];
  if (
    ['host', 'null', 'none'].includes(network?.driver) ||
    (network?.external && ['host', 'none'].includes(network.name || name))
  )
    throw Error('Les réseaux host et none se choisissent dans le mode réseau du service.');
}

function validateAddress(model, service, network, field, value, previous) {
  if (!value || value === previous || /\$\{[^}]+\}/.test(value)) return;
  const schema = field === 'ipv4_address' ? z.string().ipv4() : z.string().ipv6();
  if (!schema.safeParse(value).success)
    throw Error(`${service} : adresse ${field === 'ipv4_address' ? 'IPv4' : 'IPv6'} invalide.`);
  for (const [name, other] of Object.entries(model.services || {}))
    if (name !== service && serviceNetworks(other)[network]?.[field] === value)
      throw Error(`${value} est déjà utilisée par ${name} sur ${network}.`);
  if (field !== 'ipv4_address' || model.networks?.[network]?.external) return;
  const pools = (model.networks?.[network]?.ipam?.config || []).filter((pool) =>
    ipv4Range(pool.subnet, 32),
  );
  if (!pools.length)
    throw Error(
      `${network} : configure d’abord une plage IPv4 dans les réglages du réseau pour utiliser une IP fixe.`,
    );
  const number = BigInt(value.split('.').reduce((result, part) => result * 256 + Number(part), 0));
  const pool = pools.find((item) => {
    const range = ipv4Range(item.subnet, 32);
    return number > range.start && number < range.end;
  });
  if (!pool)
    throw Error(
      `${service} : l’IP doit appartenir à une plage du réseau ${network}, hors adresse réseau et broadcast.`,
    );
  const range = ipv4Range(pool.subnet, 32);
  if (
    (pool.gateway ? pool.gateway === value : number === range.start + 1n) ||
    Object.values(pool.aux_addresses || {}).includes(value)
  )
    throw Error(`${value} est réservée sur ${network}. Choisis une autre IP.`);
}

export function connectionNetworkChoices(model, services = []) {
  const memberships = new Map(
    services.map((service) => [service, serviceNetworks(model.services?.[service])]),
  );
  const usesDefault = Object.values(model.services || {}).some((service) =>
    Object.hasOwn(serviceNetworks(service), 'default'),
  );
  return [
    ...new Set([
      ...[...memberships.values()].flatMap((networks) => Object.keys(networks)),
      ...Object.keys(model.networks || {}),
      ...(usesDefault ? ['default'] : []),
    ]),
  ]
    .filter((name) => {
      try {
        assertNetwork(model, name);
        return true;
      } catch {
        return false;
      }
    })
    .map((name) => {
      const usedBy = services.filter((service) => Object.hasOwn(memberships.get(service), name));
      return {
        name,
        usedBy,
        common: services.length > 0 && usedBy.length === services.length,
        implicit: name === 'default' && !Object.hasOwn(model.networks || {}, name),
      };
    })
    .sort(
      (a, b) =>
        Number(b.common) - Number(a.common) ||
        b.usedBy.length - a.usedBy.length ||
        Number(a.implicit) - Number(b.implicit),
    );
}

export function suggestedConnectionNetworkName(model, services = []) {
  const names = new Set([
    'default',
    ...Object.keys(model.networks || {}),
    ...Object.values(model.services || {}).flatMap((service) =>
      Object.keys(serviceNetworks(service)),
    ),
    ...Object.values(model.networks || {})
      .map((network) => network?.name)
      .filter(Boolean),
  ]);
  const base =
    (services.length > 1 ? services.join('-') : `${services[0] || 'liaison'}-reseau`)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+/g, '-')
      .slice(0, 63) || 'liaison';
  let candidate = base,
    suffix = 2;
  while (names.has(candidate)) {
    const ending = `-${suffix++}`;
    candidate = base.slice(0, 63 - ending.length) + ending;
  }
  return candidate;
}

// Only the chosen memberships and three editable settings are changed. Unknown
// Compose options, the other networks and all other services stay intact.
export function applyComposeConnection(
  source,
  { services, network, create = false, disconnect = false, settings = {} },
) {
  let { model } = composeDocument(source);
  if (
    !Array.isArray(services) ||
    !services.length ||
    services.length > 2 ||
    new Set(services).size !== services.length
  )
    throw Error('Sélectionne un ou deux services différents.');
  for (const name of services) editableService(model, name, !disconnect);
  if (create) {
    if (disconnect) throw Error('Impossible de créer et déconnecter un réseau en même temps.');
    // The implicit default network exists even without a top-level declaration.
    if (network === 'default') throw Error('Le réseau default existe déjà. Choisis un autre nom.');
    source = addComposeObject(source, 'networks', network);
    source = patchComposeObject(source, 'networks', network, 'driver', 'bridge');
    model = composeDocument(source).model;
  }
  assertNetwork(model, network);
  for (const name of services) {
    const service = model.services[name];
    if (disconnect) {
      if (!Object.hasOwn(serviceNetworks(service), network))
        throw Error(`${name} n’est pas connecté à ${network}.`);
      source = connectComposeNetwork(source, name, network, false);
      continue;
    }
    let memberships = serviceNetworks(service);
    if (service.network_mode === 'none')
      source = patchComposeObject(source, 'services', name, 'network_mode', undefined);
    const options = { ...(memberships[network] || {}) };
    const fields = settings[name] || {};
    for (const field of ['aliases', 'ipv4_address', 'ipv6_address']) {
      if (!Object.hasOwn(fields, field)) continue;
      const value = fields[field];
      if (field === 'aliases' && !Array.isArray(value))
        throw Error('Les alias doivent former une liste.');
      if (field !== 'aliases') validateAddress(model, name, network, field, value, options[field]);
      if (value === '' || value === undefined || (Array.isArray(value) && !value.length))
        delete options[field];
      else options[field] = value;
    }
    memberships[network] = Object.keys(options).length ? options : null;
    // Make the implicit default explicit when another network is added, so
    // adding a cable never silently removes the previous default connection.
    source = patchComposeObject(source, 'services', name, 'networks', memberships);
    model = composeDocument(source).model;
  }
  return source;
}

export function composeConnectionChanges(beforeSource, afterSource) {
  const before = composeDocument(beforeSource).model;
  const after = composeDocument(afterSource).model;
  const changes = [];
  for (const name of Object.keys(after.networks || {}))
    if (!Object.hasOwn(before.networks || {}, name)) changes.push(`Créer le réseau ${name}`);
  for (const [name, service] of Object.entries(after.services || {})) {
    if (!before.services?.[name]) continue;
    const previous = serviceNetworks(before.services[name]);
    const next = serviceNetworks(service);
    for (const network of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (!Object.hasOwn(previous, network)) changes.push(`Connecter ${name} à ${network}`);
      else if (!Object.hasOwn(next, network)) changes.push(`Déconnecter ${name} de ${network}`);
      else if (JSON.stringify(previous[network] || {}) !== JSON.stringify(next[network] || {}))
        changes.push(`Modifier les options de ${name} sur ${network}`);
    }
    if (before.services[name].network_mode !== service.network_mode)
      changes.push(`${name} : mode réseau ${service.network_mode || 'réseaux Docker'}`);
  }
  return changes;
}
