import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryObservations, capturesForContainer } from '../shared/inventory-observations.mjs';

test('captured flows remain inspectable but become historical once their capture ends', () => {
  const flow = {
    key: 'same-flow',
    source: 'host:a',
    target: 'host:b',
    lastAt: 20,
    packet: { id: 'p1' },
  };
  const capture = { id: 'capture-one', status: 'running', flows: [flow] };
  assert.equal(inventoryObservations([capture])[0].live, true);
  const ended = inventoryObservations([{ ...capture, status: 'completed' }])[0];
  assert.equal(ended.live, false);
  assert.equal(ended.packet.id, 'p1');
  assert.equal(ended.captureId, capture.id);
});

test('latest observation wins across captures without counting overlapping sessions twice', () => {
  const captures = [
    {
      id: 'new',
      status: 'completed',
      flows: [{ key: 'flow', source: 'h:a', target: 'h:b', lastAt: 30, count: 5 }],
    },
    {
      id: 'old',
      status: 'running',
      flows: [{ key: 'flow', source: 'h:a', target: 'h:b', lastAt: 10, count: 2 }],
    },
  ];
  assert.deepEqual(
    inventoryObservations(captures).map((f) => [f.captureId, f.count, f.live]),
    [['new', 5, false]],
  );
});

test('map keeps a bounded set of resolved flows and excludes unresolved endpoints', () => {
  const flows = Array.from({ length: 160 }, (_, i) => ({
    key: `${i}`,
    source: 'h:a',
    target: 'h:b',
    lastAt: i,
  }));
  flows.push({ key: 'external', source: 'h:a', target: null, lastAt: 500 });
  flows.push({ key: 'self', source: 'h:a', target: 'h:a', lastAt: 500 });
  const visible = inventoryObservations([{ id: 'capture', status: 'running', flows }]);
  assert.equal(visible.length, 150);
  assert.equal(visible[0].key, '10');
  assert.equal(visible.at(-1).key, '159');
});

test('targeted captures are matched by Docker ID and host, never by shared names', () => {
  const captures = [
    { id: 'local', targets: [{ hostId: 'local', containerId: 'abc', name: 'web' }] },
    { id: 'remote', targets: [{ hostId: 'remote', containerId: 'abc', name: 'web' }] },
    { id: 'old', targets: [{ hostId: 'local', containerId: 'old-id', name: 'web' }] },
  ];
  assert.deepEqual(
    capturesForContainer(captures, {
      hostId: 'local',
      id: 'local:abc',
      dockerId: 'abc',
      name: 'web',
    }).map((c) => c.id),
    ['local'],
  );
});
