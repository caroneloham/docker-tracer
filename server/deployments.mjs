import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function openDeploymentStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'deployments-v1.json');
  let runs = [];
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.runs))
      throw Error('Historique de déploiement invalide.');
    runs = state.runs;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let queue = Promise.resolve();
  const write = (fn) => {
    const operation = queue.then(async () => {
      let next = structuredClone(runs);
      fn(next);
      const perProject = new Map();
      next = next
        .filter((r) => Date.now() - r.startedAt < 7 * 86400000)
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter((r) => {
          const count = (perProject.get(r.projectId) || 0) + 1;
          perProject.set(r.projectId, count);
          return count <= 20;
        });
      await writeFile(file + '.tmp', JSON.stringify({ version: 1, runs: next }), { mode: 0o600 });
      await rename(file + '.tmp', file);
      runs = next;
    });
    queue = operation.catch(() => {});
    return operation;
  };
  await write((list) => {
    for (const run of list)
      if (run.status === 'running')
        Object.assign(run, {
          status: 'inconclusive',
          finishedAt: Date.now(),
          message: 'Docker Tracer a été interrompu. Vérifie l’état réel avant de poursuivre.',
        });
  });
  return {
    list: (id) =>
      structuredClone(
        runs.filter((r) => r.projectId === id && Date.now() - r.startedAt < 7 * 86400000),
      ),
    async record(project, kind, operation) {
      const run = {
        id: randomUUID(),
        projectId: project.id,
        hostId: project.hostId,
        kind,
        startedAt: Date.now(),
        status: 'running',
        checks: [],
      };
      await write((list) => list.push(run));
      let result, error;
      try {
        result = await operation();
      } catch (e) {
        error = e;
      }
      const source = error || result || {};
      const changes = {
        status: error ? 'failed' : 'succeeded',
        finishedAt: Date.now(),
        message: error ? error.message : 'Opération terminée.',
        checks: source.startupChecks || [],
        rollback: source.rollback || null,
        warnings: source.warnings || [],
        output: (source.output || '').slice(-64000),
      };
      if (error && (error.inconclusive || changes.checks.some((c) => c.status === 'inconclusive')))
        changes.status = 'inconclusive';
      try {
        await write((list) =>
          Object.assign(
            list.find((r) => r.id === run.id),
            changes,
          ),
        );
      } catch (saveError) {
        throw Error(
          (error?.message || 'Opération terminée dans Docker.') +
            ' Son résultat n’a pas pu être enregistré : ' +
            saveError.message,
        );
      }
      if (error) throw Object.assign(error, { deploymentRun: run.id });
      return result;
    },
  };
}
