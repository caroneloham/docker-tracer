import { mkdir, readFile, writeFile, rename, rm, statfs, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { backupId } from '../shared/backups.mjs';

const recordSchema = z.object({
  id: backupId,
  projectId: z.string(),
  hostId: z.string(),
  nodeId: z.string(),
  volume: z.string(),
  target: z.string(),
  name: z.string(),
  createdAt: z.number(),
  status: z.enum(['running', 'ready', 'failed', 'interrupted']),
  bytes: z.number().nonnegative().default(0),
  sha256: z.string().default(''),
  entries: z.number().default(0),
  message: z.string().default(''),
  helperId: z.string().nullable().default(null),
  resume: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export async function openBackupStore(dataDir) {
  const dir = path.join(dataDir, 'backups'),
    file = path.join(dir, 'index-v1.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let records = [],
    known = {};
  try {
    const saved = z
      .object({
        version: z.literal(1),
        records: z.array(recordSchema),
        known: z
          .record(z.string(), z.object({ target: z.string(), nodeId: z.string() }))
          .default({}),
      })
      .parse(JSON.parse(await readFile(file, 'utf8')));
    records = saved.records;
    known = saved.known;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  known = {
    ...Object.fromEntries(
      records.map((r) => [`${r.projectId}:${r.volume}`, { target: r.target, nodeId: r.nodeId }]),
    ),
    ...known,
  };
  const maxBytes =
    z.coerce
      .number()
      .min(0.001)
      .max(1024)
      .parse(process.env.DTR_BACKUP_MAX_GIB || 10) *
    1024 ** 3;
  const totalBytes =
    z.coerce
      .number()
      .min(0.001)
      .max(10240)
      .parse(process.env.DTR_BACKUP_TOTAL_GIB || 50) *
    1024 ** 3;
  let queue = Promise.resolve(),
    busy = false;
  const update = (id, changes) => {
    const job = queue.then(async () => {
      const next = structuredClone(records),
        index = next.findIndex((r) => r.id === id);
      if (changes === null) {
        if (index >= 0) next.splice(index, 1);
      } else if (index < 0) {
        if (next.length >= 500)
          throw Error('Supprime une ancienne sauvegarde avant d’en créer une autre.');
        next.push(recordSchema.parse(changes));
      } else next[index] = recordSchema.parse({ ...next[index], ...changes });
      const nextKnown = { ...known };
      for (const r of records.concat(next))
        nextKnown[`${r.projectId}:${r.volume}`] = { target: r.target, nodeId: r.nodeId };
      await writeFile(
        file + '.tmp',
        JSON.stringify({ version: 1, records: next, known: nextKnown }),
        {
          mode: 0o600,
        },
      );
      await rename(file + '.tmp', file);
      records = next;
      known = nextKnown;
    });
    queue = job.catch(() => {});
    return job;
  };
  const archive = (id, partial = false) =>
    path.join(dir, backupId.parse(id) + (partial ? '.partial' : '.tar'));
  for (const r of records.filter((r) => r.status === 'running')) {
    await update(r.id, {
      status: 'interrupted',
      message: 'Sauvegarde interrompue. Vérifie les services à reprendre.',
    });
    await rm(archive(r.id, true), { force: true });
  }
  return {
    maxBytes,
    totalBytes,
    archive,
    update,
    knownVolume: (projectId, volume) => known[`${projectId}:${volume}`],
    list: (projectId) =>
      structuredClone(
        records.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt),
      ),
    get(id, projectId) {
      const r = records.find((r) => r.id === backupId.parse(id) && r.projectId === projectId);
      if (!r) throw Error('Sauvegarde introuvable pour ce projet.');
      return structuredClone(r);
    },
    async exclusive(fn) {
      if (busy) throw Error('Une sauvegarde ou restauration est déjà en cours.');
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
    async capacity() {
      let used = 0;
      for (const name of await readdir(dir))
        if (/^[a-f0-9-]{36}\.(tar|partial)$/.test(name))
          try {
            used += (await lstat(path.join(dir, name))).size;
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
      const disk = await statfs(dir),
        free = disk.bavail * disk.bsize;
      return {
        used,
        maxBytes,
        totalBytes,
        available: Math.max(0, Math.floor(Math.min(maxBytes, totalBytes - used, free - 1024 ** 3))),
      };
    },
  };
}
