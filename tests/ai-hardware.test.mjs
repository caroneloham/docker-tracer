import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  discoverAiHardware,
  parseNvidiaInventory,
  parseLocalMounts,
} from '../server/ai-hardware.mjs';
import { aiHostReport, validateAiDeployment } from '../server/ai-infrastructure.mjs';
import {
  defaultAiSettings,
  newAiSecrets,
  buildAiCompose,
  readAiSettings,
} from '../shared/ai-infrastructure.mjs';

const csv =
  '0, GPU-abcd-1234, NVIDIA RTX 5080, 16303, 14336, 0, 591.86\n1, GPU-abcd-5678, "NVIDIA, RTX", 24576, [N/A], [N/A], 591.86\n';
const info = {
  Name: 'ubuntu-client',
  OSType: 'linux',
  OperatingSystem: 'Ubuntu 24.04',
  NCPU: 16,
  MemTotal: 64 * 1024 ** 3,
};
const context = { kind: 'local', socketPath: '/var/run/docker.sock' };
const mounts = [
  '1 0 8:1 / / rw,relatime - ext4 /dev/nvme0n1p1 rw',
  '2 1 8:2 / /mnt/IA\\040data rw,relatime - xfs /dev/sdb1 rw',
  '3 1 0:1 / /proc rw - proc proc rw',
  '4 1 8:3 / /backup ro - ext4 /dev/sdc1 ro',
  '5 1 0:4 / /nas rw - nfs4 server:/nas rw',
  '6 1 8:4 / /boot rw - ext4 /dev/nvme0n1p2 rw',
].join('\n');
const dependencies = {
  platform: 'linux',
  hostname: 'ubuntu-client',
  cpus: () => [{ model: 'AMD EPYC' }],
  totalmem: () => 64 * 1024 ** 3,
  freemem: () => 48 * 1024 ** 3,
  exec: async (command, args, options) => {
    assert.equal(command, 'nvidia-smi');
    assert.equal(args.length, 2);
    assert.equal(options.timeout, 7000);
    assert.equal(options.windowsHide, true);
    return { stdout: csv };
  },
  readFile: async (file) => {
    if (file === '/proc/self/mountinfo') return mounts;
    throw Error('ENOENT');
  },
  statfs: async () => ({ blocks: 200 * 1024 ** 2, bavail: 100 * 1024 ** 2, bsize: 1024 }),
};

test('Matériel : NVIDIA conserve UUID, VRAM réelle, zéro et métriques indisponibles', () => {
  const cards = parseNvidiaInventory(csv);
  assert.equal(cards[0].uuid, 'GPU-abcd-1234');
  assert.equal(cards[0].totalGiB, 15.9);
  assert.equal(cards[0].freeGiB, 14);
  assert.equal(cards[0].utilization, 0);
  assert.equal(cards[1].name, 'NVIDIA, RTX');
  assert.equal(cards[1].freeGiB, null);
  assert.equal(cards[1].utilization, null);
  assert.deepEqual(parseNvidiaInventory('No devices were found'), []);
  assert.throws(() => parseNvidiaInventory('NVIDIA driver error'), /illisible/);
});

test('Matériel : Ubuntu détecte les composants et les disques locaux montés en écriture', async () => {
  assert.deepEqual(
    parseLocalMounts(mounts).map((d) => d.path),
    ['/', '/mnt/IA data'],
  );
  const hardware = await discoverAiHardware(info, context, dependencies);
  assert.equal(hardware.status, 'detected');
  assert.equal(hardware.gpus.length, 2);
  assert.equal(hardware.scope, 'linux-host');
  assert.equal(hardware.totalRamGiB, 64);
  assert.equal(hardware.disks[1].freeGiB, 100);
  assert.equal(hardware.disks[1].device, '/dev/sdb1');
});

test('Matériel : aucune confusion avec un hôte SSH, un moteur différent ou un serveur conteneurisé', async () => {
  const noProbe = {
    ...dependencies,
    exec: async () => {
      assert.fail('La machine locale ne doit pas être sondée');
    },
  };
  for (const [i, c, d] of [
    [info, { kind: 'ssh' }, noProbe],
    [{ ...info, Name: 'other-server' }, context, noProbe],
    [info, context, { ...noProbe, readFile: async () => '' }],
  ]) {
    const h = await discoverAiHardware(i, c, d);
    assert.equal(h.status, 'unavailable');
    assert.deepEqual(h.gpus, []);
  }
});

test('Matériel : Docker Desktop sépare GPU physique, ressources VM et stockage virtuel', async () => {
  const hardware = await discoverAiHardware(
    { ...info, OperatingSystem: 'Docker Desktop' },
    { kind: 'local', socketPath: '//./pipe/dockerDesktopLinuxEngine' },
    { ...dependencies, platform: 'win32' },
  );
  assert.equal(hardware.scope, 'windows-desktop');
  assert.equal(hardware.gpus.length, 2);
  assert.deepEqual(hardware.disks, []);
  const failed = await discoverAiHardware(info, context, {
    ...dependencies,
    exec: async () => {
      throw Error('ENOENT');
    },
  });
  assert.equal(failed.gpuStatus, 'unavailable');
  assert.match(failed.gpuMessage, /indisponible/);
});

const build = (patch = {}) =>
  buildAiCompose({ ...defaultAiSettings(), ramGiB: 64, ...patch }, newAiSecrets(), 'client-ia');
test('Matériel : UUID et budgets deviennent des limites Compose, stockage dédié au projet', () => {
  const c = build({
    gpuIds: ['GPU-abcd-1234'],
    inferenceCpus: 6,
    inferenceRamGiB: 24,
    modelStorageRoot: '/mnt/IA data',
  });
  const model = YAML.parse(c.source);
  assert.equal(model.services.inference.cpus, 6);
  assert.equal(model.services.inference.mem_limit, '24g');
  assert.deepEqual(model.services.inference.deploy.resources.reservations.devices[0].device_ids, [
    'GPU-abcd-1234',
  ]);
  assert.equal(
    model.services.inference.volumes[0].source,
    '/mnt/IA data/docker-tracer/client-ia/models',
  );
  assert.equal(model.services.inference.volumes[0].bind.create_host_path, true);
  assert.equal(model.services.webui.volumes[0], 'webui_data:/app/backend/data');
  assert.equal(readAiSettings(c.source).inferenceRamGiB, 24);
  const roundtrip = buildAiCompose(
    { ...readAiSettings(c.source), inferenceRamGiB: 20 },
    c.variables,
    c.projectName,
    c,
  );
  assert.equal(YAML.parse(roundtrip.source).services.inference.mem_limit, '20g');
  assert.throws(
    () =>
      buildAiCompose(
        { ...readAiSettings(c.source), modelStorageRoot: '/other' },
        c.variables,
        c.projectName,
        c,
      ),
    /migration/,
  );
  for (const path of ['/mnt/../etc', '/tmp/./data', 'C:\\models', '/bad\npath'])
    assert.throws(() => build({ modelStorageRoot: path }));
});

test('Matériel : anciens profils restent éditables sans ajouter des limites implicites', () => {
  const original = build({ startupMinutes: undefined, embeddingAutoUpdate: undefined });
  const changed = buildAiCompose(
    { ...readAiSettings(original.source), httpsPort: 9443 },
    original.variables,
    original.projectName,
    original,
  );
  const model = YAML.parse(changed.source);
  assert.equal(model.services.inference.cpus, undefined);
  assert.equal(model.services.inference.mem_limit, undefined);
  assert.equal(model.services.inference.volumes[0], 'model_cache:/root/.cache/huggingface');
  assert.equal(model.services.inference.environment.VLLM_USE_V2_MODEL_RUNNER, undefined);
  assert.equal(model.services.inference.healthcheck.start_period, '300s');
  assert.equal(changed.waitSeconds, 600);
});

test('IA : premier téléchargement dispose de délais distincts et le cache documentaire est réutilisé', () => {
  const composed = build({ startupMinutes: 20, embeddingAutoUpdate: false });
  const model = YAML.parse(composed.source);
  assert.equal(model.services.inference.healthcheck.start_period, '1200s');
  assert.equal(model.services.webui.healthcheck.start_period, '1200s');
  assert.ok(composed.waitSeconds >= 2 * 1200);
  assert.equal(model.services.webui.environment.RAG_EMBEDDING_MODEL_AUTO_UPDATE, 'false');
  assert.equal(model.services.webui.environment.RAG_EMBEDDING_MODEL_TRUST_REMOTE_CODE, 'false');
  assert.equal(model.services.webui.environment.HF_HUB_OFFLINE, undefined);
  assert.throws(() => build({ startupMinutes: 31 }));
});

test('IA : compatibilité WSL activable sans changer le profil Ubuntu ni perdre les volumes', () => {
  const original = build();
  const windows = buildAiCompose(
    { ...readAiSettings(original.source), wslCompatibility: true, eagerExecution: true },
    original.variables,
    original.projectName,
    original,
  );
  assert.equal(
    YAML.parse(windows.source).services.inference.environment.VLLM_USE_V2_MODEL_RUNNER,
    '0',
  );
  assert.deepEqual(YAML.parse(windows.source).volumes, YAML.parse(original.source).volumes);
  assert.ok(YAML.parse(windows.source).services.inference.command.includes('--enforce-eager'));
  const linux = buildAiCompose(
    { ...readAiSettings(windows.source), wslCompatibility: false, eagerExecution: false },
    windows.variables,
    windows.projectName,
    windows,
  );
  assert.equal(
    YAML.parse(linux.source).services.inference.environment.VLLM_USE_V2_MODEL_RUNNER,
    undefined,
  );
  assert.ok(!YAML.parse(linux.source).services.inference.command.includes('--enforce-eager'));
});

test('IA : modes chat et outils configurent WebUI et vLLM ensemble, anciens profils éditables', () => {
  const original = build({ toolMode: undefined, toolParser: undefined });
  const chat = buildAiCompose(
    { ...readAiSettings(original.source), toolMode: 'chat' },
    original.variables,
    original.projectName,
    original,
  );
  const simple = YAML.parse(chat.source);
  assert.equal(
    JSON.parse(simple.services.webui.environment.DEFAULT_MODEL_METADATA).capabilities.builtin_tools,
    false,
  );
  assert.ok(!simple.services.inference.command.includes('--enable-auto-tool-choice'));
  const native = buildAiCompose(
    { ...readAiSettings(chat.source), toolMode: 'native', toolParser: 'hermes' },
    chat.variables,
    chat.projectName,
    chat,
  );
  const configured = YAML.parse(native.source);
  assert.equal(
    JSON.parse(configured.services.webui.environment.DEFAULT_MODEL_METADATA).capabilities
      .builtin_tools,
    true,
  );
  assert.ok(configured.services.inference.command.includes('--enable-auto-tool-choice'));
  assert.equal(
    configured.services.inference.command.at(
      configured.services.inference.command.indexOf('--tool-call-parser') + 1,
    ),
    'hermes',
  );
  assert.throws(() => build({ toolMode: 'native', toolParser: undefined }));
  assert.throws(() => build({ toolMode: 'native', toolParser: '--unsafe value' }));
  assert.throws(() =>
    build({ toolMode: 'chat', tools: [{ name: 'API', url: 'http://internal:3000' }] }),
  );
});

test('Matériel : dépassement CPU/RAM refusé avant déploiement sur le vrai moteur cible', async () => {
  const engine = {
    info: async () => ({ ...info, NCPU: 4, MemTotal: 16 * 1024 ** 3 }),
    listContainers: async () => [],
  };
  await assert.rejects(validateAiDeployment(build({ inferenceCpus: 6 }), engine), /4 CPU/);
  await assert.rejects(validateAiDeployment(build({ inferenceRamGiB: 18 }), engine), /limite RAM/);
  await validateAiDeployment(build({ inferenceCpus: 4, inferenceRamGiB: 16 }), engine);
  await validateAiDeployment(build({ inferenceCpus: 2, inferenceRamGiB: 8 }), engine);
  assert.throws(() => build({ inferenceRamGiB: 4, shmGiB: 4 }), /mémoire partagée/);
  const r = await aiHostReport(engine, { kind: 'ssh' });
  assert.equal(r.cpus, 4);
  assert.equal(r.ramGiB, 16);
  assert.equal(r.hardware.status, 'unavailable');
});
