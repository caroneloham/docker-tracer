import { z } from 'zod';

export const recordId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const containerId = z.string().regex(/^[a-f0-9]{64}$/);
export const hostSchema = z
  .object({
    id: recordId,
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['local', 'ssh']),
    address: z
      .string()
      .max(253)
      .regex(/^[a-zA-Z0-9:.][a-zA-Z0-9.:-]*$/)
      .optional(),
    port: z.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/)
      .optional(),
    auth: z.enum(['agent', 'key']).default('agent'),
    identityFile: z.string().max(1024).default(''),
    fingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
      .nullable()
      .default(null),
  })
  .superRefine((h, ctx) => {
    if (h.kind === 'ssh' && (!h.address || !h.username || (h.auth === 'key' && !h.identityFile)))
      ctx.addIssue({ code: 'custom', message: 'Adresse, utilisateur et méthode SSH sont requis.' });
    if ((h.kind === 'local') !== (h.id === 'local'))
      ctx.addIssue({ code: 'custom', message: 'Le moteur local utilise l’identifiant local.' });
  });
export const resourceSchema = z.object({
  hostId: recordId,
  containerId,
  name: z.string().max(200).default(''),
  project: z.string().max(200).default(''),
  service: z.string().max(200).default(''),
  labId: z.string().max(80).default(''),
});
export const checkSchema = z
  .object({
    id: recordId,
    name: z.string().trim().min(1).max(100),
    source: resourceSchema,
    target: resourceSchema,
    protocol: z.enum(['TCP', 'HTTP', 'HTTPS', 'ICMP']).default('TCP'),
    hostname: z
      .string()
      .max(253)
      .regex(/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/)
      .default(''),
    address: z
      .string()
      .max(253)
      .regex(/^(?:[a-zA-Z0-9_:][a-zA-Z0-9_.:-]*)?$/)
      .default(''),
    port: z.number().int().min(1).max(65535).default(80),
    path: z
      .string()
      .max(1000)
      .regex(/^\/[^\s\r\n]*$/)
      .default('/'),
    expectedStatus: z.number().int().min(100).max(599).default(200),
  })
  .superRefine((c, ctx) => {
    if (c.source.hostId === c.target.hostId && c.source.containerId === c.target.containerId)
      ctx.addIssue({ code: 'custom', message: 'Choisis deux équipements distincts.' });
    if (c.source.hostId !== c.target.hostId && !c.address)
      ctx.addIssue({
        code: 'custom',
        message: 'Entre une adresse joignable depuis la source pour une connexion entre hôtes.',
      });
  });
export const captureSchema = z.object({
  targets: z.array(resourceSchema).min(1).max(2),
  duration: z.number().int().min(5).max(120).default(30),
  port: z.number().int().min(1).max(65535).optional(),
  runId: recordId.optional(),
});
export function resourceRef(hostId, c) {
  return {
    hostId,
    containerId: c.dockerId || c.id,
    name: c.name,
    project: c.projectKey?.startsWith('compose:') ? c.projectKey.slice(8) : '',
    service: c.service || '',
    labId: c.labId || '',
  };
}
export function resolveResource(ref, inventory) {
  const exact = inventory.containers.find((c) => c.id === ref.containerId);
  if (exact) return exact;
  const matches = inventory.containers.filter((c) =>
    ref.project && ref.service
      ? c.projectKey === `compose:${ref.project}` && c.service === ref.service
      : ref.labId && ref.service
        ? c.labId === ref.labId && c.service === ref.service
        : !!ref.name && c.name === ref.name,
  );
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? 'Plusieurs instances correspondent à ce contrôle. Sélectionne une instance.'
        : 'Équipement introuvable. Actualise la cible du contrôle.',
    );
  return matches[0];
}
export function qualifyInventory(snapshot, host) {
  const key = (id) => `${host.id}:${id}`;
  return {
    ...snapshot,
    containers: snapshot.containers.map((c) => ({
      ...c,
      dockerId: c.id,
      id: key(c.id),
      hostId: host.id,
      hostName: host.name,
      projectKey: `${host.id}/${c.projectKey}`,
      project: `${host.name} / ${c.project}`,
      originalProjectKey: c.projectKey,
      attachments: c.attachments.map((a) => ({ ...a, networkId: key(a.networkId) })),
    })),
    networks: snapshot.networks.map((n) => ({
      ...n,
      dockerId: n.id,
      id: key(n.id),
      hostId: host.id,
      hostName: host.name,
    })),
    links: snapshot.links.map((l) => ({
      ...l,
      id: key(l.id),
      source: `${l.source.slice(0, 2)}${key(l.source.slice(2))}`,
      target: `${l.target.slice(0, 2)}${key(l.target.slice(2))}`,
    })),
  };
}
export function currentResourceKey(ref, snapshot) {
  try {
    const containers = snapshot.containers
      .filter((c) => c.hostId === ref.hostId)
      .map((c) => ({ ...c, id: c.dockerId, projectKey: c.originalProjectKey }));
    return `${ref.hostId}:${resolveResource(ref, { containers }).id}`;
  } catch {
    return null;
  }
}
export const resultLabels = {
  passed: 'Réussi',
  failed: 'Échoué',
  inconclusive: 'Non concluant',
  running: 'En cours',
};
