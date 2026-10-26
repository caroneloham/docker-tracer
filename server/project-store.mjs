import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { initialTopology, topologySchema } from '../shared/model.mjs';
import { resetBridgeAddresses } from '../shared/bridge.mjs';
import { composeRecord, composeSettings, composeDocument } from '../shared/compose-project.mjs';

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const recordSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    hostId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    topology: topologySchema,
    revision: z.number().int().min(1),
    everDeployed: z.boolean(),
    archivedAt: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    tests: z.array(z.unknown()).max(30).default([]),
    compose: composeRecord.nullable().default(null),
  })
  .refine((r) => r.id === r.topology.id, 'Identité du projet incohérente.');
export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  hostId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  template: z.enum(['empty', 'example']).default('empty'),
  copyFrom: idSchema.optional(),
  compose: composeSettings.optional(),
});
const error = (message, statusCode = 409) => Object.assign(Error(message), { statusCode });

export async function openProjectStore(dataDir) {
  const dir = path.join(dataDir, 'projects');
  await mkdir(dir, { recursive: true });
  const records = new Map();
  for (const name of await readdir(dir)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}\.json$/.test(name)) continue;
    const record = recordSchema.parse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
    if (name !== `${record.id}.json`) throw Error('Nom de fichier de projet incohérent.');
    records.set(record.id, record);
  }
  const write = async (record) => {
    record = recordSchema.parse(record);
    const file = path.join(dir, `${record.id}.json`);
    await writeFile(file + '.tmp', JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(file + '.tmp', file);
    records.set(record.id, record);
  };
  let defaultId;
  const manifest = path.join(dataDir, 'projects-v1.json');
  try {
    defaultId = z
      .object({ version: z.literal(1), defaultId: idSchema })
      .parse(JSON.parse(await readFile(manifest, 'utf8'))).defaultId;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    let legacy,
      hadLegacy = true;
    try {
      legacy = topologySchema.parse(
        JSON.parse(await readFile(path.join(dataDir, 'topology.json'), 'utf8')),
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      legacy = topologySchema.parse(initialTopology());
      hadLegacy = false;
    }
    defaultId = legacy.id;
    // Preserve IDs/labels and the original file. Reuse an already migrated record after a crash.
    if (!records.has(defaultId))
      await write({
        version: 1,
        id: defaultId,
        hostId: 'local',
        topology: legacy,
        revision: 1,
        everDeployed: hadLegacy,
        archivedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tests: [],
      });
    await writeFile(manifest + '.tmp', JSON.stringify({ version: 1, defaultId }), { mode: 0o600 });
    await rename(manifest + '.tmp', manifest);
  }
  if (!records.has(defaultId) || records.get(defaultId).hostId !== 'local')
    throw Error('Projet local historique introuvable.');
  let queue = Promise.resolve();
  const serial = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const get = (id) => {
    const record = records.get(id);
    if (!record) throw error('Projet introuvable.', 404);
    return structuredClone(record);
  };
  return {
    defaultId,
    get,
    list: () => [...records.values()].map((r) => structuredClone(r)),
    async create(input) {
      return serial(async () => {
        const value = createProjectSchema.parse(input);
        if (value.copyFrom && get(value.copyFrom).compose)
          throw error(
            'Pour copier un projet Compose, importe son fichier en choisissant un nouveau nom Compose.',
          );
        if (value.compose) {
          composeDocument(value.compose.source);
          if (value.copyFrom) throw error('Choisis une copie ou un fichier Compose.');
          if (
            [...records.values()].some(
              (r) =>
                r.hostId === value.hostId && r.compose?.projectName === value.compose.projectName,
            )
          )
            throw error('Ce nom Compose est déjà rattaché à un projet, archives comprises.');
        }
        if (records.size >= 50) throw error('Maximum de 50 projets, archives comprises.');
        if (
          [...records.values()].some(
            (r) => !r.archivedAt && r.hostId === value.hostId && r.topology.name === value.name,
          )
        )
          throw error('Un projet porte déjà ce nom sur ce serveur.');
        const id = `p-${randomUUID()}`,
          now = Date.now();
        const topology = value.compose
          ? { nodes: [], edges: [] }
          : value.copyFrom
            ? get(value.copyFrom).topology
            : value.template === 'example'
              ? initialTopology()
              : { nodes: [], edges: [] };
        Object.assign(topology, { id, name: value.name });
        if (value.copyFrom) {
          for (const n of topology.nodes) {
            n.data.ports = [];
            n.data.subnet = '';
            n.data.bridge = resetBridgeAddresses(n.data.bridge);
          }
          for (const e of topology.edges) e.ipv4 = '';
        }
        await write({
          version: 1,
          id,
          hostId: value.hostId,
          topology,
          revision: 1,
          everDeployed: value.compose?.adopt || false,
          compose: value.compose || null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          tests: [],
        });
        return get(id);
      });
    },
    async update(id, expectedRevision, fn) {
      return serial(async () => {
        const current = get(id);
        if (expectedRevision !== undefined && expectedRevision !== current.revision)
          throw error(
            'Ce projet a changé dans une autre fenêtre. Recharge-le avant d’enregistrer.',
          );
        const next = structuredClone(current);
        await fn(next);
        if (next.id !== current.id || next.hostId !== current.hostId)
          throw error(
            'La cible d’un projet est immuable. Duplique-le pour choisir un autre serveur.',
          );
        if (
          !!next.compose !== !!current.compose ||
          next.compose?.projectName !== current.compose?.projectName ||
          next.compose?.adopt !== current.compose?.adopt
        )
          throw error('Le mode et la cible Compose d’un projet sont immuables.');
        if (
          !next.archivedAt &&
          [...records.values()].some(
            (r) =>
              r.id !== id &&
              !r.archivedAt &&
              r.hostId === next.hostId &&
              r.topology.name === next.topology.name,
          )
        )
          throw error('Un projet porte déjà ce nom sur ce serveur.');
        next.updatedAt = Date.now();
        next.revision++;
        await write(next);
        return get(id);
      });
    },
  };
}
