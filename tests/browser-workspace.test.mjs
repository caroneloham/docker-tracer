import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserWorkspace } from '../shared/browser-workspace.mjs';
import { newNode } from '../shared/model.mjs';

const api = (workspace, path, method = 'GET', body, revision) =>
  workspace.handle(path, {
    method,
    body,
    headers: revision === undefined ? {} : { 'If-Match': String(revision) },
  });

test('full browser lab starts with the real editable topology and stays in memory', () => {
  const workspace = createBrowserWorkspace();
  const listing = api(workspace, '/api/projects');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.defaultId, 'atelier-01');
  assert.equal(listing.body.projects.length, 1);
  assert.equal(listing.body.projects[0].state, 'draft');
  assert.equal(listing.body.capabilities.composeProjects, true);
  const state = api(workspace, '/api/projects/atelier-01/state').body;
  assert.equal(state.topology.nodes.length, 6);
  assert.equal(api(workspace, '/api/projects/atelier-01/topology').body.nodes.length, 6);
  assert.equal(state.runtime.connected, false);
  assert.equal(state.runtime.deployed, false);
  const next = structuredClone(state.topology);
  next.nodes.push(newNode('nginx', 'extra-web', { x: 760, y: 20 }, 'extra-web'));
  assert.equal(api(workspace, '/api/projects/atelier-01/topology', 'PUT', next).status, 428);
  const saved = api(
    workspace,
    '/api/projects/atelier-01/topology',
    'PUT',
    next,
    state.project.revision,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.revision, 2);
  assert.equal(api(workspace, '/api/projects/atelier-01/topology', 'PUT', next, 1).status, 409);
  assert.equal(api(workspace, '/api/projects/atelier-01/state').body.topology.nodes.length, 7);
  const compose = api(workspace, '/api/projects/atelier-01/compose');
  assert.equal(compose.status, 200);
  assert.match(compose.body, /services:/);
  assert.equal(compose.contentType, 'text/yaml');
  assert.equal(
    api(createBrowserWorkspace(), '/api/projects/atelier-01/state').body.topology.nodes.length,
    6,
  );
});

test('projects can be created, cloned, archived, and restored without persistence', () => {
  const workspace = createBrowserWorkspace();
  const created = api(workspace, '/api/projects', 'POST', {
    name: 'Atelier vide',
    hostId: 'local',
    template: 'empty',
  });
  assert.equal(created.status, 201);
  const project = created.body.project;
  assert.equal(api(workspace, `/api/projects/${project.id}/state`).body.topology.nodes.length, 0);
  const clone = api(workspace, `/api/projects/${project.id}/clone`, 'POST', { name: 'Copie' });
  assert.equal(clone.status, 201);
  const archived = api(workspace, `/api/projects/${project.id}/archive`, 'POST', {
    revision: project.revision,
  });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.project.archivedAt);
  const restored = api(workspace, `/api/projects/${project.id}/restore`, 'POST', {
    revision: archived.body.project.revision,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.project.archivedAt, null);
  assert.equal(api(workspace, '/api/projects').body.projects.length, 3);
  assert.equal(
    api(workspace, '/api/projects', 'POST', { name: 'SSH', hostId: 'remote' }).status,
    400,
  );
});

test('Compose import, validation, map preview, draft save, and source export are real', () => {
  const workspace = createBrowserWorkspace();
  const source =
    'services:\n  web:\n    image: nginx:alpine\n    networks: [front]\n  api:\n    image: node:22-alpine\n    networks: [front]\nnetworks:\n  front: {}\n';
  const invalid = api(workspace, '/api/projects', 'POST', {
    name: 'Cassé',
    hostId: 'local',
    compose: { source: 'services: [invalid]', projectName: 'casse' },
  });
  assert.equal(invalid.status, 400);
  const created = api(workspace, '/api/projects', 'POST', {
    name: 'Boutique',
    hostId: 'local',
    compose: { source, projectName: 'boutique' },
  });
  assert.equal(created.status, 201);
  const project = created.body.project;
  assert.equal(project.kind, 'compose');
  assert.equal(project.containers, 2);
  assert.equal(project.networks, 1);
  const path = `/api/projects/${project.id}`;
  assert.equal(api(workspace, `${path}/compose/source`).body, source);
  const preview = api(
    workspace,
    `${path}/compose/preview`,
    'POST',
    { source, projectName: 'boutique' },
    1,
  );
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.services, ['web', 'api']);
  assert.ok(preview.body.graph.nodes.length >= 3);
  assert.equal(preview.body.dryRunSucceeded, false);
  assert.equal(preview.body.token, null);
  const updatedSource = source.replace('nginx:alpine', 'nginx:stable-alpine');
  const saved = api(
    workspace,
    `${path}/compose/source`,
    'PUT',
    { source: updatedSource, projectName: 'boutique' },
    1,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.revision, 2);
  assert.equal(api(workspace, `${path}/compose/source`).body, updatedSource);
  assert.equal(
    api(
      workspace,
      `${path}/compose/source`,
      'PUT',
      { source: 'bad: [', projectName: 'boutique' },
      2,
    ).status,
    400,
  );
  assert.equal(api(workspace, `${path}/compose/source`).body, updatedSource);
});

test('browser mode explicitly refuses all Docker, SSH, deployment, capture, and remote operations', () => {
  const workspace = createBrowserWorkspace();
  for (const [path, method] of [
    ['/api/projects/atelier-01/deploy', 'POST'],
    ['/api/projects/atelier-01/lab/apply', 'POST'],
    ['/api/projects/atelier-01/capture', 'POST'],
    ['/api/projects/atelier-01/probe', 'POST'],
    ['/api/hosts/local/inventory', 'GET'],
    ['/api/workspace/inventory', 'GET'],
  ]) {
    const response = api(workspace, path, method, {});
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.match(response.body.error, /Docker Tracer local/);
  }
  assert.equal(api(workspace, '/api/hosts').body[0].kind, 'browser');
  assert.ok(api(workspace, '/api/catalog/templates').body.length > 0);
  assert.ok(api(workspace, '/api/catalog/images').body.length > 0);
  assert.ok(api(workspace, '/api/catalog').body.templates.length > 0);
});
