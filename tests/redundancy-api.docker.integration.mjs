// Exercise the production HTTP routes and Compose runner, with cached images only.
// Only resources carrying this unique Compose project label may be removed.
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import YAML from 'yaml';
import { docker } from '../server/docker.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';
import {
  planLocalRedundancy,
  updateLocalRedundancyReplicas,
  LOCAL_REDUNDANCY_IMAGE,
} from '../shared/redundancy-network.mjs';

for (const image of ['nginx:alpine', LOCAL_REDUNDANCY_IMAGE])
  await docker.getImage(image).inspect();
const snapshot = async () => ({
  containers: (await docker.listContainers({ all: true }))
    .map((item) => [item.Id, item.State])
    .sort(),
  networks: (await docker.listNetworks()).map((item) => item.Id).sort(),
  volumes: (await docker.listVolumes()).Volumes.map((item) => item.Name).sort(),
  images: (await docker.listImages()).map((item) => item.Id).sort(),
});
const baseline = await snapshot(),
  name = `dtr-ha-api-${Date.now()}`;
const dir = await mkdtemp(path.join(tmpdir(), 'dtr-ha-api-'));
const filter = { label: [`com.docker.compose.project=${name}`] };
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const evidence = {
  project: name,
  port,
  checkedAt: new Date().toISOString(),
  checks: [],
  scope: 'production-api-existing-project',
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
const action = (route, body, method) => api(`/projects/${project.id}${route}`, body, method);
const request = async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, body: (await response.text()).trim() };
};
const eventually = async (check, description) => {
  const start = Date.now();
  while (Date.now() - start < 25000) {
    try {
      if (await check()) {
        evidence.checks.push({ description, elapsedMs: Date.now() - start });
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(description);
};
const applySource = async (source, waitSeconds = 30) => {
  const settings = { ...record().compose, source, waitSeconds };
  const preview = await action('/compose/preview', settings);
  assert.ok(preview.token);
  const result = await action('/compose/apply', { token: preview.token });
  assert.equal(result.ok, true);
  return result;
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
  const source = YAML.stringify({
    services: {
      web: {
        image: 'nginx:alpine',
        pull_policy: 'never',
        command: [
          'sh',
          '-c',
          'hostname > /usr/share/nginx/html/index.html; echo ready > /usr/share/nginx/html/ready; exec nginx -g "daemon off;"',
        ],
        ports: [`127.0.0.1:${port}:80`],
        cpus: 0.1,
        mem_limit: '64m',
        logging: { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '1' } },
      },
    },
  });
  project = (
    await api('/projects', {
      name: 'HA API test',
      hostId: 'local',
      compose: { projectName: name, source, waitSeconds: 30 },
    })
  ).project;
  await applySource(source);
  await eventually(
    async () => (await request()).status === 200,
    'Une instance initiale répond sur son port public',
  );
  assert.equal((await docker.listContainers({ all: true, filters: filter })).length, 1);

  const plan = planLocalRedundancy(source, {
    serviceNames: ['web'],
    replicas: 2,
    confirmations: { statelessServices: ['web'] },
    endpoints: [
      {
        service: 'web',
        targetPort: 80,
        publishedPort: port,
        hostIp: '127.0.0.1',
        protocol: 'http',
        healthPath: '/ready',
      },
    ],
  });
  assert.deepEqual(plan.blockers, []);
  const model = YAML.parse(plan.source),
    proxyName = plan.summary.proxyService;
  Object.assign(model.services[proxyName], {
    pull_policy: 'never',
    cpus: 0.25,
    mem_limit: '48m',
    logging: { driver: 'json-file', options: { 'max-size': '1m', 'max-file': '1' } },
  });
  const candidate = YAML.stringify(model);
  const preview = await action('/compose/preview', { ...record().compose, source: candidate });
  assert.equal(record().compose.source, source, 'Preview must not save or apply the candidate');
  await action('/compose/apply', { token: preview.token });
  assert.equal(record().compose.lastApplied.source, candidate);
  assert.equal(
    (await request()).status,
    200,
    'Apply must wait for routable backends, without a second manual wait',
  );
  let containers = await docker.listContainers({ all: true, filters: filter });
  assert.equal(
    containers.filter((item) => item.Labels['com.docker.compose.service'] === 'web').length,
    2,
  );
  const proxy = containers.find((item) => item.Labels['com.docker.compose.service'] === proxyName);
  assert.equal((await docker.getContainer(proxy.Id).inspect()).State.Health.Status, 'healthy');
  const identities = new Set();
  await eventually(async () => {
    const r = await request();
    if (r.status === 200) identities.add(r.body);
    return identities.size === 2;
  }, 'API réelle : deux instances après transfert du port existant au proxy');

  await docker.getContainer(proxy.Id).restart({ t: 1 });
  await eventually(
    async () => (await request()).status === 200,
    'Le port public reste accessible après redémarrage du répartiteur',
  );
  const restartedProxy = await docker.getContainer(proxy.Id).inspect();
  assert.equal(
    restartedProxy.NetworkSettings.Networks[`${name}_${plan.summary.entryNetworkName}`].GwPriority,
    1,
  );
  assert.equal(restartedProxy.NetworkSettings.Ports['18080/tcp'][0].HostPort, String(port));

  const resized = updateLocalRedundancyReplicas(candidate, {
    replicas: 3,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(resized.blockers, []);
  await applySource(resized.source);
  containers = await docker.listContainers({ all: true, filters: filter });
  assert.equal(
    containers.filter((item) => item.Labels['com.docker.compose.service'] === 'web').length,
    3,
  );
  assert.equal(
    containers.filter((item) => item.Labels['com.docker.compose.service'] === proxyName).length,
    1,
  );
  const resizedProxy = containers.find(
    (item) => item.Labels['com.docker.compose.service'] === proxyName,
  );
  const inspectConfig = await docker.getContainer(resizedProxy.Id).exec({
    Cmd: ['cat', '/usr/local/etc/haproxy/haproxy.cfg'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const configStream = await inspectConfig.start({ hijack: true, stdin: false });
  const configChunks = [];
  for await (const chunk of configStream) configChunks.push(chunk);
  const liveConfig = Buffer.concat(configChunks).toString('utf8');
  evidence.proxyResize = {
    recreated: resizedProxy.Id !== proxy.Id,
    liveTemplates: liveConfig.match(/server-template[^\n]+/g) || [],
  };
  assert.equal(
    evidence.proxyResize.recreated,
    true,
    'Changing inline config must recreate only the proxy',
  );
  assert.ok(evidence.proxyResize.liveTemplates.every((line) => line.includes('replica 1-3 ')));
  identities.clear();
  await eventually(async () => {
    const r = await request();
    if (r.status === 200) identities.add(r.body);
    return identities.size === 3;
  }, 'API réelle : trois instances, même proxy logique et même adresse');

  const broken = YAML.parse(resized.source);
  broken.configs[plan.summary.configName].content = broken.configs[
    plan.summary.configName
  ].content.replace(
    'http-check send meth GET uri /ready ',
    'http-check send meth GET uri /missing ',
  );
  const brokenPlan = updateLocalRedundancyReplicas(YAML.stringify(broken), {
    replicas: 3,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(brokenPlan.blockers, []);
  await assert.rejects(
    applySource(brokenPlan.source, 15),
    /unhealthy|healthy|timeout|health|attente/i,
  );
  assert.equal(
    record().compose.lastApplied.source,
    resized.source,
    'A failed rollout must not become the last successful deployment',
  );
  assert.equal((await request()).status, 503);
  evidence.checks.push({
    description: 'API refuse le succès lorsque tous les backends échouent à la sonde',
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
    new URL('../output/redundancy-api-real-test.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  assert.equal(path.dirname(dir), tmpdir());
  assert.ok(path.basename(dir).startsWith('dtr-ha-api-'));
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(after, baseline);
  console.log(JSON.stringify(evidence, null, 2));
}
