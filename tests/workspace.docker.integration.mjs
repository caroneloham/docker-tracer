// Explicit real Docker integration. Only uniquely labelled fixtures are changed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docker } from '../server/docker.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { Diagnostics } from '../server/diagnostics.mjs';
import { TargetCaptures, CAPTURE_LIMIT } from '../server/target-captures.mjs';
import { resourceRef } from '../shared/workspace.mjs';
import { TOOL_IMAGE } from '../server/engine-tools.mjs';
await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-real-')),
  name = `dtr-verify-${Date.now()}`,
  created = [];
const store = await openWorkspaceStore(dir),
  hosts = new HostRegistry(store, docker),
  captures = new TargetCaptures(store, hosts, () => {}),
  diagnostics = new Diagnostics(store, hosts, captures, () => {});
let network;
async function image(name) {
  try {
    await docker.getImage(name).inspect();
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    const stream = await docker.pull(name);
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())),
    );
  }
}
async function container(service, Image, extra = {}) {
  const c = await docker.createContainer({
    name: `${name}-${service}`,
    Image,
    Labels: {
      'io.dockertracer.test': name,
      'com.docker.compose.project': name,
      'com.docker.compose.service': service,
    },
    HostConfig: { NetworkMode: name },
    NetworkingConfig: { EndpointsConfig: { [name]: { Aliases: [service] } } },
    ...extra,
  });
  created.push(c);
  await c.start();
  return c;
}
async function run(check, capture = false) {
  const r = await diagnostics.start(check.id, capture);
  await Promise.all([...diagnostics.tasks]);
  const result = store.read().runs.find((x) => x.id === r.id);
  console.log(check.name, result.status, result.summary);
  return result;
}
try {
  for (const img of ['registry.k8s.io/pause:3.10.1', 'nginx:alpine', TOOL_IMAGE]) await image(img);
  network = await docker.createNetwork({
    Name: name,
    Driver: 'bridge',
    Labels: { 'io.dockertracer.test': name },
  });
  const source = await container('client', 'registry.k8s.io/pause:3.10.1'),
    target = await container('web', 'nginx:alpine');
  const tls = await container('tls', TOOL_IMAGE, {
    Entrypoint: ['sh', '-c'],
    Cmd: [
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/key.pem -out /tmp/cert.pem -days 1 -subj /CN=tls >/dev/null 2>&1 && exec openssl s_server -accept 443 -key /tmp/key.pem -cert /tmp/cert.pem -www',
    ],
  });
  const inv = await hosts.inventory('local'),
    ref = (c) =>
      resourceRef(
        'local',
        inv.containers.find((x) => x.id === c.id),
      );
  const check = await diagnostics.save({
    name: 'HTTP depuis une image sans shell',
    source: ref(source),
    target: ref(target),
    protocol: 'HTTP',
    hostname: 'web',
  });
  let r = await run(check, true);
  assert.equal(r.status, 'passed', JSON.stringify(r));
  const cap = captures.get(r.captureId);
  assert.equal(cap.status, 'completed', JSON.stringify(cap.errors));
  assert.equal(cap.targets.length, 2);
  assert.equal(cap.files.length, 2);
  assert.ok(cap.count > 0);
  assert.ok(cap.bytes <= CAPTURE_LIMIT);
  assert.ok(cap.packets.some((p) => p.route.length === 2));
  for (const f of cap.files) {
    const { buffer } = await captures.file(cap.id, f.index);
    assert.ok(
      ['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(
        buffer.subarray(0, 4).toString('hex'),
      ),
    );
    assert.ok(buffer.length > 24);
  }
  const variant = async (name, changes) =>
    diagnostics.save({ ...check, id: undefined, name, ...changes });
  const dns = await variant('Mauvais nom DNS', { hostname: 'does-not-exist.invalid' });
  r = await run(dns);
  assert.equal(r.status, 'failed');
  assert.equal(r.steps.find((s) => s.kind === 'tcp').status, 'passed');
  const corrected = await diagnostics.save({ ...dns, hostname: 'web' });
  r = await run(corrected);
  assert.equal(r.status, 'passed');
  assert.ok(r.previousRunId);
  r = await run(await variant('Port fermé', { protocol: 'TCP', port: 65534 }));
  assert.equal(r.status, 'failed');
  r = await run(await variant('HTTP 404', { path: '/dtr-missing-test' }));
  assert.equal(r.steps.find((s) => s.kind === 'http').evidence.code, 404);
  r = await run(
    await variant('TLS auto-signé', {
      target: ref(tls),
      hostname: 'tls',
      protocol: 'HTTPS',
      port: 443,
    }),
  );
  assert.equal(r.steps.find((s) => s.kind === 'tls').status, 'failed');
  await source.stop({ t: 1 });
  r = await run(check);
  assert.equal(r.status, 'failed');
  assert.equal(r.steps[0].kind, 'state');
  const reloaded = await openWorkspaceStore(dir);
  assert.equal(reloaded.read().runs.length, 7);
  const leftovers = await docker.listContainers({
    all: true,
    filters: { label: ['io.dockertracer.workspace=1'] },
  });
  const sessions = new Set([...store.read().runs, ...store.read().captures].map((x) => x.id));
  assert.equal(
    leftovers.filter((c) => sessions.has(c.Labels['io.dockertracer.session'])).length,
    0,
  );
  console.log(
    'PASS : 7 diagnostics réels, capture de deux espaces réseau, PCAP, persistance et sondes nettoyées.',
  );
} finally {
  await diagnostics.shutdown();
  await captures.shutdown();
  for (const c of created) await c.remove({ force: true }).catch(() => {});
  if (network) await network.remove();
  await rm(dir, { recursive: true, force: true });
}
