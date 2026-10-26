import { z } from 'zod';
export const BRIDGE_RESTART_MESSAGE =
  'Redémarre Docker Tracer pour activer les bridges personnalisés. Le serveur encore ouvert utilise une version antérieure.';
export const bridgeSchema = z
  .object({
    label: z.string().max(60).default(''),
    description: z.string().max(140).default(''),
    color: z.union([z.literal(''), z.string().regex(/^#[a-f0-9]{6}$/i)]).default(''),
    gateway: z.union([z.literal(''), z.string().ipv4()]).default(''),
    ipRange: z.string().max(50).default(''),
    mtu: z.number().int().min(576).max(65535).nullable().default(null),
    icc: z.boolean().nullable().default(null),
    masquerade: z.boolean().nullable().default(null),
    ipv6: z.boolean().default(false),
    ipv6Subnet: z.string().max(64).default(''),
  })
  .default(() => ({
    label: '',
    description: '',
    color: '',
    gateway: '',
    ipRange: '',
    mtu: null,
    icc: null,
    masquerade: null,
    ipv6: false,
    ipv6Subnet: '',
  }));
const ip4 = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
export function ipv4Range(cidr, max = 30) {
  const [ip, prefix, extra] = String(cidr).split('/');
  if (
    extra !== undefined ||
    !z.string().ipv4().safeParse(ip).success ||
    !/^\d{1,2}$/.test(prefix || '')
  )
    return null;
  const bits = Number(prefix),
    start = ip4(ip),
    size = 2 ** (32 - bits);
  return bits >= 8 && bits <= max && start % size === 0
    ? { start: BigInt(start), end: BigInt(start + size - 1), family: 4 }
    : null;
}
export function ipv6Range(cidr) {
  const [ip, prefix, extra] = String(cidr).split('/');
  if (
    extra !== undefined ||
    !z.string().ipv6().safeParse(ip).success ||
    ip.includes('.') ||
    !/^\d{1,3}$/.test(prefix || '')
  )
    return null;
  const bits = Number(prefix);
  if (bits < 8 || bits > 112) return null;
  const [left, right] = ip.split('::'),
    a = left ? left.split(':') : [],
    b = right ? right.split(':') : [];
  const parts = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  const start = parts.reduce((n, p) => (n << 16n) + BigInt('0x' + p), 0n),
    size = 1n << BigInt(128 - bits);
  return start % size === 0n ? { start, end: start + size - 1n, family: 6 } : null;
}
export const cidrOverlap = (a, b) => {
  const x = ipv4Range(a, 32) || ipv6Range(a),
    y = ipv4Range(b, 32) || ipv6Range(b);
  return !!x && !!y && x.family === y.family && x.start <= y.end && y.start <= x.end;
};
export function bridgeIssues(data) {
  const b = bridgeSchema.parse(data.bridge),
    subnet = ipv4Range(data.subnet),
    issues = [];
  if (
    b.gateway &&
    (!subnet || BigInt(ip4(b.gateway)) <= subnet.start || BigInt(ip4(b.gateway)) >= subnet.end)
  )
    issues.push('La passerelle doit être une adresse utilisable du sous-réseau IPv4.');
  if (b.ipRange) {
    const range = ipv4Range(b.ipRange, 32);
    if (!subnet || !range || range.start < subnet.start || range.end > subnet.end)
      issues.push('La plage d’attribution doit être un CIDR inclus dans le sous-réseau IPv4.');
  }
  if (b.ipv6Subnet && (!b.ipv6 || !ipv6Range(b.ipv6Subnet)))
    issues.push('Active IPv6 et indique un sous-réseau IPv6 aligné, avec un préfixe de /8 à /112.');
  if (b.ipv6 && b.mtu !== null && b.mtu < 1280)
    issues.push('IPv6 nécessite un MTU d’au moins 1280 octets.');
  return issues;
}
export function bridgeRuntimeSettings(data) {
  const { label, color, description, ...config } = bridgeSchema.parse(data.bridge);
  return config;
}
export function bridgeDriverOptions(data) {
  const b = bridgeSchema.parse(data.bridge),
    options = {};
  for (const [key, value] of [
    ['com.docker.network.driver.mtu', b.mtu],
    ['com.docker.network.bridge.enable_icc', b.icc],
    ['com.docker.network.bridge.enable_ip_masquerade', b.masquerade],
  ])
    if (value !== null) options[key] = String(value);
  return options;
}
export function bridgeIpam(data) {
  const b = bridgeSchema.parse(data.bridge);
  return [
    ...(data.subnet
      ? [
          {
            subnet: data.subnet,
            ...(b.gateway ? { gateway: b.gateway } : {}),
            ...(b.ipRange ? { ip_range: b.ipRange } : {}),
          },
        ]
      : []),
    ...(b.ipv6Subnet ? [{ subnet: b.ipv6Subnet }] : []),
  ];
}
export function assertBridgeSupport(topology, capabilities) {
  const defaults = bridgeSchema.parse(undefined);
  if (
    capabilities?.advancedBridges !== true &&
    topology?.nodes?.some(
      (n) => n.data?.bridge && Object.entries(n.data.bridge).some(([k, v]) => v !== defaults[k]),
    )
  )
    throw Error(BRIDGE_RESTART_MESSAGE);
}
export function resetBridgeAddresses(bridge) {
  return { ...bridgeSchema.parse(bridge), gateway: '', ipRange: '', ipv6Subnet: '' };
}
