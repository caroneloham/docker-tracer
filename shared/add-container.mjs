import { z } from 'zod';
import { composeDocument } from './compose-project.mjs';
import { imageReference } from './image-catalog.mjs';

export function suggestedServiceName(image) {
  return (
    String(image)
      .split('@')[0]
      .split('/')
      .at(-1)
      .split(':')[0]
      .replace(/[^a-zA-Z0-9_.-]/g, '-')
      .replace(/^[^a-zA-Z0-9]+/, '')
      .slice(0, 63) || 'service'
  );
}

export const addContainerSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'Nom de service invalide.'),
    image: z.string().transform((value, ctx) => {
      try {
        return imageReference(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: error.message });
        return z.NEVER;
      }
    }),
    containerPort: z.union([z.literal(''), z.coerce.number().int().min(1).max(65535)]).default(''),
    hostPort: z.union([z.literal(''), z.coerce.number().int().min(1).max(65535)]).default(''),
    bind: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    network: z
      .string()
      .max(255)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value), 'Nom de réseau invalide.')
      .default(''),
    networkKey: z.string().max(255).default(''),
    environment: z.string().max(32000).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.hostPort && !v.containerPort)
      ctx.addIssue({ code: 'custom', message: 'Indique aussi le port interne.' });
    if (v.network && v.networkKey)
      ctx.addIssue({ code: 'custom', message: 'Choisis un seul réseau.' });
  });

export function addContainerToCompose(source, input) {
  const v = addContainerSchema.parse(input),
    { doc, model } = composeDocument(source);
  if (model.services && Object.hasOwn(model.services, v.name))
    throw Error('Ce nom de service existe déjà.');
  if (Object.keys(model.services || {}).length >= 200) throw Error('Maximum de 200 services.');
  const service = { image: v.image, pull_policy: 'missing', restart: 'unless-stopped' };
  if (v.containerPort)
    service.ports = [
      {
        target: v.containerPort,
        ...(v.hostPort ? { published: String(v.hostPort) } : {}),
        host_ip: v.bind,
        protocol: v.protocol,
      },
    ];
  const env = Object.create(null);
  for (const line of v.environment.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (!match) throw Error('Une variable par ligne, au format NOM=valeur.');
    if (Object.hasOwn(env, match[1])) throw Error(`Variable répétée : ${match[1]}.`);
    env[match[1]] = match[2].replaceAll('$', () => '$$');
  }
  if (Object.keys(env).length) service.environment = env;
  if (v.networkKey) {
    if (!Object.hasOwn(model.networks || {}, v.networkKey))
      throw Error('Le réseau du projet a changé. Sélectionne un réseau disponible.');
    service.networks = [v.networkKey];
  } else if (v.network) {
    let key = Object.entries(model.networks || {}).find(
      ([, n]) => n?.external && n.name === v.network,
    )?.[0];
    if (!key) {
      key = 'attached_network';
      for (let i = 2; Object.hasOwn(model.networks || {}, key); i++) key = `attached_network_${i}`;
      doc.setIn(['networks', key], { external: true, name: v.network.replaceAll('$', () => '$$') });
    }
    service.networks = [key];
  }
  doc.setIn(['services', v.name], service);
  return doc.toString();
}
