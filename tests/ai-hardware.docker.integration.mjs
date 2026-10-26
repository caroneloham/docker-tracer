// Read-only GPU query in one disposable container. No model or image is downloaded.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { docker, decodeDockerLog } from '../server/docker.mjs';
import { aiHostReport } from '../server/ai-infrastructure.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createComposeRunner } from '../server/compose-runner.mjs';
import { buildAiCompose, defaultAiSettings, newAiSecrets } from '../shared/ai-infrastructure.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-ai-hardware-'));
const name = 'dtr-hardware-' + Date.now().toString(36);
const filters = { label: ['com.docker.compose.project=' + name] };
let runner;
try {
  const report = await aiHostReport(docker, { kind: 'local', socketPath: docker.modem.socketPath });
  assert.equal(
    report.hardware.gpuStatus,
    'detected',
    'Ce test nécessite une carte NVIDIA détectée sur cette machine.',
  );
  const gpu = report.hardware.gpus[0];
  const image = 'ollama/ollama:latest';
  await docker.getImage(image).inspect();
  runner = createComposeRunner({
    dataDir: dir,
    hosts: new HostRegistry(await openWorkspaceStore(dir), docker),
  });
  const settings = {
    ...defaultAiSettings(),
    gpuIds: [gpu.uuid],
    ramGiB: report.ramGiB,
    inferenceCpus: 2,
    inferenceRamGiB: 8,
    vramGiB: gpu.totalGiB,
  };
  const original = buildAiCompose(settings, newAiSecrets(), name);
  await runner.withProject(original, 'local', async ({ run }) => {
    const m = JSON.parse((await run(['config', '--format', 'json'], { json: true })).stdout);
    assert.equal(m.services.inference.cpus, 2);
    assert.equal(Number(m.services.inference.mem_limit), 8 * 1024 ** 3);
    assert.deepEqual(m.services.inference.deploy.resources.reservations.devices[0].device_ids, [
      gpu.uuid,
    ]);
  });
  // Verify the Linux storage path using Compose's parser, without mounting a fake path on this Windows test PC.
  const diskProfile = buildAiCompose(
    { ...settings, modelStorageRoot: '/mnt/ai models' },
    original.variables,
    name,
  );
  await runner.withProject(diskProfile, 'local', async ({ run }) => {
    const m = JSON.parse((await run(['config', '--format', 'json'], { json: true })).stdout);
    assert.equal(
      m.services.inference.volumes[0].source,
      `/mnt/ai models/docker-tracer/${name}/models`,
    );
  });
  const service = YAML.parse(original.source).services.inference;
  const source = YAML.stringify({
    services: {
      probe: {
        image,
        pull_policy: 'never',
        entrypoint: ['nvidia-smi'],
        command: ['--query-gpu=uuid', '--format=csv,noheader'],
        cpus: service.cpus,
        mem_limit: service.mem_limit,
        deploy: service.deploy,
        network_mode: 'none',
        read_only: true,
        cap_drop: ['ALL'],
        restart: 'no',
      },
    },
  });
  await runner.withProject({ ...original, source }, 'local', async ({ run }) => {
    await run(['up', '-d', '--pull', 'never']);
  });
  const entries = await docker.listContainers({ all: true, filters });
  assert.equal(entries.length, 1);
  const container = docker.getContainer(entries[0].Id);
  const finished = await container.wait({ abortSignal: AbortSignal.timeout(15000) });
  const output = decodeDockerLog(await container.logs({ stdout: true, stderr: true })).trim();
  assert.equal(finished.StatusCode, 0, output);
  assert.equal(output, gpu.uuid, 'Seul le GPU sélectionné doit être visible dans la sonde.');
  const inspected = await container.inspect();
  assert.equal(inspected.HostConfig.NanoCpus, 2e9);
  assert.equal(inspected.HostConfig.Memory, 8 * 1024 ** 3);
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  console.log(
    `GPU réel ${gpu.name} sélectionné par UUID dans Docker ; limites 2 CPU / 8 Gio observées. Chemin de stockage Linux accepté par Compose. Aucune inférence exécutée.`,
  );
} finally {
  await runner?.shutdown();
  for (const c of await docker.listContainers({ all: true, filters }))
    await docker.getContainer(c.Id).remove({ force: true });
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-ai-hardware-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Sonde GPU et fichiers temporaires du test retirés.');
}
