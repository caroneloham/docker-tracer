import test from 'node:test';
import assert from 'node:assert/strict';
import { findEditableProject } from '../shared/inventory-editing.mjs';

const source = { hostId: 'client-a', service: 'web', originalProjectKey: 'compose:site' };
const project = { id: 'one', kind: 'compose', hostId: 'client-a', composeProjectName: 'site' };

test('inventory editing uses the Docker project identity and the exact host', () => {
  assert.deepEqual(
    findEditableProject(source, [{ ...project, id: 'other-host', hostId: 'client-b' }, project]),
    { project, nodeId: 'service:web' },
  );
  assert.equal(
    findEditableProject(source, [{ ...project, composeProjectName: 'elsewhere', name: 'site' }]),
    null,
  );
});

test('inventory editing excludes probes, archives and ambiguous owners', () => {
  assert.equal(findEditableProject({ ...source, isProbe: true }, [project]), null);
  assert.equal(findEditableProject(source, [{ ...project, archivedAt: '2026-09-19' }]), null);
  assert.equal(findEditableProject(source, [project, { ...project, id: 'duplicate' }]), null);
  assert.equal(findEditableProject({ ...source, service: '' }, [project]), null);
});

test('inventory editing opens the service in its managed graphical laboratory', () => {
  const lab = { id: 'lab-a', kind: 'graph', hostId: 'client-a' };
  assert.deepEqual(findEditableProject({ ...source, labId: 'lab-a' }, [lab]), {
    project: lab,
    nodeId: 'web',
  });
  assert.equal(findEditableProject({ ...source, labId: 'other-lab' }, [lab]), null);
});
