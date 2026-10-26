// Explicit real-engine check: only cached images, one private disposable network,
// two labelled test containers and one bounded observer. No image pulls.
import assert from 'node:assert/strict';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docker } from '../server/docker.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { TargetCaptures, CAPTURE_LIMIT } from '../server/target-captures.mjs';
import { TOOL_IMAGE, execTool } from '../server/engine-tools.mjs';
import { resourceRef } from '../shared/workspace.mjs';
import { inventoryObservations } from '../shared/inventory-observations.mjs';

const images = ['alpine:3.23', 'nginx:alpine', TOOL_IMAGE];
await docker.info();
for (const image of images) await docker.getImage(image).inspect();
const beforeImages = (await docker.listImages()).map((image) => image.Id).sort();
const beforeContainers = new Set((await docker.listContainers({ all: true })).map((c) => c.Id));
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-capture-cached-'));
const name = `dtr-capture-cached-${Date.now()}`;
const store = await openWorkspaceStore(dir);
const instanceId = store.read().instanceId;
const created = new Map();
let network;
const engine = new Proxy(docker, {
  get(target, key) {
    if (key === 'pull')
      return () => {
        throw Error('Image pulls are forbidden by this test.');
      };
    if (key === 'createContainer')
      return async (options) => {
        assert.ok(images.includes(options.Image), 'Only checked cached images may be used');
        const own = options.Labels?.['io.dockertracer.test'] === name;
        const observer =
          options.Labels?.['io.dockertracer.instance'] === instanceId &&
          options.Labels?.['io.dockertracer.role'] === 'observer';
        assert.ok(own || observer, 'Container must belong to this isolated run');
        const container = await target.createContainer(options);
        created.set(container.id, own ? 'test' : 'observer');
        return container;
      };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const hosts = new HostRegistry(store, engine);
const events = [];
let uiEmit = () => {};
const captures = new TargetCaptures(store, hosts, (event) => {
  events.push(event);
  uiEmit(event);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let evidence;
try {
  network = await engine.createNetwork({
    Name: name,
    Driver: 'bridge',
    Internal: true,
    Labels: { 'io.dockertracer.test': name },
  });
  const create = async (service, Image, extra = {}) => {
    const container = await engine.createContainer({
      name: `${name}-${service}`,
      Image,
      Labels: {
        'io.dockertracer.test': name,
        'com.docker.compose.project': name,
        'com.docker.compose.service': service,
      },
      HostConfig: { NetworkMode: name, Memory: 96 * 1048576, NanoCpus: 200000000, PidsLimit: 64 },
      NetworkingConfig: { EndpointsConfig: { [name]: { Aliases: [service] } } },
      ...extra,
    });
    await container.start();
    return container;
  };
  const source = await create('client', 'alpine:3.23', { Cmd: ['sleep', '180'] });
  const target = await create('web', 'nginx:alpine');
  const inventory = await hosts.inventory('local');
  const sourceRef = resourceRef(
    'local',
    inventory.containers.find((c) => c.id === source.id),
  );
  const request = () =>
    execTool(engine, source, ['wget', '-q', '-T', '2', '-O', '/dev/null', 'http://web/'], 4000);
  // Readiness is a fixture prerequisite. Its retries can take longer than the
  // capture itself, so they must finish before starting the ten-second window.
  const readinessStartedAt = Date.now();
  let response;
  for (let attempt = 0; attempt < 10; attempt++) {
    response = await request();
    if (response.exitCode === 0) break;
    await delay(200);
  }
  assert.equal(response.exitCode, 0, response.output);
  const readinessMs = Date.now() - readinessStartedAt;
  const capture = await captures.start({ targets: [sourceRef], duration: 10 });
  const deadline = Date.now() + 15000;
  let requestCount = 0;
  let lastRequest;
  const hasLiveFlow = (record) =>
    inventoryObservations([record]).some(
      (flow) =>
        flow.live && flow.source === `local:${source.id}` && flow.target === `local:${target.id}`,
    );
  // Keep producing real traffic while waiting for live delivery. This remains
  // inside the one bounded capture and stops at the first proven flow.
  while (
    captures.get(capture.id).status === 'running' &&
    !hasLiveFlow(captures.get(capture.id)) &&
    Date.now() < deadline
  ) {
    if (requestCount < 20) {
      lastRequest = await request();
      requestCount++;
    }
    await delay(250);
  }
  const active = captures.get(capture.id);
  const liveEvidence = JSON.stringify({
    readinessMs,
    requestCount,
    lastRequestExitCode: lastRequest?.exitCode,
    captureAgeMs: Date.now() - active.startedAt,
    status: active.status,
    ready: active.ready,
    count: active.count,
    errors: active.errors,
    expected: [`local:${source.id}`, `local:${target.id}`],
    flows: active.flows
      .slice(-6)
      .map(({ source, target, sourceAddress, targetAddress, protocol, count }) => ({
        source,
        target,
        sourceAddress,
        targetAddress,
        protocol,
        count,
      })),
  });
  assert.equal(
    active.status,
    'running',
    `Live capture must be observed before completion: ${liveEvidence}`,
  );
  assert.ok(
    inventoryObservations([active]).some(
      (flow) =>
        flow.live && flow.source === `local:${source.id}` && flow.target === `local:${target.id}`,
    ),
    `Real flow resolves to the two map nodes: ${liveEvidence}`,
  );
  while (captures.get(capture.id).status === 'running' && Date.now() < deadline) await delay(200);
  const ended = captures.get(capture.id);
  assert.equal(ended.status, 'completed', ended.errors.join('\n'));
  assert.ok(ended.count > 0);
  assert.equal(ended.targets.length, 1);
  assert.equal(ended.files.length, 1);
  assert.ok(ended.bytes <= CAPTURE_LIMIT);
  assert.ok(
    ended.packets.some(
      (packet) =>
        packet.sourceNode === `local:${source.id}` &&
        packet.targetNode === `local:${target.id}` &&
        packet.route.length === 2,
    ),
    'Packet envelope has a real two-edge route',
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'workspace-capture' && event.captureId === capture.id && event.flows?.length,
    ),
    'Live workspace capture event contains observed flows',
  );
  assert.ok(events.some((event) => event.captureId === capture.id && event.status === 'completed'));
  assert.ok(
    inventoryObservations([ended]).every((flow) => !flow.live),
    'Ended capture is historical on the map',
  );
  const { buffer } = await captures.file(capture.id, 0);
  assert.ok(buffer.length > 24);
  assert.ok(
    ['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(
      buffer.subarray(0, 4).toString('hex'),
    ),
  );
  evidence = {
    duration: ended.duration,
    observations: ended.count,
    flows: ended.flows.length,
    pcapBytes: buffer.length,
    eventUpdates: events.length,
    readinessMs,
    requestCount,
  };
  if (process.argv.includes('--ui')) {
    const { serveCaptureUi } = await import('./helpers/capture-ui-server.mjs');
    await serveCaptureUi({
      captures,
      hosts,
      engine,
      source,
      target,
      setEmit: (callback) => {
        uiEmit = callback;
      },
    });
  }
} finally {
  await captures.shutdown();
  const cleanupErrors = [];
  for (const [id, kind] of created) {
    try {
      const container = engine.getContainer(id);
      const info = await container.inspect();
      const labels = info.Config.Labels || {};
      assert.ok(
        kind === 'test'
          ? labels['io.dockertracer.test'] === name
          : labels['io.dockertracer.instance'] === instanceId,
        'Cleanup refuses an unowned container',
      );
      await container.remove({ force: true });
    } catch (error) {
      if (error.statusCode !== 404) cleanupErrors.push(error.message);
    }
  }
  if (network) {
    const info = await network.inspect();
    assert.equal(info.Labels['io.dockertracer.test'], name);
    await network.remove();
  }
  const absolute = path.resolve(dir);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('dtr-capture-cached-'));
  const info = await lstat(absolute);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  await rm(absolute, { recursive: true, force: true });
  assert.deepEqual(cleanupErrors, []);
  assert.deepEqual(
    (await docker.listImages()).map((image) => image.Id).sort(),
    beforeImages,
    'Image set unchanged',
  );
  const remaining = await docker.listContainers({ all: true });
  assert.ok(
    [...beforeContainers].every((id) => remaining.some((c) => c.Id === id)),
    'All pre-existing containers preserved',
  );
  assert.ok(
    remaining.every((c) => !created.has(c.Id)),
    'All owned containers and probes removed',
  );
}
console.log(
  'PASS real cached-image capture, resolved map flow, packet route, live events, PCAP and cleanup:',
  JSON.stringify(evidence),
);
