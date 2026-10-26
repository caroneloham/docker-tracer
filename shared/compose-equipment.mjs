import { z } from 'zod';
import { ipv4Range } from './bridge.mjs';
import { composeDocument } from './compose-project.mjs';

export const ROUTER_IMAGE = 'alpine:3.23';
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ipNumber = (ip) => BigInt(ip.split('.').reduce((n, part) => n * 256 + Number(part), 0));

// Only offer bridges whose configuration is known in this Compose document.
// External networks may use another driver and need explicit configuration in YAML.
export function routerNetworks(model) {
  return Object.entries(model.networks || {})
    .filter(
      ([, network]) => !network?.external && (!network?.driver || network.driver === 'bridge'),
    )
    .map(([name, network]) => ({
      name,
      pools: (network?.ipam?.config || []).filter((pool) => ipv4Range(pool.subnet)),
    }));
}

function fixedAddress(model, network, address, pools) {
  if (!z.string().ipv4().safeParse(address).success)
    throw Error(`${network} : indique une adresse IPv4 valide.`);
  const value = ipNumber(address);
  const pool = pools.find((item) => {
    const range = ipv4Range(item.subnet);
    return value > range.start && value < range.end;
  });
  if (!pool)
    throw Error(
      `${network} : l’IP fixe doit appartenir à un sous-réseau IPv4 configuré, hors adresse réseau et broadcast.`,
    );
  const range = ipv4Range(pool.subnet);
  if (
    (pool.gateway ? pool.gateway === address : value === range.start + 1n) ||
    Object.values(pool.aux_addresses || {}).includes(address)
  )
    throw Error(
      `${network} : cette adresse est réservée à la passerelle Docker ou à un autre équipement.`,
    );
  for (const [name, service] of Object.entries(model.services || {}))
    if (service.networks?.[network]?.ipv4_address === address)
      throw Error(`${network} : l’adresse ${address} est déjà déclarée pour ${name}.`);
  return { ipv4_address: address };
}

// Pure draft transformation: no Docker request, host configuration or client route changes.
export function addComposeEquipment(source, kind, options) {
  const name = String(options.name || '').trim();
  if (!namePattern.test(name))
    throw Error(
      'Nom invalide : lettres, chiffres, points, tirets ou underscores, 63 caractères maximum.',
    );
  if (!['switch', 'router', 'volume'].includes(kind)) throw Error('Type d’équipement inconnu.');
  const { doc, model } = composeDocument(source);
  const section = kind === 'switch' ? 'networks' : kind === 'router' ? 'services' : 'volumes';
  if (Object.hasOwn(model[section] || {}, name)) throw Error('Ce nom est déjà utilisé.');
  let value = {};
  if (kind === 'switch') {
    const subnet = String(options.subnet || '').trim();
    if (subnet && !ipv4Range(subnet))
      throw Error(
        'Indique un sous-réseau IPv4 valide, entre /8 et /30, par exemple 172.30.10.0/24.',
      );
    value = {
      driver: 'bridge',
      ...(options.internal ? { internal: true } : {}),
      ...(subnet ? { ipam: { config: [{ subnet }] } } : {}),
    };
  } else if (kind === 'router') {
    if (Object.keys(model.services || {}).length >= 200)
      throw Error('Maximum de 200 services dans cette carte.');
    const connections = options.networks;
    if (
      !connections ||
      Array.isArray(connections) ||
      typeof connections !== 'object' ||
      Object.keys(connections).length < 2
    )
      throw Error('Choisis au moins deux switches (réseaux bridge Docker).');
    const available = new Map(routerNetworks(model).map((network) => [network.name, network]));
    const networks = Object.fromEntries(
      Object.entries(connections).map(([network, address]) => {
        if (!available.has(network))
          throw Error(
            `${network} : choisis un réseau bridge déclaré dans ce Compose, sans option external.`,
          );
        const ip = String(address || '').trim();
        return [network, ip ? fixedAddress(model, network, ip, available.get(network).pools) : {}];
      }),
    );
    value = {
      image: ROUTER_IMAGE,
      pull_policy: 'missing',
      command: ['sleep', 'infinity'],
      restart: 'unless-stopped',
      cap_add: ['NET_ADMIN'],
      sysctls: { 'net.ipv4.ip_forward': '1' },
      networks,
      'x-docker-tracer': { kind: 'router' },
    };
  }
  doc.setIn([section, name], value);
  const next = doc.toString();
  composeDocument(next);
  return {
    source: next,
    id: `${kind === 'switch' ? 'network' : kind === 'router' ? 'service' : 'volume'}:${name}`,
  };
}
