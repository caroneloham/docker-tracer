import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceObservationActivity,
  captureSelection,
  captureCoversTargets,
  captureObservationSummary,
  MAX_MOVING_ENVELOPES,
  OBSERVATION_MOTION_MS,
  groupedInventoryObservations,
  observationLanes,
  observationEdgePath,
} from '../shared/inventory-live.mjs';

const now = 10000;
const flow = (overrides = {}) => ({
  key: 'tcp-a-b',
  captureId: 'capture-one',
  source: 'local:a',
  target: 'local:b',
  count: 3,
  lastAt: now,
  live: true,
  packet: { id: 'p3', time: now },
  ...overrides,
});
const container = (id, overrides = {}) => ({
  id: `local:${id}`,
  dockerId: id,
  hostId: 'local',
  state: 'running',
  ...overrides,
});

test('HTTP, TCP and ARP evidence in both directions has separate stable clickable positions', () => {
  const flows = ['HTTP', 'TCP', 'ARP'].flatMap((protocol) => [
    flow({ key: `${protocol}-out`, protocol, packet: { id: `${protocol}-request`, protocol } }),
    flow({
      key: `${protocol}-in`,
      source: 'local:b',
      target: 'local:a',
      protocol,
      packet: { id: `${protocol}-response`, protocol },
    }),
  ]);
  const lanes = observationLanes(flows);
  const reordered = observationLanes(
    [...flows].reverse().map((flow) => ({ ...flow, count: flow.count + 10 })),
  );
  for (const flow of flows) assert.deepEqual(lanes.get(flow.key), reordered.get(flow.key));
  for (const [targetX, targetY] of [
    [140, 0],
    [0, 140],
    [140, 140],
  ]) {
    const labels = flows.map((flow) => {
      const points =
        flow.source === 'local:a'
          ? { sourceX: 0, sourceY: 0, targetX, targetY }
          : { sourceX: targetX, sourceY: targetY, targetX: 0, targetY: 0 };
      const [path, x, y] = observationEdgePath(points, lanes.get(flow.key));
      assert.ok(path.startsWith(`M ${points.sourceX},${points.sourceY} Q `));
      assert.ok(path.endsWith(` ${points.targetX},${points.targetY}`));
      return { x, y, flow };
    });
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i],
          b = labels[j];
        assert.ok(
          Math.abs(a.x - b.x) >= 72 || Math.abs(a.y - b.y) >= 42,
          `${a.flow.key} overlaps ${b.flow.key}`,
        );
      }
    assert.equal(
      labels.find((label) => label.flow.key === 'HTTP-out').flow.packet.id,
      'HTTP-request',
    );
  }
});

test('connections with changing client ports share one proven directional envelope', () => {
  const capture = {
    id: 'new',
    status: 'running',
    flows: [
      flow({
        key: 'port-one',
        sourcePort: '40001',
        protocol: 'TCP',
        count: 3,
        bytes: 180,
        lastAt: 10,
        packet: { id: 'old', time: 10 },
      }),
      flow({
        key: 'port-two',
        sourcePort: '40002',
        protocol: 'TCP',
        count: 5,
        bytes: 300,
        lastAt: 20,
        packet: { id: 'latest', time: 20 },
      }),
      flow({ key: 'reply', source: 'local:b', target: 'local:a', protocol: 'TCP', count: 2 }),
    ],
  };
  const grouped = groupedInventoryObservations([capture]);
  assert.equal(grouped.length, 2);
  const request = grouped.find((item) => item.source === 'local:a');
  assert.equal(request.count, 8);
  assert.equal(request.connections, 2);
  assert.equal(request.bytes, 480);
  assert.equal(request.packet.id, 'latest');
  assert.equal(request.captureId, 'new');
});

test('grouped evidence uses one capture without inflating overlapping session counts', () => {
  const captures = [
    { id: 'old', status: 'completed', flows: [flow({ count: 100, lastAt: 5 })] },
    { id: 'new', status: 'running', flows: [flow({ count: 7, lastAt: 20 })] },
  ];
  const [grouped] = groupedInventoryObservations(captures);
  assert.equal(grouped.count, 7);
  assert.equal(grouped.captureId, 'new');
  assert.equal(grouped.live, true);
});

test('one burst represents newly captured packets, never another inventory render', () => {
  const first = advanceObservationActivity(null, [flow()], now);
  assert.equal(first.bursts.length, 1);
  assert.equal(first.bursts[0].count, 1);
  const unchanged = advanceObservationActivity(first, [flow()], now + 100);
  assert.deepEqual(unchanged.bursts, first.bursts);
  const next = advanceObservationActivity(
    unchanged,
    [flow({ count: 8, packet: { id: 'p8', time: now + 400 } })],
    now + 400,
  );
  assert.equal(next.bursts.length, 1);
  assert.equal(next.bursts[0].count, 5);
  assert.equal(next.bursts[0].id, 'capture-one:p8');
  const expired = advanceObservationActivity(first, [flow()], now + OBSERVATION_MOTION_MS);
  assert.equal(expired.bursts.length, 0);
});

test('historical, delayed, future and disconnected observations never animate', () => {
  for (const observation of [
    flow({ live: false }),
    flow({ packet: { id: 'old', time: now - 4001 } }),
    flow({ packet: { id: 'future', time: now + 1001 } }),
    flow({ packet: null }),
  ])
    assert.equal(advanceObservationActivity(null, [observation], now).bursts.length, 0);
  const offline = advanceObservationActivity(null, [flow()], now, false);
  assert.equal(offline.bursts.length, 0);
  assert.equal(advanceObservationActivity(offline, [flow()], now + 100, true).bursts.length, 0);
  const active = advanceObservationActivity(null, [flow()], now);
  assert.equal(
    advanceObservationActivity(active, [flow({ live: false })], now + 10).bursts.length,
    0,
  );
});

test('late snapshots do not reset the evidence cursor or create repeated arrivals', () => {
  const first = advanceObservationActivity(null, [flow()], now);
  const late = advanceObservationActivity(
    first,
    [flow({ count: 1, packet: { id: 'p1', time: now - 100 } })],
    now + 1,
  );
  const current = advanceObservationActivity(late, [flow()], now + OBSERVATION_MOTION_MS);
  assert.equal(current.bursts.length, 0);
  const newerSession = advanceObservationActivity(
    current,
    [flow({ captureId: 'capture-two' })],
    now + OBSERVATION_MOTION_MS,
  );
  assert.equal(newerSession.bursts.length, 1);
});

test('a busy capture keeps animation and evidence cursor bounded', () => {
  const flows = Array.from({ length: 150 }, (_, index) =>
    flow({ key: String(index), packet: { id: `p${index}`, time: now } }),
  );
  const state = advanceObservationActivity(null, flows, now);
  assert.equal(state.bursts.length, MAX_MOVING_ENVELOPES);
  assert.equal(state.seen.size, 150);
  assert.equal(advanceObservationActivity(state, [], now + 1).seen.size, 0);
});

test('capture selection rejects missing, stale, stopped, probe and cross-host targets', () => {
  const a = container('a');
  const b = container('b');
  assert.deepEqual(captureSelection([a, b], [a.id, b.id]).targets, [a, b]);
  assert.deepEqual(captureSelection([a], [a.id, a.id]).targets, [a]);
  for (const ids of [[], ['missing'], [a.id, b.id, 'third']])
    assert.ok(captureSelection([a, b], ids).error);
  for (const overrides of [
    { stale: true },
    { state: 'exited' },
    { isProbe: true },
    { hostId: 'remote' },
  ])
    assert.ok(captureSelection([a, { ...b, ...overrides }], [a.id, b.id]).error);
});

test('a single-target session does not silently replace a requested two-target capture', () => {
  const a = container('a'),
    b = container('b');
  const capture = { status: 'running', targets: [{ hostId: 'local', containerId: 'a' }] };
  assert.equal(captureCoversTargets(capture, [a]), true);
  assert.equal(captureCoversTargets(capture, [a, b]), false);
  assert.equal(captureCoversTargets({ ...capture, status: 'completed' }, [a]), false);
  assert.equal(captureCoversTargets(capture, [container('a', { hostId: 'remote' })]), false);
});

test('summary distinguishes hidden map flows, unresolved packets and truncated evidence', () => {
  const capture = {
    id: 'capture-one',
    status: 'running',
    count: 12,
    truncated: true,
    errors: ['Sonde interrompue'],
    flows: [
      flow({ count: 3 }),
      flow({ key: 'hidden', target: 'local:c', count: 4 }),
      flow({ key: 'external', target: null, count: 5 }),
    ],
  };
  const summary = captureObservationSummary([capture], ['local:a', 'local:b']);
  assert.equal(summary.mapped.length, 1);
  assert.equal(summary.hidden, 1);
  assert.equal(summary.packets, 12);
  assert.equal(summary.unresolved, 5);
  assert.equal(summary.warnings.length, 2);
});
