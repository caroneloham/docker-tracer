import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { aiComposeModel, defaultAiSettings } from '../shared/ai-infrastructure.mjs';

// Importing the existing workspace API also constructs its default Docker client.
// A fake explicit socket avoids invoking Docker CLI context detection; all requests
// below use a strict mock and never connect to this socket or a Docker engine.
const previousDockerHost = process.env.DOCKER_HOST;
process.env.DOCKER_HOST = 'npipe:////./pipe/docker-tracer-unit-test-unused';
let mountWorkspaceApi;
try {
  ({ mountWorkspaceApi } = await import('../server/workspace-api.mjs'));
} finally {
  if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = previousDockerHost;
}

test('API stockage IA : prévisualisation bornée, sans secrets, profils actifs et lecture seule', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-storage-api-unit-')),
    app = express(),
    calls = [],
    root = 'C:\\Users\\unit\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx',
    settings = defaultAiSettings(),
    source = YAML.stringify(aiComposeModel(settings, 'storage-api'));
  let freeGiB = 30,
    statfsCalls = 0;
  const fakeEngine = new Proxy(
    {
      modem: { socketPath: '//./pipe/dockerDesktopLinuxEngine' },
      info: async () => {
        calls.push('info');
        return { Name: 'docker-desktop', OSType: 'linux', OperatingSystem: 'Docker Desktop' };
      },
      listImages: async (options) => {
        calls.push('listImages');
        assert.deepEqual(options, { all: true });
        return [];
      },
    },
    {
      get(target, key) {
        if (key === 'then') return undefined;
        if (key in target) return target[key];
        throw Error(`Forbidden Docker operation in read-only test: ${String(key)}`);
      },
    },
  );
  const absent = () => Object.assign(Error('absent'), { code: 'ENOENT' });
  app.use(express.json({ limit: '4mb' }));
  const workspace = await mountWorkspaceApi(app, {
      dataDir: dir,
      localDocker: fakeEngine,
      emit: () => {},
      labBusy: () => true,
      storageDependencies: {
        platform: 'win32',
        hostname: 'unit',
        env: {
          APPDATA: 'C:\\Users\\unit\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\unit\\AppData\\Local',
        },
        readFile: async (file) => {
          if (file.endsWith('settings-store.json')) return '{}';
          throw absent();
        },
        stat: async (file) => {
          if (file === root) return { isFile: () => true };
          throw absent();
        },
        realpath: async (file) => file,
        statfs: async () => {
          statfsCalls++;
          return {
            bsize: 4096,
            blocks: (512 * 1024 ** 3) / 4096,
            bavail: (freeGiB * 1024 ** 3) / 4096,
          };
        },
      },
    }),
    server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await workspace.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const originalStore = await readFile(path.join(dir, 'workspace-v1.json'), 'utf8'),
    url = `http://127.0.0.1:${server.address().port}`,
    post = async (body, host = 'local') => {
      const response = await fetch(`${url}/api/hosts/${host}/ai-storage-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
  const insufficient = await post({ source });
  assert.equal(insufficient.status, 200, 'Read-only preview is allowed even while the lab is busy');
  assert.equal(insufficient.body.status, 'insufficient');
  assert.equal(insufficient.body.storage.availableGiB, 30);
  assert.equal(insufficient.body.estimate.imagesGiB, 40.7);
  assert.ok(Date.parse(insufficient.body.checkedAt));
  assert.ok(!JSON.stringify(insufficient.body).includes('AI_ADMIN_PASSWORD'));

  const model = YAML.parse(source);
  model.services.inference.profiles = ['gpu'];
  model.services.extra = { image: 'private/large:latest', profiles: ['optional'] };
  const profiledSource = YAML.stringify(model),
    ready = await post({ source: profiledSource });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.estimate.imagesGiB, 8.7);
  assert.equal(ready.body.estimate.modelGiB, 0);
  assert.ok(!ready.body.estimate.missingImages.includes(settings.images.vllm));
  assert.equal(
    (await post({ source: profiledSource, profiles: ['gpu'] })).body.status,
    'insufficient',
  );
  freeGiB = 200;
  const unknown = await post({ source: profiledSource, profiles: ['optional'] });
  assert.equal(unknown.body.status, 'unknown');
  assert.ok(unknown.body.estimate.unknownImages.includes('private/large:latest'));

  const readCount = calls.length;
  for (const body of [
    { source: 'services: {web: {image: nginx}}' },
    { source: 'services: [' },
    { source: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { source, profiles: 'gpu' },
    { source, profiles: Array(51).fill('gpu') },
    { source, profiles: ['x'.repeat(129)] },
    { source, variables: { AI_ADMIN_PASSWORD: 'not-needed' } },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal(calls.length, readCount, 'Invalid requests never contact Docker');
  assert.equal((await post({ source }, 'missing-host')).status, 404);
  assert.equal(calls.length, readCount);

  const profile = workspace.hosts.profile.bind(workspace.hosts),
    client = workspace.hosts.client.bind(workspace.hosts);
  workspace.hosts.profile = (host) =>
    host === 'remote-unit' ? { id: host, kind: 'ssh' } : profile(host);
  workspace.hosts.client = async (host) => (host === 'remote-unit' ? fakeEngine : client(host));
  const previousMeasurements = statfsCalls,
    remote = await post({ source }, 'remote-unit');
  assert.equal(remote.status, 200);
  assert.equal(remote.body.status, 'unknown');
  assert.equal(remote.body.storage.status, 'unavailable');
  assert.equal(
    statfsCalls,
    previousMeasurements,
    'A remote host never receives local disk measurements',
  );
  assert.ok(calls.every((call) => ['info', 'listImages'].includes(call)));
  assert.equal(
    await readFile(path.join(dir, 'workspace-v1.json'), 'utf8'),
    originalStore,
    'Preview does not persist or deploy anything',
  );
});
