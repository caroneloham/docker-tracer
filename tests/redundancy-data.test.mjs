import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { analyzeRedundancyData } from '../shared/redundancy-data.mjs';
import { composeDocument } from '../shared/compose-project.mjs';

const analyze = (service, options = {}, extra = {}) =>
  analyzeRedundancyData(YAML.stringify({ services: { app: service }, ...extra }), ['app'], options);
const confirmed = { confirmations: { statelessServices: ['app'] } };
const codes = (result) => result.blockers.map((item) => item.code);

test('redondance données : une image HTTP et read_only ne prouvent pas une application sans état', () => {
  for (const service of [{ image: 'nginx:alpine' }, { image: 'acme/app:1', read_only: true }]) {
    const result = analyze(service);
    assert.equal(result.services[0].classification, 'unknown');
    assert.equal(result.services[0].strategy, 'blocked');
    assert.deepEqual(codes(result), ['STATE_UNCLASSIFIED']);
  }
});

test('redondance données : confirmation explicite permet une application sans état et sans deuxième serveur', () => {
  const result = analyze({ image: 'acme/web:1' }, confirmed);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.services[0].classification, 'stateless');
  assert.equal(result.services[0].strategy, 'active-active');
  assert.ok(result.warnings.some((item) => item.code === 'LOCAL_CAPACITY_REQUIRED'));
});

test('redondance données : bases, files, caches et index exigent une stratégie native même sans volume explicite', () => {
  const images = [
    ['postgres:18', 'DATABASE_REPLICATION_REQUIRED'],
    ['bitnami/postgresql:17', 'DATABASE_REPLICATION_REQUIRED'],
    ['mysql:9', 'DATABASE_REPLICATION_REQUIRED'],
    ['mariadb:11', 'DATABASE_REPLICATION_REQUIRED'],
    ['keinos/sqlite3:latest', 'SQLITE_SINGLE_WRITER'],
    ['chromadb/chroma:1', 'VECTOR_DATA_REPLICATION_REQUIRED'],
    ['qdrant/qdrant:v1', 'VECTOR_DATA_REPLICATION_REQUIRED'],
    ['rabbitmq:4', 'QUEUE_REPLICATION_REQUIRED'],
    ['apache/kafka:4', 'QUEUE_REPLICATION_REQUIRED'],
    ['redis:8', 'CACHE_ROLE_UNVERIFIED'],
    ['valkey/valkey:8', 'CACHE_ROLE_UNVERIFIED'],
  ];
  for (const [image, code] of images) {
    const result = analyze({ image }, confirmed);
    assert.ok(codes(result).includes(code), image);
    assert.equal(result.services[0].classification, 'stateful', image);
    assert.equal(result.services[0].strategy, 'blocked', image);
    assert.equal(
      result.data[0].strategy,
      code === 'SQLITE_SINGLE_WRITER' ? 'manual' : 'native-replication',
    );
  }
});

test('redondance données : SQLite dans une application personnalisée reste bloqué', () => {
  for (const environment of [
    { DATABASE_URL: 'sqlite:////app/state.db' },
    ['DATABASE_URL=sqlite+aiosqlite:////app/state.db'],
    { DB_TYPE: 'sqlite' },
  ]) {
    const result = analyze({ image: 'acme/app', environment }, confirmed);
    assert.ok(codes(result).includes('SQLITE_SINGLE_WRITER'));
    assert.equal(result.services[0].classification, 'stateful');
  }
});

test('redondance données : tous les montages RW bloquent, y compris anonymes, externes et avec read_only au niveau service', () => {
  for (const volumes of [
    ['state:/data'],
    ['/srv/state:/data:rw'],
    ['/data'],
    [{ type: 'bind', source: './state', target: '/data' }],
    [{ type: 'volume', source: 'state', target: '/data', read_only: false }],
  ]) {
    const result = analyze({ image: 'acme/app', read_only: true, volumes }, confirmed, {
      volumes: { state: { external: true } },
    });
    assert.ok(codes(result).includes('WRITABLE_VOLUME_UNSAFE'));
    assert.equal(result.services[0].strategy, 'blocked');
    assert.equal(result.data[0].access, 'single-writer');
    assert.equal(result.data[0].strategy, 'blocked');
  }
});

test('redondance données : références RO explicites réutilisables sur la même machine, avec réserve sur leur contenu', () => {
  for (const volumes of [
    ['./nginx.conf:/etc/nginx/nginx.conf:ro'],
    ['config:/etc/app:ro,z'],
    [{ type: 'bind', source: './config', target: '/etc/app', read_only: true }],
    ['C:\\app\\config:/etc/app:ro'],
    ['C:\\app\\config:C:\\config:ro'],
  ]) {
    const result = analyze({ image: 'acme/app', volumes }, confirmed);
    assert.deepEqual(result.blockers, [], JSON.stringify(volumes));
    assert.equal(result.data[0].access, 'read-only');
    assert.equal(result.data[0].strategy, 'shared-read-only');
    assert.ok(result.warnings.some((item) => item.code === 'READ_ONLY_CONTENT_UNVERIFIED'));
  }
});

test('redondance données : montages ambigus ou interpolés ne sont pas acceptés par une confirmation', () => {
  for (const volumes of [
    ['${STATE_PATH}:/data:ro'],
    ['state:/data:ro,rw'],
    [{ type: 'bind', source: './config', target: '/etc/app', read_only: 'true' }],
    [{ type: 'volume', source: 'state' }],
  ]) {
    const result = analyze({ image: 'acme/app', volumes }, confirmed);
    assert.ok(codes(result).includes('MOUNT_UNRESOLVED'));
    assert.equal(result.data[0].strategy, 'blocked');
  }
});

test('redondance données : tmpfs n’est pas une base persistante partagée', () => {
  const result = analyze(
    { image: 'acme/app', volumes: [{ type: 'tmpfs', target: '/tmp' }] },
    confirmed,
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(result.data[0].access, 'ephemeral');
  assert.ok(result.warnings.some((item) => item.code === 'EPHEMERAL_STATE'));
});

test('redondance données : configs et secrets restent des références RO et ne divulguent pas leurs valeurs', () => {
  const result = analyze(
    { image: 'acme/app', configs: ['settings'], secrets: [{ source: 'session_key' }] },
    confirmed,
    {
      configs: { settings: { content: 'PRIVATE_CONFIG_CONTENT' } },
      secrets: { session_key: { environment: 'PRIVATE_SECRET_ENV' } },
    },
  );
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(
    result.data.map((item) => item.access),
    ['read-only', 'read-only'],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONFIG_CONTENT|PRIVATE_SECRET_ENV/);
  assert.ok(
    codes(analyze({ image: 'acme/app', configs: ['missing'] }, confirmed)).includes(
      'READ_ONLY_REFERENCE_UNRESOLVED',
    ),
  );
});

test('redondance données : héritage des volumes reste explicite et bloquant', () => {
  assert.ok(
    codes(analyze({ image: 'acme/app', volumes_from: ['other:ro'] }, confirmed)).includes(
      'INHERITED_MOUNTS_UNVERIFIED',
    ),
  );
});

test('redondance données : GPU déclaré de plusieurs manières ne se double pas implicitement', () => {
  for (const allocation of [
    { gpus: 'all' },
    { gpus: [{ driver: 'nvidia', count: 1 }] },
    { runtime: 'nvidia' },
    {
      deploy: {
        resources: { reservations: { devices: [{ capabilities: ['gpu'], device_ids: ['0'] }] } },
      },
    },
    { devices: ['/dev/dri:/dev/dri'] },
    { devices: ['nvidia.com/gpu=all'] },
    { environment: ['NVIDIA_VISIBLE_DEVICES=0'] },
    { environment: { CUDA_VISIBLE_DEVICES: '0' } },
  ]) {
    const result = analyze({ image: 'vllm/vllm-openai:latest', ...allocation }, confirmed);
    assert.ok(codes(result).includes('GPU_CAPACITY_UNVERIFIED'), JSON.stringify(allocation));
    assert.equal(result.services[0].classification, 'inference');
    assert.equal(result.services[0].strategy, 'blocked');
  }
});

test('redondance données : inférence CPU confirmée conserve une réserve de mémoire et d’échauffement', () => {
  const result = analyze(
    { image: 'llama-server:cpu', environment: { NVIDIA_VISIBLE_DEVICES: 'none' } },
    confirmed,
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(result.services[0].classification, 'inference');
  assert.ok(result.warnings.some((item) => item.code === 'INFERENCE_WARMUP_REQUIRED'));
});

test('redondance données : Open WebUI reste bloqué même avec PostgreSQL externe et sans volume visible', () => {
  const result = analyze(
    {
      image: 'ghcr.io/open-webui/open-webui:main',
      environment: {
        DATABASE_URL: 'postgresql://user:PRIVATE_PASSWORD@db/app',
        WEBUI_SECRET_KEY: 'PRIVATE_SESSION_KEY',
        VECTOR_DB: 'chroma',
      },
    },
    confirmed,
  );
  assert.ok(codes(result).includes('OPENWEBUI_STATE_UNVERIFIED'));
  assert.equal(result.services[0].classification, 'stateful');
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_PASSWORD|PRIVATE_SESSION_KEY|postgresql:\/\//,
  );
});

test('redondance données : Chroma local déclaré dans une app générique exige une migration', () => {
  assert.ok(
    codes(analyze({ image: 'acme/app', environment: { VECTOR_DB: 'chroma' } }, confirmed)).includes(
      'CHROMA_LOCAL_STATE',
    ),
  );
});

test('redondance données : Caddy requiert une vérification de stockage TLS, même avec une config RO', () => {
  const result = analyze(
    { image: 'caddy:2', volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro'] },
    confirmed,
  );
  assert.ok(codes(result).includes('TLS_STORAGE_UNVERIFIED'));
  assert.equal(result.services[0].classification, 'stateful');
});

test('redondance données : une base non sélectionnée reste unique et ne bloque pas son client confirmé', () => {
  const source = YAML.stringify({
    services: {
      app: {
        image: 'acme/app',
        depends_on: { db: { condition: 'service_healthy' } },
        environment: { DATABASE_URL: 'postgresql://user:PRIVATE_PASSWORD@db/app' },
      },
      db: { image: 'postgres:18', volumes: ['pgdata:/var/lib/postgresql/data'] },
      unrelated: { image: 'rabbitmq:4' },
    },
    volumes: { pgdata: {} },
  });
  const before = composeDocument(source).model;
  const result = analyzeRedundancyData(source, ['app'], confirmed);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.services.length, 1);
  assert.equal(result.services[0].strategy, 'active-active');
  assert.equal(
    result.warnings.filter((item) => item.code === 'DEPENDENCY_SINGLE_INSTANCE').length,
    1,
  );
  assert.ok(result.data.some((item) => item.source === 'db' && item.strategy === 'external'));
  assert.deepEqual(composeDocument(source).model, before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PASSWORD/);
  const all = analyzeRedundancyData(source, undefined, confirmed);
  assert.equal(all.services[0].strategy, 'active-active');
  assert.equal(all.services[1].strategy, 'blocked');
  assert.equal(all.services[2].strategy, 'blocked');
});

test('redondance données : dépendances présentes seulement dans les URL et hors Compose sont visibles sans secret', () => {
  const source = YAML.stringify({
    services: {
      app: {
        image: 'acme/app',
        depends_on: ['outside'],
        environment: ['REDIS_URL=redis://:PRIVATE_PASSWORD@redis:6379/0'],
      },
      redis: { image: 'redis:8' },
    },
  });
  const result = analyzeRedundancyData(source, ['app'], confirmed);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.warnings.some((item) => item.code === 'DEPENDENCY_NOT_IN_COMPOSE'));
  assert.ok(result.warnings.some((item) => item.code === 'DEPENDENCY_SINGLE_INSTANCE'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PASSWORD/);
});

test('redondance données : une confirmation étrangère n’autorise pas un autre service', () => {
  const result = analyze(
    { image: 'acme/app' },
    { confirmations: { statelessServices: ['other'] } },
  );
  assert.ok(codes(result).includes('STATE_UNCLASSIFIED'));
});

test('redondance données : services absents et sélection vide sont déterministes', () => {
  const source = 'services:\n  app:\n    image: acme/app\n';
  const missing = analyzeRedundancyData(source, ['missing']);
  assert.equal(missing.blockers[0].code, 'SERVICE_NOT_FOUND');
  assert.deepEqual(analyzeRedundancyData(source, []), {
    services: [],
    data: [],
    blockers: [],
    warnings: [],
  });
});
