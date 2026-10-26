import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  discoverAiStorage,
  assertAiStorageReserve,
  estimateAiStorageRequirements,
  prepareAiStoragePreview,
  readAiStoragePreview,
} from '../server/ai-storage.mjs';
import { validateAiDeployment, aiHostReport } from '../server/ai-infrastructure.mjs';
import { defaultAiSettings, newAiSecrets, buildAiCompose } from '../shared/ai-infrastructure.mjs';
import YAML from 'yaml';

const windowsInfo = {
    OSType: 'linux',
    OperatingSystem: 'Docker Desktop',
    Name: 'docker-desktop',
    DockerRootDir: '/var/lib/docker',
    NCPU: 8,
    MemTotal: 16 * 1024 ** 3,
  },
  engine = { modem: { socketPath: '//./pipe/dockerDesktopLinuxEngine', protocol: 'http' } },
  windowsEnv = {
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  },
  defaultVhd = path.win32.join(
    windowsEnv.LOCALAPPDATA,
    'Docker',
    'wsl',
    'disk',
    'docker_data.vhdx',
  ),
  notFound = () => Object.assign(Error('Not found'), { code: 'ENOENT' }),
  fsStats = (freeGiB = 6) => ({
    bsize: 4096n,
    blocks: BigInt((512 * 1024 ** 3) / 4096),
    bavail: BigInt((freeGiB * 1024 ** 3) / 4096),
  });

test('Stockage IA : un modèle ou montage modifié ne réutilise pas l’ancienne taille', async () => {
  const compose = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'changed-model'),
    model = YAML.parse(compose.source);
  model.services.inference.command[1] = 'private/unknown-large-model';
  const plan = prepareAiStoragePreview({ source: YAML.stringify(model) }),
    result = await readAiStoragePreview(
      plan,
      {
        ...engine,
        info: async () => windowsInfo,
        listImages: async () => [],
      },
      {},
      { storageDependencies: windowsDependencies({ freeGiB: 200 }) },
    );
  assert.equal(result.status, 'unknown');
  assert.equal(result.estimate.modelGiB, null);
  assert.equal(result.estimate.complete, false);
  assert.equal(result.estimate.reserveGiB, 10);
  assert.match(result.estimate.incompleteReasons.join(' '), /ancien.*estimation/);
  assert.throws(
    () =>
      assertAiStorageReserve({ status: 'detected', availableGiB: 1, path: 'C:' }, result.estimate),
    /insuffisant/,
  );
});

function windowsDependencies({
  settings = {},
  files = [defaultVhd],
  freeGiB = 6,
  resolve = (file) => file,
} = {}) {
  const calls = [];
  return {
    calls,
    platform: 'win32',
    hostname: 'desktop',
    env: windowsEnv,
    readFile: async (file) => {
      calls.push(['read', file]);
      if (file.endsWith('settings-store.json')) return JSON.stringify(settings);
      throw notFound();
    },
    stat: async (file) => {
      calls.push(['stat', file]);
      if (!files.includes(file)) throw notFound();
      return { isFile: () => true };
    },
    realpath: async (file) => resolve(file),
    statfs: async (file) => {
      calls.push(['statfs', file]);
      return fsStats(freeGiB);
    },
  };
}

test('Stockage IA : Docker Desktop mesure le disque Windows portant le VHD, pas le disque Linux virtuel', async () => {
  const dependencies = windowsDependencies(),
    result = await discoverAiStorage(engine, windowsInfo, {}, dependencies);
  assert.equal(result.status, 'detected');
  assert.equal(result.scope, 'windows-desktop-host');
  assert.equal(result.availableGiB, 6);
  assert.equal(result.totalGiB, 512);
  assert.equal(result.sufficient, false);
  assert.equal(result.dockerStoragePath, defaultVhd);
  assert.deepEqual(
    dependencies.calls.filter(([type]) => type === 'statfs'),
    [['statfs', path.win32.dirname(defaultVhd)]],
  );
  assert.throws(() => assertAiStorageReserve(result), /Espace disque insuffisant.*Libère.*déplace/);
});

test('Stockage IA : dossier Docker configuré et liens résolus déterminent le vrai disque, sans revenir à C:', async () => {
  const configured = 'D:\\DockerData',
    vhd = path.win32.join(configured, 'disk', 'docker_data.vhdx'),
    actual = 'E:\\MountedDocker\\docker_data.vhdx',
    dependencies = windowsDependencies({
      settings: { dataFolder: configured },
      files: [vhd, defaultVhd],
      freeGiB: 200,
      resolve: () => actual,
    }),
    result = await discoverAiStorage(engine, windowsInfo, {}, dependencies);
  assert.equal(result.status, 'detected');
  assert.equal(result.path, 'E:\\MountedDocker');
  assert.equal(result.availableGiB, 200);
  assert.ok(!dependencies.calls.some(([, file]) => file === defaultVhd));
  const missing = await discoverAiStorage(
    engine,
    windowsInfo,
    {},
    windowsDependencies({ settings: { dataFolder: configured } }),
  );
  assert.equal(missing.status, 'unavailable');
});

test('Stockage IA : disque absent, multiple, chemin distant et settings illisibles restent indisponibles', async () => {
  const alternatives = path.win32.join(
    windowsEnv.LOCALAPPDATA,
    'Docker',
    'wsl',
    'data',
    'ext4.vhdx',
  );
  for (const dependencies of [
    windowsDependencies({ files: [] }),
    windowsDependencies({ files: [defaultVhd, alternatives] }),
    windowsDependencies({ settings: { dataFolder: '\\\\nas\\docker' } }),
    { ...windowsDependencies(), readFile: async () => '{invalid-json' },
  ]) {
    assert.equal(
      (await discoverAiStorage(engine, windowsInfo, {}, dependencies)).status,
      'unavailable',
    );
    assert.ok(!dependencies.calls.some(([type]) => type === 'statfs'));
  }
});

test('Stockage IA : SSH et transports ambigus ne reçoivent aucune capacité locale même avec un pipe hérité', async () => {
  for (const [candidateEngine, context] of [
    [engine, { kind: 'ssh' }],
    [{ modem: { ...engine.modem, host: 'remote-client' } }, {}],
    [{ modem: { ...engine.modem, protocol: 'ssh' } }, {}],
    [{ modem: { socketPath: '//./pipe/unrelated' } }, {}],
  ]) {
    const dependencies = windowsDependencies(),
      result = await discoverAiStorage(candidateEngine, windowsInfo, context, dependencies);
    assert.equal(result.status, 'unavailable');
    assert.equal(dependencies.calls.length, 0);
  }
});

function linuxDependencies(overrides = {}) {
  return {
    platform: 'linux',
    hostname: 'ubuntu-client',
    readFile: async () => {
      throw notFound();
    },
    stat: async () => ({ isSocket: () => true, isDirectory: () => true }),
    realpath: async (file) => file,
    statfs: async (file) => {
      assert.equal(file, '/srv/docker');
      return fsStats(80);
    },
    ...overrides,
  };
}
const linuxInfo = {
    ...windowsInfo,
    Name: 'ubuntu-client',
    OperatingSystem: 'Ubuntu 24.04',
    DockerRootDir: '/srv/docker',
  },
  linuxEngine = { modem: { socketPath: '/var/run/docker.sock' } };
test('Stockage IA : Ubuntu natif mesure DockerRootDir après vérification du nom et du socket local', async () => {
  const report = await discoverAiStorage(linuxEngine, linuxInfo, {}, linuxDependencies());
  assert.equal(report.status, 'detected');
  assert.equal(report.scope, 'linux-host');
  assert.equal(report.path, '/srv/docker');
  assert.equal(report.availableGiB, 80);
  for (const [info, dependencies] of [
    [{ ...linuxInfo, Name: 'other-server' }, linuxDependencies()],
    [linuxInfo, linuxDependencies({ readFile: async () => '' })],
    [linuxInfo, linuxDependencies({ stat: async () => ({ isSocket: () => false }) })],
  ])
    assert.equal(
      (await discoverAiStorage(linuxEngine, info, {}, dependencies)).status,
      'unavailable',
    );
});

test('Stockage IA : erreurs de mesure ne deviennent jamais une taille virtuelle ou zéro inventé', async () => {
  for (const statfs of [
    async () => {
      throw Error('Access denied');
    },
    async () => ({ bsize: 4096, blocks: 0, bavail: -1 }),
  ]) {
    const report = await discoverAiStorage(
      linuxEngine,
      linuxInfo,
      {},
      linuxDependencies({ statfs }),
    );
    assert.equal(report.status, 'unavailable');
    assert.equal(report.availableGiB, undefined);
  }
});

test('Stockage IA : images absentes, poids et réserve sont comptés ; cache exact tags et digests réutilisé', () => {
  const settings = defaultAiSettings(),
    absent = estimateAiStorageRequirements(settings, []),
    cachedImages = Object.values(settings.images).map((reference) => ({ RepoTags: [reference] })),
    cached = estimateAiStorageRequirements(settings, cachedImages);
  assert.equal(absent.imagesGiB, 40.7);
  assert.ok(absent.requiredGiB > 50);
  assert.equal(cached.imagesGiB, 0);
  assert.equal(cached.requiredGiB, Math.ceil((10 + cached.modelGiB) * 10) / 10);
  assert.equal(cached.modelCacheVerified, false);
  assert.equal(absent.complete, true);
  const digest = 'private/inference@sha256:abcdef',
    digestCached = estimateAiStorageRequirements(settings, [{ RepoDigests: [digest] }], [digest]);
  assert.equal(digestCached.imagesGiB, 0);
  assert.equal(digestCached.complete, true);
  assert.equal(estimateAiStorageRequirements(settings, [], [digest]).complete, false);
  assert.equal(estimateAiStorageRequirements(settings, null).complete, false);
  const external = {
    ...settings,
    database: { ...settings.database, mode: 'external', host: 'db.client.internal' },
  };
  assert.equal(estimateAiStorageRequirements(external, []).imagesGiB, 40.2);
});

test('Stockage IA : validation refuse 30 Gio quand les grosses images manquent, avant toute étape suivante', async () => {
  const settings = defaultAiSettings(),
    compose = buildAiCompose(settings, newAiSecrets(), 'storage-test'),
    dependencies = windowsDependencies({ freeGiB: 30 });
  let containersRead = false;
  const mockEngine = {
    ...engine,
    info: async () => windowsInfo,
    listImages: async (options) => {
      assert.equal(options.all, true);
      return [];
    },
    listContainers: async () => {
      containersRead = true;
      return [];
    },
  };
  await assert.rejects(
    validateAiDeployment(compose, mockEngine, { storageDependencies: dependencies }),
    /Espace disque insuffisant.*Place à prévoir:|Espace disque insuffisant.*images absentes/,
  );
  assert.equal(containersRead, false);
  await validateAiDeployment(
    compose,
    {
      ...mockEngine,
      listImages: async () =>
        Object.values(settings.images).map((reference) => ({ RepoTags: [reference] })),
    },
    { storageDependencies: windowsDependencies({ freeGiB: 30 }) },
  );
  assert.equal(containersRead, true);
  const report = await aiHostReport(mockEngine, { kind: 'ssh' });
  assert.equal(report.storage.status, 'unavailable');
});

test('Stockage IA : seuls les services sans profil ou sélectionnés demandent des images et des poids', async () => {
  const settings = defaultAiSettings(),
    compose = buildAiCompose(settings, newAiSecrets(), 'profile-storage'),
    model = YAML.parse(compose.source);
  model.services.inference.profiles = ['large-model'];
  model.services.extra = { image: 'private/unused:huge', profiles: ['optional'] };
  const source = YAML.stringify(model),
    plan = prepareAiStoragePreview({ source }),
    mockEngine = {
      ...engine,
      info: async () => windowsInfo,
      listImages: async () => [],
      listContainers: async () => [],
    },
    dependencies = { storageDependencies: windowsDependencies({ freeGiB: 30 }) };
  assert.deepEqual(plan.activeServices, ['caddy', 'webui', 'database']);
  assert.deepEqual(plan.images, [
    settings.images.caddy,
    settings.images.webui,
    settings.images.postgres,
  ]);
  const report = await readAiStoragePreview(plan, mockEngine, {}, dependencies);
  assert.equal(report.status, 'ready');
  assert.equal(report.estimate.imagesGiB, 8.7);
  assert.equal(report.estimate.modelGiB, 0);
  assert.equal(report.estimate.modelStorage.status, 'not-required');
  const all = prepareAiStoragePreview({ source, profiles: ['large-model', 'optional'] });
  assert.ok(all.images.includes(settings.images.vllm));
  assert.ok(all.images.includes('private/unused:huge'));
  await validateAiDeployment({ ...compose, source }, mockEngine, dependencies);
  await assert.rejects(
    validateAiDeployment(
      { ...compose, source, profiles: ['large-model'] },
      mockEngine,
      dependencies,
    ),
    /Espace disque insuffisant/,
  );
});

test('Stockage IA : un dossier modèles personnalisé ne devient jamais une preuve d’espace disponible', async () => {
  for (const root of ['/srv/models', '/srv/docker']) {
    const settings = { ...defaultAiSettings(), modelStorageRoot: root },
      compose = buildAiCompose(settings, newAiSecrets(), 'model-storage'),
      plan = prepareAiStoragePreview({ source: compose.source }),
      mockEngine = { ...linuxEngine, info: async () => linuxInfo, listImages: async () => [] },
      result = await readAiStoragePreview(
        plan,
        mockEngine,
        {},
        { storageDependencies: linuxDependencies() },
      );
    assert.equal(result.status, 'unknown');
    assert.equal(result.estimate.dockerRequiredGiB, 50.7);
    assert.ok(result.estimate.requiredGiB > result.estimate.dockerRequiredGiB);
    assert.equal(result.estimate.modelStorage.path, root);
    assert.equal(result.estimate.modelStorage.status, 'unverified');
    assert.equal(result.estimate.complete, false);
    assert.match(result.estimate.modelStorage.message, /même disque.*autre disque/);
    const insufficient = await readAiStoragePreview(
      plan,
      mockEngine,
      {},
      {
        storageDependencies: linuxDependencies({ statfs: async () => fsStats(30) }),
      },
    );
    assert.equal(insufficient.status, 'insufficient');
  }
});

test('Stockage IA : sources non IA, profils invalides et source excessive sont refusés avant accès moteur', () => {
  const source = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'bounds-test').source;
  for (const input of [
    { source: 'services: {app: {image: nginx}}' },
    { source, profiles: [''] },
    { source, profiles: Array(51).fill('profile') },
    { source, profiles: ['x'.repeat(129)] },
    { source: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { source, directory: '/private/files' },
  ])
    assert.throws(() => prepareAiStoragePreview(input));
  const invalid = YAML.parse(source);
  invalid.services.inference.profiles = 'optional';
  assert.throws(
    () => prepareAiStoragePreview({ source: YAML.stringify(invalid) }),
    /profils Compose invalides/,
  );
});

test('Stockage IA : moteur hors ligne, cache incomplet et Compose inclus restent inconnus', async () => {
  const source = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'unknown-test').source,
    plan = prepareAiStoragePreview({ source }),
    dependencies = { storageDependencies: windowsDependencies({ freeGiB: 200 }) };
  const offline = await readAiStoragePreview(
    plan,
    {
      info: async () => {
        throw Error('offline');
      },
      listImages: async () => {
        throw Error('offline');
      },
    },
    {},
    dependencies,
  );
  assert.equal(offline.status, 'unknown');
  assert.equal(offline.storage.status, 'unavailable');
  const mockEngine = {
    ...engine,
    info: async () => windowsInfo,
    listImages: async () => {
      throw Error('denied');
    },
  };
  assert.equal((await readAiStoragePreview(plan, mockEngine, {}, dependencies)).status, 'unknown');
  const included = YAML.parse(source);
  included.include = ['other-compose.yml'];
  const report = await readAiStoragePreview(
    prepareAiStoragePreview({ source: YAML.stringify(included) }),
    { ...mockEngine, listImages: async () => [] },
    {},
    dependencies,
  );
  assert.equal(report.status, 'unknown');
  assert.match(report.estimate.incompleteReasons.join(' '), /inclus/);
});

test('Stockage IA : build, latest, variables et téléchargement forcé restent inconnus même en cache', async () => {
  const compose = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'build-test');
  for (const override of [
    { build: './app' },
    { image: 'nginx:latest' },
    { image: 'nginx' },
    { image: 'private/app:${TAG}' },
    { pull_policy: 'always' },
  ]) {
    const model = YAML.parse(compose.source);
    Object.assign(model.services.webui, override);
    const plan = prepareAiStoragePreview({ source: YAML.stringify(model) }),
      mockEngine = {
        ...engine,
        info: async () => windowsInfo,
        listImages: async () => plan.images.map((image) => ({ RepoTags: [image] })),
      },
      report = await readAiStoragePreview(
        plan,
        mockEngine,
        {},
        { storageDependencies: windowsDependencies({ freeGiB: 200 }) },
      );
    assert.equal(report.estimate.imagesGiB, 0);
    assert.equal(report.status, 'unknown');
    assert.ok(report.estimate.incompleteReasons.length);
  }
});
