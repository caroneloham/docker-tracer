import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument } from '../shared/compose-project.mjs';
import {
  planAutomaticRedundancy,
  detectRedundancyEndpoint,
} from '../shared/redundancy-automatic.mjs';

test('automatic protection detects HTTP and creates real replicas without user settings', () => {
  const source =
    'services:\n  web:\n    image: nginx:alpine\n    ports: ["127.0.0.1:8080:80"]\n  db:\n    image: postgres:17\n    volumes: ["data:/var/lib/postgresql/data"]\nvolumes:\n  data: {}\n';
  const plan = planAutomaticRedundancy(source);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.summary.applicable, true);
  assert.deepEqual(plan.summary.replicatedServices, ['web']);
  assert.equal(plan.summary.endpoints[0].protocol, 'http');
  const model = composeDocument(plan.source).model;
  assert.equal(model.services.web.deploy.replicas, 2);
  assert.equal(model.services.db.scale, undefined);
  assert.deepEqual(model.services.db.volumes, ['data:/var/lib/postgresql/data']);
  assert.equal(model.services.db.restart, 'unless-stopped');
});

test('automatic protection never calls restart-only AI a duplicate or changes its data/GPU', () => {
  const source =
    'services:\n  inference:\n    image: vllm/vllm-openai:v0.29.0\n    gpus: all\n    volumes: ["cache:/root/.cache"]\n  webui:\n    image: ghcr.io/open-webui/open-webui:main\n    volumes: ["data:/app/backend/data"]\nvolumes:\n  cache: {}\n  data: {}\n';
  const plan = planAutomaticRedundancy(source);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.summary.replicatedServices, []);
  assert.deepEqual(plan.summary.restartServices, ['inference', 'webui']);
  assert.match(plan.summary.description, /aucun service multiplié/);
  assert.equal(composeDocument(plan.source).model.services.inference.gpus, 'all');
  assert.equal(
    plan.summary.services.find((row) => row.name === 'inference').reason,
    'GPU conservé pour une seule instance',
  );
});

test('automatic protection does not turn init jobs and migration dependencies into loops', () => {
  const source =
    'services:\n  web:\n    image: nginx:alpine\n    depends_on:\n      init:\n        condition: service_completed_successfully\n  init:\n    image: postgres:17\n    command: [psql, --version]\n  explicit:\n    image: redis:7\n    restart: no\n  task:\n    image: nginx:alpine\n    deploy:\n      mode: replicated-job\n  unknown:\n    image: company/migration:1\n';
  const plan = planAutomaticRedundancy(source);
  const model = composeDocument(plan.source).model;
  for (const name of ['init', 'explicit', 'task', 'unknown']) {
    assert.equal(
      model.services[name].restart,
      composeDocument(source).model.services[name].restart,
    );
    assert.equal(plan.summary.services.find((row) => row.name === name).strategy, 'unchanged');
  }
});

test('automatic protocol detection does not treat TLS or arbitrary ports as plain HTTP', () => {
  assert.equal(
    detectRedundancyEndpoint({ image: 'nginx:alpine' }, { targetPort: 443 }).protocol,
    'tcp',
  );
  assert.equal(
    detectRedundancyEndpoint({ image: 'custom/service:1' }, { targetPort: 8080 }).protocol,
    'tcp',
  );
  assert.equal(
    detectRedundancyEndpoint({ image: 'nginx:alpine' }, { targetPort: 80 }).protocol,
    'http',
  );
});

test('automatic protection preserves explicit always policy and stays idempotent without replicas', () => {
  const source = 'services:\n  db:\n    image: postgres:17\n    restart: always\n';
  const plan = planAutomaticRedundancy(source);
  assert.equal(plan.source, source);
  assert.equal(plan.summary.changed, false);
});
