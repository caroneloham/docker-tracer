import { z } from 'zod';
export const probeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    protocol: z.enum(['ICMP', 'HTTP', 'DNS', 'TCP', 'UDP']),
    count: z.number().int().min(1).max(10).default(3),
    size: z.number().int().min(0).max(1400).default(56),
    ttl: z.number().int().min(1).max(255).default(64),
    port: z.number().int().min(1).max(65535).default(80),
    path: z
      .string()
      .max(1000)
      .regex(/^\/[^\s\r\n]*$/, 'Le chemin HTTP doit commencer par / et ne contenir aucun espace.')
      .default('/'),
    method: z.enum(['GET', 'POST']).default('GET'),
    payload: z.string().max(4096).default(''),
    headers: z.string().max(2000).default(''),
    query: z
      .string()
      .max(253)
      .regex(/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/, 'Nom DNS invalide.')
      .default(''),
  })
  .superRefine((p, ctx) => {
    if (p.source === p.target)
      ctx.addIssue({ code: 'custom', message: 'Choisis deux équipements différents.' });
    if (p.protocol === 'UDP' && !p.payload.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Saisis un message pour envoyer un datagramme UDP.',
      });
    if (
      p.headers
        .split('\n')
        .filter(Boolean)
        .some((h) => !/^[-A-Za-z0-9]+:[^\r\n]*$/.test(h))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Chaque en-tête HTTP doit avoir la forme Nom: valeur.',
      });
  });
export function probeCommand(probe, ip, hostname) {
  const p = probeSchema.parse(probe);
  if (p.protocol === 'ICMP')
    return [
      'ping',
      '-c',
      String(p.count),
      '-W',
      '1',
      '-w',
      '12',
      '-s',
      String(p.size),
      '-t',
      String(p.ttl),
      ip,
    ];
  if (p.protocol === 'DNS') return ['nslookup', p.query || hostname];
  if (p.protocol === 'HTTP')
    return [
      'wget',
      '-T',
      '8',
      '-S',
      '-O',
      '-',
      ...p.headers
        .split('\n')
        .filter(Boolean)
        .flatMap((h) => ['--header', h]),
      ...(p.method === 'POST' ? ['--post-data', p.payload] : []),
      `http://${ip}:${p.port}${p.path}`,
    ];
  if (p.protocol === 'TCP' && !p.payload) return ['nc', '-z', '-v', '-w', '3', ip, String(p.port)];
  // Payload is a positional argument: shell syntax in user data is never evaluated.
  return [
    '/bin/sh',
    '-c',
    p.protocol === 'UDP'
      ? 'printf "%s" "$1" | nc -u -w 2 "$2" "$3"'
      : 'printf "%s" "$1" | nc -w 3 "$2" "$3"',
    'docker-tracer-probe',
    p.payload,
    ip,
    String(p.port),
  ];
}
