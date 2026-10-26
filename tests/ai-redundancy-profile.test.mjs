import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { aiComposeModel, defaultAiSettings } from '../shared/ai-infrastructure.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import {
  AI_REDUNDANCY_EXTENSION,
  prepareFreshAiRedundancy,
} from '../shared/ai-redundancy-profile.mjs';

const fixture = (settings = {}) =>
  aiComposeModel({ ...defaultAiSettings(), ...settings }, 'test-ai');
const prepare = (model = fixture(), options) =>
  prepareFreshAiRedundancy(YAML.stringify(model), options);
const parsed = (result) => {
  assert.deepEqual(result.blockers, []);
  assert.equal(result.summary.applicable, true);
  return composeDocument(result.source).model;
};
const blocked = (model, code, options) => {
  const source = YAML.stringify(model),
    result = prepareFreshAiRedundancy(source, options);
  assert.equal(result.source, source);
  assert.equal(result.summary.applicable, false);
  assert.ok(
    result.blockers.some((item) => item.code === code),
    JSON.stringify(result.blockers),
  );
};

test('fresh AI profile: two WebUI processes, shared stores, one migration owner and one GPU engine', () => {
  const before = fixture(),
    result = prepare(before),
    after = parsed(result);
  assert.equal(after[AI_REDUNDANCY_EXTENSION].mode, 'fresh-only');
  assert.deepEqual(result.summary.replicatedServices, ['webui']);
  assert.match(result.summary.description, /Interface : 2 instances ; moteur IA : 1 instance/);
  assert.deepEqual(after.services.inference, before.services.inference);
  assert.deepEqual(after.services.database, before.services.database);
  assert.deepEqual(after.services.caddy.ports, before.services.caddy.ports);
  assert.equal(Object.keys(after.services).length, 7);
  const primary = after.services.webui,
    secondary = after.services['webui-2'];
  for (const webui of [primary, secondary]) {
    assert.equal(webui.environment.DATABASE_URL, before.services.webui.environment.DATABASE_URL);
    assert.equal(
      webui.environment.WEBUI_SECRET_KEY,
      before.services.webui.environment.WEBUI_SECRET_KEY,
    );
    assert.deepEqual(webui.volumes, before.services.webui.volumes);
    assert.equal(webui.environment.VECTOR_DB, 'qdrant');
    assert.equal(webui.environment.QDRANT_URI, 'http://qdrant:6333');
    assert.equal(webui.environment.REDIS_URL, 'redis://redis:6379/0');
    assert.equal(webui.environment.WEBSOCKET_REDIS_URL, 'redis://redis:6379/1');
    assert.equal(webui.environment.WEBSOCKET_MANAGER, 'redis');
    assert.equal(webui.environment.ENABLE_WEBSOCKET_SUPPORT, 'true');
    assert.equal(webui.environment.ENABLE_PERSISTENT_CONFIG, 'false');
    assert.equal(webui.environment.UVICORN_WORKERS, '1');
    assert.equal(webui.ports, undefined);
    assert.deepEqual(webui.depends_on.qdrant, { condition: 'service_healthy' });
    assert.deepEqual(webui.depends_on.redis, { condition: 'service_healthy' });
  }
  assert.equal(primary.environment.ENABLE_DB_MIGRATIONS, 'true');
  assert.equal(secondary.environment.ENABLE_DB_MIGRATIONS, 'false');
  assert.deepEqual(secondary.depends_on.webui, { condition: 'service_healthy' });
  assert.equal(primary.depends_on.webui, undefined);
  assert.deepEqual(after.services.qdrant.volumes, ['qdrant_data:/qdrant/storage']);
  assert.ok(after.services.qdrant.healthcheck.test.at(-1).includes('/readyz'));
  assert.equal(after.services.redis.ports, undefined);
  assert.equal(after.services.qdrant.ports, undefined);
  assert.deepEqual(after.services.redis.networks, ['data']);
  assert.deepEqual(after.services.redis.tmpfs, ['/data']);
  assert.equal(after.services.redis.command.includes('no'), true);
  assert.match(after.configs.ai_caddyfile.content, /reverse_proxy webui:8080 webui-2:8080/);
  assert.match(after.configs.ai_caddyfile.content, /health_uri \/health/);
  assert.match(after.configs.ai_caddyfile.content, /lb_policy round_robin/);
  assert.match(after.configs.ai_caddyfile.content, /tls internal/);
  assert.equal(after.services.caddy.read_only, undefined);
});

test('named interfaces resize 2→4→3→2, reuse state, change Caddy fingerprint, and are idempotent', () => {
  const initial = prepare(),
    two = parsed(initial);
  assert.equal(prepareFreshAiRedundancy(initial.source).source, initial.source);
  const fourResult = prepareFreshAiRedundancy(initial.source, { replicas: 4 }),
    four = parsed(fourResult);
  assert.equal(four[AI_REDUNDANCY_EXTENSION].replicas, 4);
  assert.deepEqual(four.services.qdrant, two.services.qdrant);
  assert.deepEqual(four.volumes, two.volumes);
  assert.equal(four.services['webui-4'].environment.ENABLE_DB_MIGRATIONS, 'false');
  assert.notEqual(
    four.services.caddy.labels['io.docker-tracer.ai-caddy-config'],
    two.services.caddy.labels['io.docker-tracer.ai-caddy-config'],
  );
  const three = prepareFreshAiRedundancy(fourResult.source, { replicas: 3 });
  assert.deepEqual(three.summary.removedServices, ['webui-4']);
  assert.equal(parsed(three).services['webui-4'], undefined);
  const final = parsed(prepareFreshAiRedundancy(three.source));
  assert.equal(final.services['webui-3'], undefined);
  assert.equal(
    final.services.caddy.labels['io.docker-tracer.ai-caddy-config'],
    two.services.caddy.labels['io.docker-tracer.ai-caddy-config'],
  );
  assert.deepEqual(final.services.webui, two.services.webui);
});

test('actual HTTP port and public/provided TLS configuration are preserved', () => {
  for (const settings of [
    { webPort: 8111 },
    { tls: 'provided', webPort: 8122 },
    {
      tls: 'public',
      domain: 'chat.example.com',
      httpsPort: 443,
      httpPort: 80,
      acmeEmail: 'ops@example.com',
    },
  ]) {
    const before = fixture(settings),
      after = parsed(prepare(before));
    assert.match(
      after.configs.ai_caddyfile.content,
      new RegExp(`webui-2:${settings.webPort || 8080}`),
    );
    assert.deepEqual(after.services.caddy.secrets, before.services.caddy.secrets);
    assert.deepEqual(after.secrets, before.secrets);
    assert.deepEqual(after.services.caddy.volumes, before.services.caddy.volumes);
  }
});

test('unknown fields, environment list, secret placeholders and unrelated jobs survive', () => {
  const before = fixture();
  before['x-custom'] = { value: 'retain' };
  before.services.webui.labels = { business: 'important' };
  before.services.webui.environment.CUSTOM_SETTING = '${CUSTOM_SECRET}';
  before.services.webui.environment = Object.entries(before.services.webui.environment).map(
    ([key, value]) => `${key}=${value}`,
  );
  before.services.job = { image: 'alpine:3', restart: 'no', command: ['true'] };
  before.services.caddy.labels = ['other=retain=with=equals'];
  const source = '# Client comment\n' + YAML.stringify(before);
  const result = prepareFreshAiRedundancy(source),
    after = parsed(result);
  assert.ok(result.source.startsWith('# Client comment'));
  assert.deepEqual(after['x-custom'], before['x-custom']);
  assert.deepEqual(after.services.job, before.services.job);
  assert.deepEqual(after.services['webui-2'].labels, before.services.webui.labels);
  assert.equal(after.services['webui-2'].environment.CUSTOM_SETTING, '${CUSTOM_SECRET}');
  assert.equal(after.services.caddy.labels.other, 'retain=with=equals');
  assert.deepEqual(after.networks, before.networks);
});

test('anchors keep later references unchanged through preparation and resize', () => {
  const model = fixture(),
    doc = YAML.parseDocument(YAML.stringify(model));
  const web = doc.getIn(['services', 'webui'], true);
  web.anchor = 'original-webui';
  // A non-service extension can reference the prior service configuration.
  doc.set('x-before-webui', doc.createAlias(web));
  const first = prepareFreshAiRedundancy(doc.toString()),
    after = parsed(first);
  assert.equal(after['x-before-webui'].environment.VECTOR_DB, 'chroma');
  let source = first.source;
  for (let index = 0; index < 6; index++) {
    const result = prepareFreshAiRedundancy(source, { replicas: index % 2 ? 2 : 3 });
    assert.equal(parsed(result)['x-before-webui'].environment.VECTOR_DB, 'chroma');
    source = result.source;
  }
  assert.ok(source.length < first.source.length * 2);
});

test('unsafe or unsupported profile variants fail atomically without revealing secrets', () => {
  const cases = [
    ['AI_PROFILE_REQUIRED', (m) => delete m['x-docker-tracer-ai']],
    ['AI_SERVICE_REQUIRED', (m) => delete m.services.database],
    [
      'WEBUI_VERSION_UNSUPPORTED',
      (m) => (m.services.webui.image = 'ghcr.io/open-webui/open-webui:latest'),
    ],
    [
      'POSTGRES_REQUIRED',
      (m) => (m.services.webui.environment.DATABASE_URL = 'sqlite:///webui.db'),
    ],
    ['SHARED_SECRET_REQUIRED', (m) => delete m.services.webui.environment.WEBUI_SECRET_KEY],
    [
      'SHARED_SECRET_REQUIRED',
      (m) => (m.services.webui.environment.WEBUI_SECRET_KEY = '${SECRET:-}'),
    ],
    ['SHARED_FILES_REQUIRED', (m) => (m.services.webui.volumes = ['./data:/app/backend/data'])],
    ['SHARED_FILES_REQUIRED', (m) => (m.volumes.webui_data.external = true)],
    ['SHARED_FILES_REQUIRED', (m) => (m.volumes.webui_data.driver_opts = { type: 'nfs' })],
    ['SHARED_FILES_REQUIRED', (m) => m.services.webui.volumes.push('other:/cache')],
    ['SHARED_FILES_REQUIRED', (m) => (m.services.webui.environment.STORAGE_PROVIDER = 's3')],
    ['CUSTOM_STARTUP_UNSUPPORTED', (m) => (m.services.webui.command = ['custom'])],
    ['CUSTOM_STARTUP_UNSUPPORTED', (m) => (m.services.caddy.entrypoint = ['custom'])],
    ['CUSTOM_STARTUP_UNSUPPORTED', (m) => (m.services.webui.env_file = ['settings.env'])],
    ['WEBUI_REPLICA_CONFLICT', (m) => (m.services.webui.ports = ['8080:8080'])],
    ['WEBUI_REPLICA_CONFLICT', (m) => (m.services.webui.container_name = 'fixed')],
    ['SERVICE_LAYOUT_UNSUPPORTED', (m) => (m.services.inference.profiles = ['gpu'])],
    ['SERVICE_LAYOUT_UNSUPPORTED', (m) => (m.services.webui.deploy = { replicas: 3 })],
    ['SERVICE_LAYOUT_UNSUPPORTED', (m) => (m.services.webui.deploy = { replicas: 0 })],
    ['SERVICE_LAYOUT_UNSUPPORTED', (m) => (m.services.webui.scale = 0)],
    ['SHARED_NETWORK_REQUIRED', (m) => (m.networks.data.internal = false)],
    ['WEBUI_HEALTH_REQUIRED', (m) => (m.services.webui.healthcheck.disable = true)],
    ['WEBUI_HEALTH_REQUIRED', (m) => (m.services.webui.healthcheck.test = ['CMD', 'true'])],
    ['INLINE_CADDY_REQUIRED', (m) => (m.configs.ai_caddyfile = { file: './Caddyfile' })],
    [
      'CADDY_ROUTE_UNSUPPORTED',
      (m) => (m.configs.ai_caddyfile.content = 'localhost { respond OK }'),
    ],
    ['EXISTING_SHARED_BACKEND', (m) => (m.services.webui.environment.VECTOR_DB = 'qdrant')],
    ['RESOURCE_NAME_CONFLICT', (m) => (m.services.redis = { image: 'redis:7-alpine' })],
    ['RESOURCE_NAME_CONFLICT', (m) => (m.volumes.qdrant_data = {})],
  ];
  for (const [code, mutate] of cases) {
    const model = fixture();
    mutate(model);
    blocked(model, code);
  }
  for (const replicas of [0, 1, 5, 2.5, '2'])
    blocked(fixture(), 'INVALID_REPLICA_COUNT', { replicas });
  const bad = prepareFreshAiRedundancy('services: [invalid');
  assert.equal(bad.blockers[0].code, 'INVALID_COMPOSE');
});

test('prepared services or Caddy edits block resize instead of overwriting them', () => {
  const initial = parsed(prepare());
  for (const [code, mutate] of [
    ['PREPARED_SERVICE_CHANGED', (m) => (m.services['webui-2'].environment.CUSTOM = 'retain')],
    ['PREPARED_SERVICE_CHANGED', (m) => (m.services.redis.image = 'custom:latest')],
    ['PREPARED_CADDY_CHANGED', (m) => (m.configs.ai_caddyfile.content += '# edited\n')],
    ['AI_REDUNDANCY_VERSION_UNSUPPORTED', (m) => (m[AI_REDUNDANCY_EXTENSION].version = 99)],
    ['RESOURCE_NAME_CONFLICT', (m) => (m.services['webui-3'] = { image: 'nginx:alpine' })],
  ]) {
    const model = structuredClone(initial);
    mutate(model);
    blocked(model, code, { replicas: 3 });
  }
  const three = parsed(prepare(fixture(), { replicas: 3 }));
  three.services.extra = { image: 'nginx:alpine', depends_on: ['webui-3'] };
  blocked(three, 'SECONDARY_STILL_REFERENCED', { replicas: 2 });
});
