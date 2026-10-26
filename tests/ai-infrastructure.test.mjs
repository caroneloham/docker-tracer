import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  defaultAiSettings,
  newAiSecrets,
  buildAiCompose,
  readAiSettings,
  aiSizing,
  aiChanges,
  aiSchema,
  aiComposeModel,
} from '../shared/ai-infrastructure.mjs';
import { validateAiDeployment, aiHostReport } from '../server/ai-infrastructure.mjs';
const build = (values = {}, variables = newAiSecrets()) =>
  buildAiCompose({ ...defaultAiSettings(), ...values }, variables, 'test-ai');

test('Maintenance IA : limites et ports actuels remplacent les anciennes métadonnées', async () => {
  const compose = build({ inferenceCpus: 16, inferenceRamGiB: 24 }),
    model = YAML.parse(compose.source),
    engine = {
      info: async () => ({ OSType: 'linux', NCPU: 8, MemTotal: 16 * 1024 ** 3 }),
      listContainers: async () => [
        { Labels: {}, Ports: [{ PublicPort: 8443, Type: 'tcp', IP: '0.0.0.0' }] },
      ],
    };
  model.services.inference.cpus = 8;
  model.services.inference.mem_limit = '16g';
  model.services.caddy.ports = ['127.0.0.1:9443:443'];
  compose.source = YAML.stringify(model);
  await validateAiDeployment(compose, engine);
  model.services.inference.cpus = 9;
  await assert.rejects(
    validateAiDeployment({ ...compose, source: YAML.stringify(model) }, engine),
    /8 CPU/,
  );
  model.services.inference.cpus = 8;
  model.services.caddy.ports = ['8443:443'];
  await assert.rejects(
    validateAiDeployment({ ...compose, source: YAML.stringify(model) }, engine),
    /déjà publié/,
  );
});
test('IA : seuls les ports HTTPS/HTTP sont publiés ; données et secrets propres au projet', () => {
  const secrets = newAiSecrets(),
    c = build({}, secrets),
    m = YAML.parse(c.source);
  assert.deepEqual(Object.keys(m.services), ['caddy', 'webui', 'inference', 'database']);
  assert.equal(Object.keys(m.volumes).length, 6);
  assert.equal(m.networks.data.internal, true);
  for (const name of ['webui', 'inference', 'database'])
    assert.equal(m.services[name].ports, undefined);
  for (const value of Object.values(secrets)) assert.ok(!c.source.includes(value));
  assert.equal(m.services.webui.environment.ENABLE_SIGNUP, 'false');
  assert.equal(m.services.webui.environment.ENABLE_PERSISTENT_CONFIG, 'false');
  assert.equal(
    m.services.inference.environment.VLLM_API_KEY,
    m.services.webui.environment.OPENAI_API_KEY,
  );
  assert.notEqual(newAiSecrets().AI_DB_PASSWORD, secrets.AI_DB_PASSWORD);
  assert.equal(m.services.inference.ipc, undefined);
  assert.equal(m.services.inference.privileged, undefined);
});
test('IA : changement de ports, GPU, modèle et contexte propagé à tous les services', () => {
  const c = build({
    enginePort: 8123,
    webPort: 8111,
    httpsPort: 9443,
    gpuIds: ['0', '2'],
    model: 'Qwen/Qwen3-14B',
    maxModelLen: 4096,
  });
  const m = YAML.parse(c.source);
  assert.match(m.configs.ai_caddyfile.content, /webui:8111/);
  assert.equal(m.services.webui.environment.OPENAI_API_BASE_URL, 'http://inference:8123/v1');
  assert.match(m.services.webui.healthcheck.test.at(-1), /8111/);
  assert.match(m.services.inference.healthcheck.test.at(-1), /8123/);
  assert.equal(m.services.webui.environment.WEBUI_URL, 'https://ia.home.arpa:9443');
  assert.deepEqual(m.services.inference.deploy.resources.reservations.devices[0].device_ids, [
    '0',
    '2',
  ]);
  assert.equal(
    m.services.inference.command[
      m.services.inference.command.indexOf('--tensor-parallel-size') + 1
    ],
    '2',
  );
  assert.equal(m.services.webui.environment.DEFAULT_MODELS, 'Qwen/Qwen3-14B');
});
test('IA : l’assistant conserve volumes, secrets, commentaires et ajouts manuels non gérés', () => {
  const old = build(),
    m = YAML.parse(old.source);
  m.services.extra = { image: 'nginx:alpine' };
  m.services.webui.labels = { custom: 'retained' };
  old.source = '# Commentaire du client\n' + YAML.stringify(m);
  const c = buildAiCompose(
    { ...readAiSettings(old.source), httpsPort: 9443, client: 'Client B' },
    old.variables,
    old.projectName,
    old,
  );
  const after = YAML.parse(c.source);
  assert.ok(c.source.startsWith('# Commentaire du client'));
  assert.deepEqual(after.services.extra, m.services.extra);
  assert.deepEqual(after.services.webui.labels, { custom: 'retained' });
  assert.deepEqual(c.variables, old.variables);
  assert.deepEqual(after.volumes, m.volumes);
  assert.deepEqual(aiChanges(old.source, c.source), ['caddy', 'webui']);
  const changed = YAML.parse(c.source);
  changed.services.inference.command.push('--enforce-eager');
  assert.throws(
    () =>
      buildAiCompose(readAiSettings(c.source), c.variables, c.projectName, {
        ...c,
        source: YAML.stringify(changed),
      }),
    /modifié depuis la carte/,
  );
});
test('IA : les entrées injectables et réglages incompatibles sont refusés', () => {
  for (const v of [
    { domain: 'site\nrespond hacked' },
    { domain: 'https://site.test' },
    { model: '--bad' },
    { gpuIds: ['0', '0'] },
    { gpuIds: ['0;curl'] },
    { chunkSize: 100, chunkOverlap: 100 },
    { httpsPort: 8080 },
    { tls: 'public' },
    { images: { caddy: 'caddy:2\nentrypoint' } },
  ])
    assert.throws(() => build(v));
  assert.equal(
    aiSchema.safeParse({
      ...defaultAiSettings(),
      tls: 'public',
      domain: 'chat.example.com',
      httpsPort: 443,
      httpPort: 80,
      acmeEmail: 'ops@example.com',
    }).success,
    true,
  );
  const fit = aiSizing({
    ...defaultAiSettings(),
    model: 'custom/model-32b',
    parametersB: 32,
    vramGiB: 8,
  });
  assert.equal(fit.fitsWeights, false);
  assert.ok(fit.weightsGiB > 59);
});
test('IA : PostgreSQL externe sans service local ; URI et secrets séparés du Compose', () => {
  const password = 'space p@ss:/?#%$!é',
    variables = { ...newAiSecrets(), AI_EXTERNAL_DB_PASSWORD: password };
  delete variables.AI_DB_PASSWORD;
  const c = build(
      {
        database: {
          mode: 'external',
          host: 'db.client.internal',
          port: 55432,
          name: 'ia-client_01.db',
          user: 'user@client',
          sslMode: 'require',
          password: 'must-not-appear-in-metadata',
        },
      },
      variables,
    ),
    m = YAML.parse(c.source),
    uri = new URL(c.variables.AI_EXTERNAL_DATABASE_URL);
  assert.deepEqual(Object.keys(m.services), ['caddy', 'webui', 'inference']);
  assert.equal(m.services.webui.depends_on.database, undefined);
  assert.equal(m.volumes.database_data, undefined);
  assert.equal(m.networks.data, undefined);
  assert.deepEqual(m.services.webui.networks, ['access', 'inference']);
  assert.equal(m.services.webui.environment.DATABASE_URL, '${AI_EXTERNAL_DATABASE_URL}');
  assert.equal(uri.hostname, 'db.client.internal');
  assert.equal(uri.port, '55432');
  assert.equal(decodeURIComponent(uri.username), 'user@client');
  assert.equal(decodeURIComponent(uri.password), password);
  assert.equal(uri.pathname, '/ia-client_01.db');
  assert.equal(uri.searchParams.get('sslmode'), 'require');
  assert.equal(c.variables.AI_EXTERNAL_DB_PASSWORD, password);
  assert.ok(!c.source.includes(password));
  assert.ok(!c.source.includes('must-not-appear-in-metadata'));
  assert.equal(m['x-docker-tracer-ai'].settings.database.password, undefined);
});
test('IA : PostgreSQL externe accepte IPv6 et impose une cible et un mot de passe valides', () => {
  const database = { mode: 'external', host: '[2001:db8::2]', sslMode: 'disable' },
    variables = { ...newAiSecrets(), AI_EXTERNAL_DB_PASSWORD: 'existing-password' },
    c = build({ database }, variables);
  assert.equal(readAiSettings(c.source).database.host, '2001:db8::2');
  assert.equal(
    c.variables.AI_EXTERNAL_DATABASE_URL,
    'postgresql://webui:existing-password@[2001:db8::2]:5432/webui?sslmode=disable',
  );
  for (const host of ['', 'https://db.example', 'db.example:5432', 'db\n.example', '[no-ipv6]'])
    assert.throws(() => build({ database: { ...database, host } }, variables));
  for (const password of [undefined, '', '  ', 'bad\npassword', 'bad\0password'])
    assert.throws(
      () => build({ database }, { ...variables, AI_EXTERNAL_DB_PASSWORD: password }),
      /mot de passe PostgreSQL externe/,
    );
  assert.throws(() => build({ database: { ...database, sslMode: 'unverified' } }, variables));
  for (const name of ['', 'IA client/#', 'base%20client', 'x'.repeat(64)])
    assert.throws(() => build({ database: { ...database, name } }, variables));
});
test('IA : les anciens champs externes inactifs ne bloquent pas le retour à la base gérée', () => {
  const settings = readAiSettings(
    build({
      database: {
        mode: 'managed',
        host: 'https://bad:5432',
        port: 0,
        name: '',
        user: '',
        sslMode: 'invalid',
      },
    }).source,
  );
  assert.deepEqual(settings.database, {
    mode: 'managed',
    host: '',
    port: 5432,
    name: 'webui',
    user: 'webui',
    sslMode: 'require',
  });
});
test('IA : une base externe conserve le volume PostgreSQL existant et permet de le reprendre', () => {
  const managed = build(),
    externalSettings = {
      ...readAiSettings(managed.source),
      database: { mode: 'external', host: 'db.client.internal' },
    },
    external = buildAiCompose(
      externalSettings,
      { ...managed.variables, AI_EXTERNAL_DB_PASSWORD: 'existing-password' },
      managed.projectName,
      managed,
    ),
    parsedExternal = YAML.parse(external.source);
  assert.deepEqual(parsedExternal.volumes.database_data, {});
  assert.equal(parsedExternal.services.database, undefined);
  assert.deepEqual(parsedExternal.volumes.webui_data, {});
  assert.equal(external.variables.AI_DB_PASSWORD, managed.variables.AI_DB_PASSWORD);
  const back = buildAiCompose(
      { ...readAiSettings(external.source), database: { mode: 'managed' } },
      external.variables,
      external.projectName,
      external,
    ),
    parsedBack = YAML.parse(back.source);
  assert.deepEqual(parsedBack.services.database, YAML.parse(managed.source).services.database);
  assert.deepEqual(parsedBack.volumes, YAML.parse(managed.source).volumes);
  assert.equal(back.variables.AI_EXTERNAL_DATABASE_URL, undefined);
  assert.equal(
    parsedBack.services.webui.environment.DATABASE_URL,
    'postgresql://webui:${AI_DB_PASSWORD}@database:5432/webui',
  );
});
test('IA : enrichir le catalogue conserve la possibilité de modifier un ancien profil', () => {
  const legacyModel = aiComposeModel(defaultAiSettings(), 'test-ai', { legacyModelCatalog: true });
  delete legacyModel['x-docker-tracer-ai'].modelCatalogVersion;
  delete legacyModel['x-docker-tracer-ai'].settings.database;
  const old = { ...build(), source: YAML.stringify(legacyModel) },
    next = buildAiCompose(
      { ...readAiSettings(old.source), httpsPort: 9443 },
      old.variables,
      old.projectName,
      old,
    );
  assert.equal(YAML.parse(next.source)['x-docker-tracer-ai'].modelCatalogVersion, 1);
  assert.equal(readAiSettings(next.source).database.mode, 'managed');
  assert.equal(YAML.parse(next.source).services.caddy.ports[0].published, '9443');
});
test('IA : outils authentifiés séparés des métadonnées exportées, certificat fourni requis', () => {
  const s = { ...newAiSecrets(), AI_TOOL_KEY_0: 'secret-tool-key' };
  const c = build(
    { tools: [{ name: 'ERP', url: 'https://erp.internal', path: 'openapi.json', auth: 'bearer' }] },
    s,
  );
  assert.ok(!c.source.includes('secret-tool-key'));
  const t = JSON.parse(c.variables.AI_TOOL_CONNECTIONS)[0];
  assert.equal(t.key, 'secret-tool-key');
  assert.equal(t.info.name, 'ERP');
  assert.throws(() => build({ tls: 'provided' }), /certificat PEM/);
  assert.throws(() =>
    build({ tools: [{ name: 'bad', url: 'https://user:pass@erp.internal', auth: 'none' }] }),
  );
});
test('IA : vérification du moteur et des collisions avant déploiement, GPU non prétendu validé', async () => {
  const engine = {
    info: async () => ({
      OSType: 'linux',
      MemTotal: 16 * 1024 ** 3,
      NCPU: 8,
      Runtimes: { nvidia: {} },
    }),
    listContainers: async () => [],
  };
  const report = await aiHostReport(engine);
  assert.equal(report.gpu, 'unverified');
  assert.equal(report.ramGiB, 16);
  await validateAiDeployment(build(), engine);
  await assert.rejects(
    validateAiDeployment(build(), { ...engine, info: async () => ({ OSType: 'windows' }) }),
    /Linux/,
  );
  const conflict = {
    ...engine,
    listContainers: async () => [
      { Labels: {}, Ports: [{ PublicPort: 8443, Type: 'tcp', IP: '0.0.0.0' }] },
    ],
  };
  await assert.rejects(validateAiDeployment(build(), conflict), /déjà publié/);
  await validateAiDeployment(build(), {
    ...conflict,
    listContainers: async () => [
      {
        Labels: { 'com.docker.compose.project': 'test-ai' },
        Ports: [{ PublicPort: 8443, Type: 'tcp' }],
      },
    ],
  });
});
