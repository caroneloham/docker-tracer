import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { ContainerResourcesService } from '../server/container-resources.mjs';
import {
  cpuSetCount,
  memoryBytes,
  patchComposeResources,
  composeGpuState,
  vllmFraction,
  GiB,
} from '../shared/container-resources.mjs';

const ID = 'a'.repeat(64);
function fixture() {
  let now = 1000,
    kind = 'local';
  const info = {
    Id: ID,
    Name: '/inference',
    State: { Running: true },
    Config: { Image: 'vllm/vllm-openai:test', Labels: {} },
    HostConfig: {
      NanoCpus: 1e9,
      Memory: GiB,
      MemorySwap: 2 * GiB,
      MemoryReservation: 0,
      DeviceRequests: [{ Driver: 'nvidia', Count: -1 }],
      RestartPolicy: { Name: 'unless-stopped' },
    },
  };
  const writes = [],
    contexts = [];
  const container = {
    inspect: async () => structuredClone(info),
    stats: async () => ({
      memory_stats: { usage: 123 },
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
    }),
    update: async (value) => {
      writes.push(value);
      Object.assign(info.HostConfig, value);
      return { Warnings: [] };
    },
  };
  const docker = {
    getContainer: (id) => {
      assert.equal(id, ID);
      return container;
    },
    info: async () => ({
      OSType: 'linux',
      NCPU: 4,
      MemTotal: 8 * GiB,
      ID: 'engine1',
      Name: 'server',
      MemoryLimit: true,
      CpuCfsQuota: true,
    }),
    modem: { socketPath: '/var/run/docker.sock' },
  };
  const hosts = { profile: () => ({ name: 'Serveur', kind }), client: async () => docker };
  const service = new ContainerResourcesService(hosts, {
    now: () => now,
    hardware: async (_info, context) => {
      contexts.push(context);
      return { status: context.kind === 'local' ? 'detected' : 'unavailable', gpus: [] };
    },
  });
  return {
    service,
    info,
    writes,
    contexts,
    setNow: (value) => {
      now = value;
    },
    remote: () => {
      kind = 'ssh';
    },
    container,
  };
}
test('resource update preserves swap, GPU and restart policy and requires target preview', async () => {
  const f = fixture(),
    before = await f.service.read('local', ID);
  const preview = await f.service.preview('local', ID, {
    expectedName: 'inference',
    version: before.version,
    cpus: 2,
    memoryBytes: 1.5 * GiB,
  });
  assert.equal(f.writes.length, 0);
  const after = await f.service.apply('local', ID, {
    token: preview.token,
    expectedName: 'inference',
  });
  assert.deepEqual(f.writes, [{ NanoCpus: 2e9, Memory: 1.5 * GiB }]);
  assert.equal(after.resources.limits.memorySwap, 2 * GiB);
  assert.deepEqual(f.info.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  assert.equal(after.resources.limits.devices[0].Count, -1);
  await assert.rejects(
    f.service.apply('local', ID, { token: preview.token, expectedName: 'inference' }),
    /expiré/,
  );
});
test('resources reject changed name/configuration, expired previews and other targets', async () => {
  const f = fixture(),
    read = await f.service.read('local', ID),
    body = { expectedName: 'inference', version: read.version, cpus: 2 };
  await assert.rejects(
    f.service.preview('local', ID, { ...body, expectedName: 'different' }),
    /cible/,
  );
  const preview = await f.service.preview('local', ID, body);
  await assert.rejects(
    f.service.apply('remote', ID, { token: preview.token, expectedName: 'inference' }),
    /cible/,
  );
  f.info.HostConfig.RestartPolicy.Name = 'always';
  await assert.rejects(
    f.service.apply('local', ID, { token: preview.token, expectedName: 'inference' }),
    /changé/,
  );
  f.setNow(122000);
  await assert.rejects(
    f.service.apply('local', ID, { token: preview.token, expectedName: 'inference' }),
    /expiré/,
  );
  assert.equal(f.writes.length, 0);
});
test('resources enforce host capacity, cpuset, reservations, swap and strict fields', async () => {
  const f = fixture();
  f.info.HostConfig.CpusetCpus = '0,2';
  f.info.HostConfig.MemoryReservation = 128 * 1024 ** 2;
  const read = await f.service.read('local', ID),
    body = { expectedName: 'inference', version: read.version };
  for (const values of [
    { cpus: 3 },
    { cpus: 0 },
    { memoryBytes: 9 * GiB },
    { memoryBytes: -1 },
    { memoryBytes: 1 },
    { memoryBytes: 64 * 1024 ** 2 },
    { memoryBytes: 3 * GiB },
    { cpus: 1, DeviceRequests: [] },
  ])
    await assert.rejects(f.service.preview('local', ID, { ...body, ...values }));
  assert.equal(f.writes.length, 0);
  assert.equal(cpuSetCount('0-3,2,7'), 5);
  assert.equal(cpuSetCount('bad'), null);
});
test('legacy CPU quota uses its existing period and remote discovery receives remote context', async () => {
  const f = fixture();
  Object.assign(f.info.HostConfig, { NanoCpus: 0, CpuPeriod: 50000, CpuQuota: 50000 });
  f.remote();
  const read = await f.service.read('ssh-server', ID);
  assert.equal(f.contexts[0].kind, 'ssh');
  const preview = await f.service.preview('ssh-server', ID, {
    expectedName: 'inference',
    version: read.version,
    cpus: 1.5,
  });
  await f.service.apply('ssh-server', ID, { token: preview.token, expectedName: 'inference' });
  assert.deepEqual(f.writes[0], { CpuPeriod: 50000, CpuQuota: 75000 });
});
test('failed stats stay unavailable and observed CPU remains a measured value', async () => {
  const f = fixture();
  assert.equal((await f.service.read('local', ID)).usage.cpuPercent, 80);
  f.container.stats = async () => {
    throw Error('offline');
  };
  assert.equal((await f.service.read('local', ID)).usage, null);
});
const host = {
  cpus: 8,
  memoryBytes: 32 * GiB,
  gpus: [
    { index: '0', uuid: 'GPU-one' },
    { index: '1', uuid: 'GPU-two' },
  ],
};
const source = `# retained\nservices:\n  inference:\n    image: vllm/vllm-openai:test\n    cpus: 1\n    mem_limit: 1g\n    environment:\n      TOKEN: preserved\n    command: [--model, org/custom, --gpu-memory-utilization=0.8, --max-model-len, '8192']\n    deploy:\n      replicas: 2\n      resources:\n        limits: {cpus: '1', memory: 1g}\n        reservations:\n          memory: 128m\n          devices:\n            - {driver: nvidia, count: all, capabilities: [gpu], options: {some: preserved}}\n            - {driver: vendor, capabilities: [tpu], device_ids: ['external']}\n    volumes: [data:/data]\n  untouched:\n    image: redis:alpine\nvolumes:\n  data: {}\n`;
test('Compose GPU and limits preserve unrelated fields and synchronize existing deploy limits', () => {
  const next = patchComposeResources(
      source,
      'inference',
      {
        cpus: 4,
        memoryBytes: 8 * GiB,
        gpu: { mode: 'selected', ids: ['GPU-two'] },
        vllmFraction: 0.7,
      },
      host,
    ),
    model = YAML.parse(next),
    service = model.services.inference;
  assert.match(next, /^# retained/);
  assert.deepEqual(model.services.untouched, { image: 'redis:alpine' });
  assert.equal(service.environment.TOKEN, 'preserved');
  assert.equal(service.deploy.replicas, 2);
  assert.deepEqual(service.deploy.resources.limits, { cpus: 4, memory: 8 * GiB });
  assert.equal(service.deploy.resources.reservations.memory, '128m');
  assert.deepEqual(service.deploy.resources.reservations.devices[0], {
    driver: 'vendor',
    capabilities: ['tpu'],
    device_ids: ['external'],
  });
  assert.deepEqual(service.deploy.resources.reservations.devices[1], {
    driver: 'nvidia',
    device_ids: ['GPU-two'],
    capabilities: ['gpu'],
    options: { some: 'preserved' },
  });
  assert.deepEqual(service.command, [
    '--model',
    'org/custom',
    '--gpu-memory-utilization=0.7',
    '--max-model-len',
    '8192',
  ]);
  assert.deepEqual(service.volumes, ['data:/data']);
});
test('Compose GPU none removes only NVIDIA devices, and keep does not rewrite GPU definitions', () => {
  const none = YAML.parse(
    patchComposeResources(source, 'inference', { gpu: { mode: 'none' } }, host),
  );
  assert.equal(none.services.inference.deploy.resources.reservations.devices.length, 1);
  const keep = YAML.parse(
    patchComposeResources(source, 'inference', { cpus: 2, gpu: { mode: 'keep' } }, host),
  );
  assert.deepEqual(
    keep.services.inference.deploy.resources.reservations.devices,
    YAML.parse(source).services.inference.deploy.resources.reservations.devices,
  );
});
test('Compose supports gpus shorthand, preserves non-NVIDIA devices, and rejects unknown IDs', () => {
  const text = 'services:\n  ai:\n    image: vllm/vllm-openai:test\n    gpus: all\n';
  const next = YAML.parse(
    patchComposeResources(text, 'ai', { gpu: { mode: 'selected', ids: ['GPU-one'] } }, host),
  );
  assert.deepEqual(next.services.ai.gpus, [
    { driver: 'nvidia', capabilities: ['gpu'], device_ids: ['GPU-one'] },
  ]);
  assert.equal(next.services.ai.deploy, undefined);
  assert.throws(
    () => patchComposeResources(text, 'ai', { gpu: { mode: 'selected', ids: ['unknown'] } }, host),
    /détectée/,
  );
  assert.throws(
    () => patchComposeResources(text, 'ai', { gpu: { mode: 'all' } }, { ...host, gpus: [] }),
    /détectée/,
  );
});
test('Compose resource edits do not change services sharing YAML anchors', () => {
  const text = 'services:\n  ai: &shared\n    image: nginx:alpine\n    cpus: 1\n  other: *shared\n';
  const next = YAML.parse(patchComposeResources(text, 'ai', { cpus: 2 }, host));
  assert.equal(next.services.ai.cpus, 2);
  assert.equal(next.services.other.cpus, 1);
});
test('vLLM flags are token-aware and ambiguous command strings are left for advanced editing', () => {
  assert.deepEqual(vllmFraction({ image: 'vllm/test', command: '--model org/x' }), {
    editable: false,
  });
  assert.equal(
    vllmFraction({ image: 'vllm/test', command: ['--gpu-memory-utilization', '0.8'] }).value,
    0.8,
  );
  assert.equal(
    vllmFraction({
      image: 'vllm/test',
      command: ['--gpu-memory-utilization', '0.8', '--gpu-memory-utilization=0.7'],
    }).editable,
    false,
  );
  assert.throws(
    () => patchComposeResources(source, 'inference', { vllmFraction: 1 }, host),
    /mémoire/,
  );
  assert.equal(memoryBytes('512m'), 512 * 1024 ** 2);
  assert.equal(memoryBytes('512'), 512);
  assert.equal(memoryBytes('${RAM}'), null);
  assert.equal(
    composeGpuState({
      deploy: {
        resources: { reservations: { devices: [{ driver: 'nvidia' }, { driver: 'nvidia' }] } },
      },
    }).editable,
    false,
  );
  assert.equal(
    composeGpuState({
      gpus: 'all',
      deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 'all' }] } } },
    }).editable,
    false,
  );
  assert.equal(vllmFraction({ image: 'vllm/test' }).editable, false);
});
