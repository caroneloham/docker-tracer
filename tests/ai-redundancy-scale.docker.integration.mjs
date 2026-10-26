// Production API regression: retire only generated AI replica names, never
// generic Compose orphans. Cached nginx stands in for the heavyweight AI apps.
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { docker } from '../server/docker.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';

await docker.getImage('nginx:alpine').inspect();
const snapshot = async () => ({
  containers: (await docker.listContainers({ all: true }))
    .map((item) => [item.Id, item.State])
    .sort(),
  networks: (await docker.listNetworks()).map((item) => item.Id).sort(),
  volumes: (await docker.listVolumes()).Volumes.map((item) => item.Name).sort(),
  images: (await docker.listImages()).map((item) => item.Id).sort(),
});
const baseline = await snapshot();
const name = `dtr-ai-scale-${Date.now()}`;
const dir = await mkdtemp(path.join(tmpdir(), 'dtr-ai-scale-'));
const filter = { label: [`com.docker.compose.project=${name}`] };
const marker = 'x-docker-tracer-ai-redundancy';
const evidence = {
  project: name,
  checkedAt: new Date().toISOString(),
  scope: 'production-api-named-ai-replica-scale-down',
  baselineContainerCount: baseline.containers.length,
  checks: [],
};
const app = express();
app.use(express.json({ limit: '5mb' }));
let workspace, projects, server, project;
const record = () => projects.store.get(project.id);
const api = async (route, body, method = 'POST') => {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api${route}`,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'If-Match': String(project ? record().revision : 1),
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
};
const action = (route, body) => api(`/projects/${project.id}${route}`, body);
const actual = async () =>
  Object.fromEntries(
    await Promise.all(
      (await docker.listContainers({ all: true, filters: filter })).map(async (item) => [
        item.Labels['com.docker.compose.service'],
        await docker.getContainer(item.Id).inspect(),
      ]),
    ),
  );
const applySource = async (source) => {
  const preview = await action('/compose/preview', { ...record().compose, source });
  assert.ok(preview.token);
  const result = await action('/compose/apply', { token: preview.token });
  assert.equal(result.ok, true);
};

try {
  const emit = () => {};
  workspace = await mountWorkspaceApi(app, {
    dataDir: dir,
    localDocker: docker,
    emit,
    labBusy: (id) => projects?.hostBusy(id) || false,
    guardHost: (id, next) => projects?.guardHost(id, next),
    projectList: () => projects?.list() || [],
  });
  projects = await createProjectService({ dataDir: dir, workspace, emit });
  mountProjectApi(app, projects);
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 400).json({ error: error.message }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const service = {
    image: 'nginx:alpine',
    pull_policy: 'never',
    cpus: 0.1,
    mem_limit: '64m',
    healthcheck: {
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/'],
      interval: '1s',
      timeout: '2s',
      retries: 10,
    },
    logging: { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '1' } },
  };
  const model = {
    services: Object.fromEntries(
      ['webui', 'webui-2', 'webui-3', 'user-extra'].map((serviceName) => [
        serviceName,
        structuredClone(service),
      ]),
    ),
    [marker]: {
      version: 1,
      mode: 'fresh-only',
      replicas: 3,
      services: ['webui', 'webui-2', 'webui-3'],
    },
  };
  const initial = YAML.stringify(model);
  project = (
    await api('/projects', {
      name: 'AI replica scale regression',
      hostId: 'local',
      compose: { projectName: name, source: initial, waitSeconds: 25 },
    })
  ).project;
  await applySource(initial);
  const before = await actual();
  assert.deepEqual(Object.keys(before).sort(), ['user-extra', 'webui', 'webui-2', 'webui-3']);
  for (const info of Object.values(before)) {
    assert.equal(info.State.Running, true);
    assert.equal(info.State.Health.Status, 'healthy');
  }
  evidence.checks.push({
    description: 'API installe trois interfaces nommées et un service utilisateur supplémentaire',
  });

  // Both services disappear from Compose, but only webui-3 is in the previous
  // generated-replica inventory. user-extra must remain a running orphan.
  delete model.services['webui-3'];
  delete model.services['user-extra'];
  model[marker].replicas = 2;
  model[marker].services = ['webui', 'webui-2'];
  const reduced = YAML.stringify(model);
  const preview = await action('/compose/preview', { ...record().compose, source: reduced });
  assert.deepEqual(
    Object.keys(await actual()).sort(),
    Object.keys(before).sort(),
    'Preview must not remove any container',
  );
  await action('/compose/apply', { token: preview.token });
  const after = await actual();
  assert.deepEqual(Object.keys(after).sort(), ['user-extra', 'webui', 'webui-2']);
  await assert.rejects(
    docker.getContainer(before['webui-3'].Id).inspect(),
    (error) => error.statusCode === 404,
  );
  for (const serviceName of ['webui', 'webui-2', 'user-extra']) {
    assert.equal(
      after[serviceName].Id,
      before[serviceName].Id,
      `${serviceName}: identity must be preserved`,
    );
    assert.equal(
      after[serviceName].State.StartedAt,
      before[serviceName].State.StartedAt,
      `${serviceName}: no restart`,
    );
    assert.equal(after[serviceName].State.Running, true);
  }
  assert.equal(record().compose.lastApplied.source, reduced);
  evidence.checks.push({
    description: 'Seul webui-3 est arrêté puis supprimé après réussite de up --wait',
    removedService: 'webui-3',
  });
  evidence.checks.push({
    description:
      'Primaire, deuxième interface et orphelin utilisateur restent actifs sans recréation ni redémarrage',
    preserved: ['webui', 'webui-2', 'user-extra'],
  });

  // Re-applying the same desired count cannot broaden cleanup to other orphans.
  await applySource(reduced);
  const repeated = await actual();
  for (const serviceName of ['webui', 'webui-2', 'user-extra'])
    assert.equal(repeated[serviceName].Id, before[serviceName].Id);
  evidence.checks.push({
    description: 'Une seconde application conserve également l’orphelin utilisateur',
  });
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error.message;
  throw error;
} finally {
  await projects?.shutdown();
  await workspace?.shutdown();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const container of await docker.listContainers({ all: true, filters: filter }))
    await docker.getContainer(container.Id).remove({ force: true });
  for (const network of await docker.listNetworks({ filters: filter }))
    await docker.getNetwork(network.Id).remove();
  const after = await snapshot();
  evidence.cleanup = Object.fromEntries(
    Object.keys(baseline).map((key) => [
      key,
      JSON.stringify(baseline[key]) === JSON.stringify(after[key]),
    ]),
  );
  await writeFile(
    new URL('../output/ai-redundancy-scale-real-test.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  assert.equal(path.dirname(dir), tmpdir());
  assert.ok(path.basename(dir).startsWith('dtr-ai-scale-'));
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(after, baseline);
  console.log(JSON.stringify(evidence, null, 2));
}
