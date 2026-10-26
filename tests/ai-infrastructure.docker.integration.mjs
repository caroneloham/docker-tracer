import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import YAML from 'yaml';
import { docker, decodeDockerLog } from '../server/docker.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createComposeRunner } from '../server/compose-runner.mjs';
import { buildAiCompose, defaultAiSettings, newAiSecrets } from '../shared/ai-infrastructure.mjs';
import { validateAiDeployment } from '../server/ai-infrastructure.mjs';
import { createComposeManager } from '../server/compose-manager.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-ai-test-'));
const name = 'dtr-ai-' + Date.now().toString(36),
  filters = { label: ['com.docker.compose.project=' + name] };
let runner;
async function exec(container, args) {
  const e = await container.exec({ Cmd: args, AttachStdout: true, AttachStderr: true });
  const stream = await e.start({ hijack: true, stdin: false });
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const output = decodeDockerLog(Buffer.concat(chunks));
  assert.equal((await e.inspect()).ExitCode, 0, 'Commande du test en échec : ' + args[0]);
  return output;
}
async function service(id) {
  return docker.getContainer(
    (await docker.listContainers({ all: true, filters })).find(
      (c) => c.Labels['com.docker.compose.service'] === id,
    ).Id,
  );
}
try {
  const hosts = new HostRegistry(await openWorkspaceStore(dir), docker);
  runner = createComposeRunner({ dataDir: dir, hosts });
  const values = {
    ...defaultAiSettings(),
    client: 'Test temporaire IA',
    domain: 'localhost',
    httpsPort: 18443,
    httpPort: 18080,
  };
  const original = buildAiCompose(values, newAiSecrets(), name);
  await validateAiDeployment(original, docker);
  await runner.withProject(original, 'local', async ({ run }) => {
    const m = JSON.parse((await run(['config', '--format', 'json'], { json: true })).stdout);
    assert.equal(m.services.inference.deploy.resources.reservations.devices[0].driver, 'nvidia');
    assert.equal(
      m.services.webui.environment.DATABASE_URL,
      `postgresql://webui:${original.variables.AI_DB_PASSWORD}@database:5432/webui`,
    );
  });
  console.log(
    'Profil NVIDIA complet : validation réelle par Docker Compose OK (sans téléchargement du modèle).',
  );
  // HTTP stand-ins isolate networking/TLS/storage from unavailable GPU hardware.
  // This test does not claim to execute vLLM, Qwen or Open WebUI.
  const m = YAML.parse(original.source);
  m.services.caddy.image = 'caddy:2-alpine';
  for (const id of ['webui', 'inference'])
    m.services[id] = {
      image: 'nginx:alpine',
      networks: m.services[id].networks,
      configs: [{ source: 'test_' + id, target: '/etc/nginx/conf.d/default.conf' }],
      healthcheck: {
        test: [
          'CMD',
          'wget',
          '-qO-',
          'http://127.0.0.1:' + (id === 'webui' ? values.webPort : values.enginePort) + '/health',
        ],
        interval: '1s',
        timeout: '2s',
        retries: 20,
      },
    };
  m.configs.test_webui = {
    content: `server { listen ${values.webPort}; location /health { return 200 'ok'; } location / { proxy_pass http://inference:${values.enginePort}; } }`,
  };
  m.configs.test_inference = {
    content: `server { listen ${values.enginePort}; location / { default_type application/json; return 200 '{"test":"temporary","inference":"stand-in"}'; } }`,
  };
  const smoke = { ...original, source: YAML.stringify(m), waitSeconds: 60 };
  await runner.withProject(smoke, 'local', async ({ run }) => {
    await run(['up', '-d', '--wait', '--wait-timeout', '60']);
  });
  const proxy = await service('caddy'),
    ca = await exec(proxy, ['cat', '/data/caddy/pki/authorities/local/root.crt']);
  const manager = createComposeManager({
    record: () => ({ compose: { ...original, lastApplied: original } }),
    engine: async () => docker,
  });
  assert.equal(await manager.aiRootCertificate(), ca);
  const leafPath = (
    await exec(proxy, ['find', '/data/caddy/certificates', '-name', 'localhost.crt'])
  ).trim();
  assert.ok(leafPath.startsWith('/data/caddy/certificates/'));
  const providedVariables = {
    ...original.variables,
    AI_TLS_CERT: await exec(proxy, ['cat', leafPath]),
    AI_TLS_KEY: await exec(proxy, ['cat', leafPath.replace(/\.crt$/, '.key')]),
  };
  const provided = buildAiCompose({ ...values, tls: 'provided' }, providedVariables, name);
  await validateAiDeployment(provided, docker);
  await assert.rejects(
    validateAiDeployment(
      buildAiCompose(
        { ...values, tls: 'provided', domain: 'another.invalid' },
        providedVariables,
        name,
      ),
      docker,
    ),
    /ne couvre pas/,
  );
  await runner.withProject(provided, 'local', async ({ run }) => {
    const config = JSON.parse((await run(['config', '--format', 'json'], { json: true })).stdout);
    assert.equal(config.secrets.ai_tls_key.environment, 'AI_TLS_KEY');
  });
  const response = await new Promise((resolve, reject) => {
    https
      .get({ hostname: 'localhost', port: 18443, path: '/', ca }, (r) => {
        let body = '';
        r.on('data', (b) => (body += b));
        r.on('end', () => resolve({ code: r.statusCode, body }));
      })
      .on('error', reject);
  });
  assert.equal(response.code, 200);
  assert.equal(JSON.parse(response.body).inference, 'stand-in');
  const redirect = await new Promise((resolve, reject) => {
    http
      .get('http://localhost:18080/example', (r) => {
        r.resume();
        resolve({ status: r.statusCode, location: r.headers.location });
      })
      .on('error', reject);
  });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.location, 'https://localhost:18443/example');
  const db = await service('database');
  await exec(db, [
    'psql',
    '-U',
    'webui',
    '-d',
    'webui',
    '-c',
    "CREATE TABLE proof (value text); INSERT INTO proof VALUES ('persistent');",
  ]);
  await runner.withProject(smoke, 'local', async ({ run }) => {
    await run(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'database']);
  });
  assert.match(
    await exec(await service('database'), [
      'psql',
      '-U',
      'webui',
      '-d',
      'webui',
      '-tAc',
      'SELECT value FROM proof',
    ]),
    /persistent/,
  );
  for (const c of await docker.listContainers({ all: true, filters }))
    if (c.Labels['com.docker.compose.service'] !== 'caddy')
      assert.equal(c.Ports.filter((p) => p.PublicPort).length, 0);
  console.log(
    'Caddy HTTPS avec CA vérifiée et exportée, certificat fourni et nom vérifiés, redirection port personnalisé, passage proxy→interface→moteur (doublures HTTP), PostgreSQL persistant et ports internes non publiés : OK.',
  );
} finally {
  await runner?.shutdown();
  for (const c of await docker.listContainers({ all: true, filters }))
    await docker.getContainer(c.Id).remove({ force: true });
  for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
  for (const v of (await docker.listVolumes({ filters })).Volumes || [])
    await docker.getVolume(v.Name).remove();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-ai-test-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Ressources temporaires du test IA nettoyées.');
}
