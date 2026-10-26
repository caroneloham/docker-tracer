import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { docker, decodeDockerLog } from '../server/docker.mjs';
import { buildAiCompose, defaultAiSettings, newAiSecrets } from '../shared/ai-infrastructure.mjs';

// Real Open WebUI + PostgreSQL only: no GPU, model download or user resource is used.
const id = `qa-external-db-${Date.now().toString(36)}`,
  label = 'docker-tracer.qa-external-db',
  labels = { [label]: id },
  resources = [],
  password = `p@ss:/?#%$!é-${randomUUID()}`,
  adminEmail = 'external-db-test@example.com',
  database = {
    mode: 'external',
    host: 'external-postgres',
    name: 'ai_client',
    user: 'user@client',
    sslMode: 'disable',
  },
  variables = { ...newAiSecrets(), AI_EXTERNAL_DB_PASSWORD: password },
  compose = buildAiCompose(
    { ...defaultAiSettings(), database, adminEmail, embeddingAutoUpdate: false },
    variables,
    id,
  ),
  model = YAML.parse(compose.source);
let network, postgres, webui, endpoint;

async function command(container, args) {
  const exec = await container.exec({ Cmd: args, AttachStdout: true, AttachStderr: true }),
    stream = await exec.start({ hijack: true, stdin: false }),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal((await exec.inspect()).ExitCode, 0, `Test command failed: ${args[0]}`);
  return decodeDockerLog(Buffer.concat(chunks)).trim();
}
async function waitFor(check, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(`Timeout: ${description}`);
}
async function api(route, body, token) {
  const response = await fetch(endpoint + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `Open WebUI ${route}: HTTP ${response.status}`);
  return response.json();
}
async function ready() {
  await waitFor(async () => {
    const status = (await webui.inspect()).State;
    assert.equal(
      status.Running,
      true,
      `Open WebUI stopped (${status.ExitCode}, OOM=${status.OOMKilled})`,
    );
    try {
      return (await fetch(endpoint + '/health', { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }, 'Open WebUI health');
}

try {
  // Fail clearly if the two exact images have not been installed for Docker Tracer.
  await docker.getImage('postgres:17-alpine').inspect();
  await docker.getImage(model.services.webui.image).inspect();
  assert.equal(model.services.database, undefined);
  assert.equal(model.volumes.database_data, undefined);
  assert.ok(!compose.source.includes(password));
  network = await docker.createNetwork({ Name: id, Labels: labels });
  postgres = await docker.createContainer({
    name: `${id}-postgres`,
    Image: 'postgres:17-alpine',
    Labels: labels,
    Env: [
      `POSTGRES_USER=${database.user}`,
      `POSTGRES_DB=${database.name}`,
      `POSTGRES_PASSWORD=${password}`,
    ],
    HostConfig: {
      Memory: 512 * 1024 ** 2,
      NetworkMode: id,
      Tmpfs: { '/var/lib/postgresql/data': 'rw,size=256m' },
    },
    NetworkingConfig: { EndpointsConfig: { [id]: { Aliases: [database.host] } } },
    Healthcheck: {
      Test: ['CMD', 'pg_isready', '-U', database.user, '-d', database.name],
      Interval: 1e9,
      Timeout: 2e9,
      Retries: 30,
    },
  });
  resources.push(postgres);
  await postgres.start();
  await waitFor(
    async () => (await postgres.inspect()).State.Health?.Status === 'healthy',
    'PostgreSQL startup',
    45000,
  );

  const environment = Object.fromEntries(
    Object.entries(model.services.webui.environment).map(([key, value]) => [
      key,
      value
        .replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => compose.variables[name] ?? '')
        .replaceAll('$$', '$'),
    ]),
  );
  Object.assign(environment, {
    ENABLE_OPENAI_API: 'false',
    ENABLE_OLLAMA_API: 'false',
    OFFLINE_MODE: 'true',
    RAG_EMBEDDING_MODEL_AUTO_UPDATE: 'false',
    WEBUI_SESSION_COOKIE_SECURE: 'false',
    WEBUI_AUTH_COOKIE_SECURE: 'false',
    WEBUI_URL: 'http://localhost:8080',
  });
  webui = await docker.createContainer({
    name: `${id}-webui`,
    Image: model.services.webui.image,
    Labels: labels,
    Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: {
      Memory: 2 * 1024 ** 3,
      NetworkMode: id,
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    },
  });
  resources.push(webui);
  await webui.start();
  endpoint = `http://127.0.0.1:${(await webui.inspect()).NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
  await ready();
  const signin = () =>
    api('/api/v1/auths/signin', { email: adminEmail, password: variables.AI_ADMIN_PASSWORD });
  const account = await signin();
  assert.equal(account.email, adminEmail);
  assert.equal(account.role, 'admin');
  const chat = await api(
    '/api/v1/chats/new',
    {
      chat: {
        title: 'External PostgreSQL persistence',
        messages: [],
        models: [],
        history: { messages: {}, currentId: null },
      },
    },
    account.token,
  );
  assert.ok(chat.id);
  const sql = (query) =>
    command(postgres, ['psql', '-U', database.user, '-d', database.name, '-Atc', query]);
  assert.equal(await sql(`SELECT count(*) FROM "user" WHERE email = '${adminEmail}'`), '1');
  assert.equal(
    await sql(`SELECT count(*) FROM chat WHERE title = 'External PostgreSQL persistence'`),
    '1',
  );
  console.log(
    'Real PostgreSQL external connection, percent-encoded credentials, administrator login and chat row: PASS (sslmode=disable).',
  );

  await webui.restart({ t: 10 });
  // Docker may assign another random loopback port when the container restarts.
  endpoint = `http://127.0.0.1:${(await webui.inspect()).NetworkSettings.Ports['8080/tcp'][0].HostPort}`;
  await ready();
  const nextAccount = await signin(),
    restored = await api(`/api/v1/chats/${chat.id}`, undefined, nextAccount.token);
  assert.equal(restored.title, 'External PostgreSQL persistence');
  assert.equal(nextAccount.id, account.id);
  assert.equal(await sql(`SELECT count(*) FROM "user" WHERE email = '${adminEmail}'`), '1');
  console.log(
    'Open WebUI restart: same account and persisted chat found in the external database. PASS.',
  );
} catch (error) {
  if (webui) {
    let logs = decodeDockerLog(await webui.logs({ stdout: true, stderr: true, tail: 60 }));
    for (const secret of [...Object.values(compose.variables), encodeURIComponent(password)])
      if (secret) logs = logs.replaceAll(secret, '[redacted]');
    console.error(logs);
  }
  throw error;
} finally {
  for (const container of resources.reverse()) {
    const inspect = await container.inspect().catch((error) => {
      if (error.statusCode !== 404) throw error;
    });
    if (!inspect) continue;
    assert.equal(inspect.Config.Labels[label], id, 'Refusing cleanup outside the test');
    await container.remove({ force: true, v: true });
  }
  if (network) {
    assert.equal((await network.inspect()).Labels[label], id);
    await network.remove();
  }
  assert.equal(
    (await docker.listContainers({ all: true, filters: { label: [`${label}=${id}`] } })).length,
    0,
  );
  assert.equal((await docker.listNetworks({ filters: { label: [`${label}=${id}`] } })).length, 0);
  console.log('Test containers, anonymous volumes and network removed.');
}
