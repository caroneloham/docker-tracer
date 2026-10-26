// Validate the generated AI profile with cached components only. This does not
// stand in for a real Open WebUI/vLLM deployment or a data migration test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import tar from 'tar-stream';
import YAML from 'yaml';
import { docker } from '../server/docker.mjs';
import { execTool } from '../server/engine-tools.mjs';
import { aiComposeModel, defaultAiSettings } from '../shared/ai-infrastructure.mjs';
import { prepareFreshAiRedundancy } from '../shared/ai-redundancy-profile.mjs';

const label = `dtr-ai-components-${Date.now()}`;
const owned = [];
const report = {
  checkedAt: new Date().toISOString(),
  downloads: 0,
  fullAiRuntimeTested: false,
  checks: [],
};
const packFile = (name, content) => {
  const pack = tar.pack();
  pack.entry({ name, mode: 0o600 }, content);
  pack.finalize();
  return pack;
};
const hostConfig = (extra = {}) => ({
  NetworkMode: 'none',
  Memory: 256 * 1024 * 1024,
  NanoCpus: 500000000,
  LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
  ...extra,
});

try {
  const base = aiComposeModel(defaultAiSettings(), 'test-ai');
  const prepared = prepareFreshAiRedundancy(YAML.stringify(base), { replicas: 2 });
  assert.deepEqual(prepared.blockers, []);
  const model = YAML.parse(prepared.source);
  const config = spawnSync(
    'docker',
    ['compose', '-p', label, '-f', '-', 'config', '--format', 'json'],
    { input: prepared.source, encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  assert.equal(config.status, 0, config.stderr || config.error?.message);
  const canonical = JSON.parse(config.stdout);
  assert.equal(Object.keys(canonical.services).length, 7);
  assert.equal(canonical.services['webui-2'].environment.ENABLE_DB_MIGRATIONS, 'false');
  report.checks.push('Compose accepts the generated seven-service configuration');

  // Inspect first: Dockerode createContainer never downloads a missing image.
  await docker.getImage(model.services.caddy.image).inspect();
  await docker.getImage(model.services.qdrant.image).inspect();
  const caddy = await docker.createContainer({
    name: `${label}-caddy`,
    Image: model.services.caddy.image,
    Entrypoint: ['caddy'],
    Cmd: ['validate', '--config', '/tmp/Caddyfile', '--adapter', 'caddyfile'],
    Labels: { 'io.docker-tracer.test': label },
    HostConfig: hostConfig({ Tmpfs: { '/data': 'size=16m', '/config': 'size=16m' } }),
  });
  owned.push(caddy);
  await caddy.putArchive(packFile('Caddyfile', model.configs.ai_caddyfile.content), { path: '/tmp' });
  await caddy.start();
  const result = await caddy.wait();
  const logs = await caddy.logs({ stdout: true, stderr: true });
  assert.equal(result.StatusCode, 0, logs.toString());
  report.checks.push('Cached Caddy validates the generated TLS and multi-WebUI route');

  const qdrant = await docker.createContainer({
    name: `${label}-qdrant`,
    Image: model.services.qdrant.image,
    Labels: { 'io.docker-tracer.test': label },
    HostConfig: hostConfig({ Tmpfs: { '/qdrant/storage': 'size=128m' } }),
  });
  owned.push(qdrant);
  await qdrant.start();
  const command = model.services.qdrant.healthcheck.test.slice(1);
  let probe;
  for (let attempt = 0; attempt < 20; attempt++) {
    probe = await execTool(docker, qdrant, command, 4000);
    if (probe.exitCode === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(probe.exitCode, 0, probe.output);
  report.checks.push('Exact generated Qdrant HTTP readiness command succeeds in the cached image');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  throw error;
} finally {
  for (const container of owned.reverse()) await container.remove({ force: true, v: true });
  const leftovers = await docker.listContainers({
    all: true,
    filters: { label: [`io.docker-tracer.test=${label}`] },
  });
  report.cleanup = leftovers.length === 0;
  await writeFile(
    new URL('../output/ai-redundancy-components-real-test.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  assert.equal(report.cleanup, true);
  console.log(JSON.stringify(report, null, 2));
}
