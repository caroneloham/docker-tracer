import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  declarativeCpu,
  declarativeGpuIds,
  declarativeMemoryBytes,
  patchDeclarativeComposeResources,
} from '../shared/compose-resources.mjs';

const source = `services:
  ai:
    image: vllm/vllm-openai:test
    cpus: 1
    mem_limit: 2g
    memswap_limit: 4g
    command: [--model, test]
    deploy:
      replicas: 2
      resources:
        limits: {cpus: 1, memory: 2g}
        reservations:
          memory: 1g
          devices:
            - {driver: vendor, capabilities: [tpu], device_ids: [external]}
  db:
    image: redis:alpine
`;

test('declarative limits validate syntax and form bounds without a fictitious host', () => {
  assert.equal(declarativeCpu('1.5'), 1.5);
  assert.equal(declarativeMemoryBytes('1.5'), 1.5 * 1024 ** 3);
  for (const value of ['999', '1e3', '-1', '0', '1,5', '1.234'])
    assert.throws(() => declarativeCpu(value), /CPU/);
  for (const value of ['2048', '1e3', '-1', '0', '1,5', '0.001'])
    assert.throws(() => declarativeMemoryBytes(value), /RAM/);
  assert.deepEqual(declarativeGpuIds('0, GPU-1234abcd'), ['0', 'GPU-1234abcd']);
  for (const value of ['0,0', '../docker.sock', 'GPU-?', ''])
    assert.throws(() => declarativeGpuIds(value), /GPU/);
});

test('browser resource edits change only Compose declarations and never fetch hardware', () => {
  const previousFetch = global.fetch;
  global.fetch = () => {
    throw Error('browser resource editor must not fetch hardware');
  };
  try {
    const next = patchDeclarativeComposeResources(source, 'ai', {
      cpus: { mode: 'set', value: '2.5' },
      memory: { mode: 'set', value: '3' },
      gpu: { mode: 'selected', ids: 'GPU-1234abcd' },
      vllmFraction: 0.7,
    });
    const parsed = YAML.parse(next);
    assert.equal(parsed.services.ai.cpus, 2.5);
    assert.equal(parsed.services.ai.mem_limit, 3 * 1024 ** 3);
    assert.deepEqual(parsed.services.ai.deploy.resources.limits, {
      cpus: 2.5,
      memory: 3 * 1024 ** 3,
    });
    assert.deepEqual(parsed.services.ai.deploy.resources.reservations.devices[0], {
      driver: 'vendor',
      capabilities: ['tpu'],
      device_ids: ['external'],
    });
    assert.deepEqual(parsed.services.ai.deploy.resources.reservations.devices[1].device_ids, [
      'GPU-1234abcd',
    ]);
    assert.deepEqual(parsed.services.ai.command, [
      '--model',
      'test',
      '--gpu-memory-utilization',
      '0.7',
    ]);
    assert.deepEqual(parsed.services.db, { image: 'redis:alpine' });
  } finally {
    global.fetch = previousFetch;
  }
});

test('browser resource edits enforce existing Compose reservations and swap', () => {
  assert.throws(
    () =>
      patchDeclarativeComposeResources(source, 'ai', {
        memory: { mode: 'set', value: '0.5' },
      }),
    /réservation/,
  );
  assert.throws(
    () =>
      patchDeclarativeComposeResources(source, 'ai', {
        memory: { mode: 'set', value: '5' },
      }),
    /swap/,
  );
  const removed = YAML.parse(
    patchDeclarativeComposeResources(source, 'ai', {
      cpus: { mode: 'remove' },
      memory: { mode: 'remove' },
      gpu: { mode: 'all' },
    }),
  );
  assert.equal(removed.services.ai.cpus, undefined);
  assert.equal(removed.services.ai.mem_limit, undefined);
  assert.deepEqual(removed.services.ai.deploy.resources.limits, {});
  assert.equal(removed.services.ai.deploy.resources.reservations.devices[1].count, 'all');
  assert.equal(removed.services.ai.deploy.replicas, 2);
});
