import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostSchema, checkSchema } from '../shared/workspace.mjs';

const week = 7 * 86400000;
export function pruneRuns(runs, now = Date.now()) {
  return runs
    .filter((r) => r.startedAt >= now - week)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 100);
}
export async function openWorkspaceStore(dir) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'workspace-v1.json');
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.runs) || !Array.isArray(state.captures))
      throw Error('Format de workspace non reconnu.');
    state.hosts = state.hosts.map((h) => hostSchema.parse(h));
    state.checks = state.checks.map((c) => checkSchema.parse(c));
    if (!state.hosts.some((h) => h.id === 'local')) throw Error('Profil local manquant.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = {
      version: 1,
      hosts: [hostSchema.parse({ id: 'local', name: 'Cet ordinateur', kind: 'local' })],
      checks: [],
      runs: [],
      captures: [],
      actions: [],
    };
  }
  let queue = Promise.resolve();
  const mutate = (fn) => {
    const operation = queue.then(async () => {
      const next = structuredClone(state);
      const result = await fn(next);
      next.runs = pruneRuns(next.runs);
      next.captures = next.captures.filter((c) => c.startedAt >= Date.now() - week).slice(-100);
      next.actions = (next.actions || []).slice(-100);
      await writeFile(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(file + '.tmp', file);
      state = next;
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  };
  // Interrupted operations are observations, never assumed successful after a restart.
  await mutate((s) => {
    s.instanceId ||= randomUUID();
    for (const r of s.runs)
      if (r.status === 'running')
        Object.assign(r, {
          status: 'inconclusive',
          finishedAt: Date.now(),
          summary: 'Serveur redémarré pendant le diagnostic.',
        });
    for (const c of s.captures)
      if (c.status === 'running')
        Object.assign(c, { status: 'interrupted', finishedAt: Date.now() });
  });
  return { read: (select = (s) => s) => structuredClone(select(state)), mutate, dir };
}
