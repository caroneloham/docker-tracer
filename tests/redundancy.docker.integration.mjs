// Real local failover, bounded to an isolated project and cached images only.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { docker } from '../server/docker.mjs';
import { planLocalRedundancy, LOCAL_REDUNDANCY_IMAGE } from '../shared/redundancy-network.mjs';

const exec = promisify(execFile),
  name = `dtr-ha-test-${Date.now()}`;
const dir = await mkdtemp(path.join(tmpdir(), 'dtr-ha-test-'));
const file = path.join(dir, 'compose.yaml');
const filter = { label: [`com.docker.compose.project=${name}`] };
const baseline = {
  containers: (await docker.listContainers({ all: true })).map((c) => [c.Id, c.State]).sort(),
  networks: (await docker.listNetworks()).map((n) => n.Id).sort(),
  volumes: (await docker.listVolumes()).Volumes.map((v) => v.Name).sort(),
  images: (await docker.listImages()).map((i) => i.Id).sort(),
};
for (const image of ['nginx:alpine', LOCAL_REDUNDANCY_IMAGE])
  await docker.getImage(image).inspect();
const available = net.createServer();
await new Promise((resolve) => available.listen(0, '127.0.0.1', resolve));
const port = available.address().port;
await new Promise((resolve) => available.close(resolve));
const evidence = {
  project: name,
  port,
  scope: 'local-container-failover',
  checks: [],
  checkedAt: new Date().toISOString(),
};
const compose = async (...args) =>
  exec('docker', ['compose', '-p', name, '-f', file, ...args], {
    timeout: 90000,
    maxBuffer: 1024 * 1024,
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, description, timeout = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      if (await check()) {
        evidence.checks.push({ description, elapsedMs: Date.now() - start });
        return;
      }
    } catch (error) {
      last = error.message;
    }
    await wait(350);
  }
  throw Error(`${description}: timeout${last ? ` (${last})` : ''}`);
}
async function request() {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, body: (await response.text()).trim() };
}
async function inside(container, command) {
  const execution = await container.exec({
    Cmd: ['sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  await new Promise((resolve, reject) => {
    stream.resume();
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}
try {
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
  const model = YAML.parse(plan.source);
  model.services[plan.summary.proxyService].pull_policy = 'never';
  model.services[plan.summary.proxyService].cpus = 0.25;
  model.services[plan.summary.proxyService].mem_limit = '48m';
  model.services[plan.summary.proxyService].logging = {
    driver: 'json-file',
    options: { 'max-size': '1m', 'max-file': '1' },
  };
  await writeFile(file, YAML.stringify(model));
  await compose('config', '--quiet');
  await compose('up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '30');
  const all = await docker.listContainers({ all: true, filters: filter });
  const replicas = all.filter((c) => c.Labels['com.docker.compose.service'] === 'web');
  assert.equal(replicas.length, 2);
  const seen = new Set();
  await eventually(async () => {
    const r = await request();
    if (r.status === 200) seen.add(r.body);
    return seen.size === 2;
  }, 'Deux instances servent la même adresse');
  const first = docker.getContainer(replicas[0].Id),
    second = docker.getContainer(replicas[1].Id);
  const firstName = (await first.inspect()).Config.Hostname;
  await inside(first, 'rm /usr/share/nginx/html/ready');
  await eventually(async () => {
    const replies = await Promise.all(Array.from({ length: 6 }, request));
    return replies.every((r) => r.status === 200 && r.body !== firstName);
  }, 'Instance non prête retirée, autre instance toujours accessible');
  assert.equal((await first.inspect()).State.Running, true);
  await inside(first, 'echo ready > /usr/share/nginx/html/ready');
  await eventually(
    async () => (await request()).body === firstName,
    'Instance rétablie réintégrée automatiquement',
  );
  const restartBefore = (await first.inspect()).RestartCount;
  // Terminate the application from inside; docker stop intentionally disables restart.
  await inside(first, 'nginx -s quit');
  await eventually(async () => {
    const info = await first.inspect();
    return info.RestartCount > restartBefore && info.State.Running;
  }, 'Docker relance le conteneur après la fin du processus applicatif');
  await eventually(
    async () => (await request()).body === firstName,
    'Instance relancée réintégrée dans le trafic',
  );
  await Promise.all([first.stop(), second.stop()]);
  await eventually(
    async () => (await request()).status === 503,
    'Aucune instance prête produit une indisponibilité explicite',
  );
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error.message;
  try {
    evidence.logs = (await compose('logs', '--tail', '40')).stdout;
  } catch {}
  throw error;
} finally {
  try {
    await compose('down', '--timeout', '3');
  } catch {
    for (const c of await docker.listContainers({ all: true, filters: filter }))
      await docker.getContainer(c.Id).remove({ force: true });
    for (const n of await docker.listNetworks({ filters: filter }))
      await docker.getNetwork(n.Id).remove();
  }
  const after = {
    containers: (await docker.listContainers({ all: true })).map((c) => [c.Id, c.State]).sort(),
    networks: (await docker.listNetworks()).map((n) => n.Id).sort(),
    volumes: (await docker.listVolumes()).Volumes.map((v) => v.Name).sort(),
    images: (await docker.listImages()).map((i) => i.Id).sort(),
  };
  evidence.cleanup = Object.fromEntries(
    Object.keys(baseline).map((k) => [k, JSON.stringify(baseline[k]) === JSON.stringify(after[k])]),
  );
  await writeFile(
    new URL('../output/redundancy-real-test.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  assert.equal(path.dirname(dir), tmpdir());
  assert.ok(path.basename(dir).startsWith('dtr-ha-test-'));
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(after, baseline);
  console.log(JSON.stringify(evidence, null, 2));
}
