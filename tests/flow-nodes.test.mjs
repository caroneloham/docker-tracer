import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNodeChanges } from '@xyflow/react';
import { adoptUserNodes, nodeHasDimensions } from '@xyflow/system';
import { reconcileFlowNodes } from '../shared/flow-nodes.mjs';

const service = (overrides = {}) => ({
  id: 'service:webui',
  type: 'composeDevice',
  position: { x: 80, y: 120 },
  data: { state: 'running' },
  ...overrides,
});

test('a graph refresh preserves React Flow visibility and connection handles', () => {
  const measured = service({ measured: { width: 120, height: 105 } });
  const lookup = new Map();
  const parents = new Map();
  adoptUserNodes([measured], lookup, parents);
  const handles = { source: [{ id: 'right', x: 120, y: 50 }], target: [] };
  lookup.get(measured.id).internals.handleBounds = handles;

  const fresh = service({ selected: true, data: { state: 'restarting' } });
  const next = reconcileFlowNodes([measured], [fresh]);
  adoptUserNodes(next, lookup, parents);
  assert.equal(nodeHasDimensions(lookup.get(measured.id)), true);
  assert.equal(lookup.get(measured.id).internals.handleBounds, handles);
  assert.equal(next[0].data.state, 'restarting');
  assert.equal(next[0].selected, true);

  // Reproduces the original bug with the same installed React Flow engine.
  adoptUserNodes([fresh], lookup, parents);
  assert.equal(nodeHasDimensions(lookup.get(measured.id)), false);
  assert.equal(lookup.get(measured.id).internals.handleBounds, undefined);
});

test('polling during a drag keeps its position; release and later edits stay authoritative', () => {
  const original = service({ measured: { width: 120, height: 105 } });
  let local = applyNodeChanges(
    [{ id: original.id, type: 'position', position: { x: 230, y: 190 }, dragging: true }],
    [original],
  );
  local = reconcileFlowNodes(local, [service({ data: { state: 'exited' } })]);
  assert.deepEqual(local[0].position, { x: 230, y: 190 });
  assert.equal(local[0].dragging, true);
  assert.equal(local[0].data.state, 'exited');

  const destination = { x: 310, y: 210 };
  local = applyNodeChanges(
    [{ id: original.id, type: 'position', position: destination, dragging: false }],
    local,
  );
  local = reconcileFlowNodes(local, [service({ position: destination })]);
  assert.deepEqual(local[0].position, destination);
  assert.equal(local[0].dragging, false);
  assert.deepEqual(local[0].measured, original.measured);

  // Re-layout or loading a saved position must work once the drag has ended.
  local = reconcileFlowNodes(local, [service({ position: { x: 500, y: 60 } })]);
  assert.deepEqual(local[0].position, { x: 500, y: 60 });
  assert.deepEqual(original.position, { x: 80, y: 120 });
});

test('reconciliation follows topology changes and does not reuse a different node type size', () => {
  const before = [
    service({ measured: { width: 120, height: 105 }, dragging: true }),
    service({ id: 'service:removed', measured: { width: 120, height: 105 } }),
  ];
  const added = service({ id: 'network:private', type: 'network' });
  const changed = service({ type: 'inventory', position: { x: 900, y: 90 } });
  const next = reconcileFlowNodes(before, [changed, added]);
  assert.deepEqual(
    next.map((node) => node.id),
    [changed.id, added.id],
  );
  assert.equal(next[0].measured, undefined);
  assert.equal(next[0].dragging, undefined);
  assert.equal(next[0].position, changed.position);
  assert.equal(next[1], added);
});
