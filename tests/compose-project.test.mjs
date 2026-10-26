import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  composeDocument,
  patchComposeService,
  addComposeObject,
  composeGraph,
  patchComposeObject,
  connectComposeNetwork,
  removeComposeObject,
} from '../shared/compose-project.mjs';
import { composeEnvironment } from '../server/compose-runner.mjs';
import { openProjectStore } from '../server/project-store.mjs';

const source = `# Référence à conserver\nx-base: &base\n  image: nginx:alpine\n  environment:\n    LITERAL: '$$host'\n  healthcheck:\n    test: [CMD, wget, -q, -O, /dev/null, http://localhost]\nservices:\n  front: *base\n  other:\n    <<: *base\n    depends_on: [front]\n    labels:\n      custom: exact\nvolumes:\n  shared:\n    external: true\n`;
test('Compose graphique : préserve les champs, commentaires et ancres des autres services', () => {
  const before = composeDocument(source).model,
    changed = patchComposeService(source, 'front', 'image', 'nginx:stable-alpine'),
    after = composeDocument(changed).model;
  assert.equal(after.services.front.image, 'nginx:stable-alpine');
  assert.deepEqual(after.services.other, before.services.other);
  assert.deepEqual(after.volumes, before.volumes);
  assert.match(changed, /# Référence à conserver/);
  assert.equal(after.services.front.environment.LITERAL, '$$host');
  assert.deepEqual(after.services.front.healthcheck, before.services.front.healthcheck);
  const more = addComposeObject(changed, 'services', 'cache');
  assert.equal(composeDocument(more).model.services.cache.image, 'nginx:alpine');
  assert.throws(() => addComposeObject(more, 'services', 'cache'), /déjà/);
});
test('Compose : carte des réseaux configurés, sans liaison physique inventée', () => {
  const graph = composeGraph(
    'services:\n  web:\n    image: nginx\n  isolated:\n    image: alpine\n    network_mode: none\n  shared:\n    image: alpine\n    network_mode: service:web\n',
  );
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].target, 'network:default');
  assert.throws(() => composeDocument('services:\n  a: {}\n  a: {}'), /unique|Map keys/);
});
test('Compose : modifier le propriétaire d’une ancre ne modifie pas les autres services', () => {
  const source =
    'services:\n  first: &app\n    image: alpine\n    environment: &vars\n      A: original\n  second: *app\n  third:\n    image: nginx\n    environment: *vars\n';
  const result = composeDocument(
    patchComposeService(source, 'first', 'environment', { A: 'changed' }),
  ).model;
  assert.equal(result.services.first.environment.A, 'changed');
  assert.equal(result.services.second.environment.A, 'original');
  assert.equal(result.services.third.environment.A, 'original');
});
test('Compose : édition des réseaux, isolation explicite et suppression avec dépendances', () => {
  let source = 'services:\n  web:\n    image: nginx\nnetworks:\n  app: {}\n';
  source = patchComposeObject(source, 'networks', 'default', 'internal', true);
  source = connectComposeNetwork(source, 'web', 'app', true);
  source = connectComposeNetwork(source, 'web', 'default', false);
  assert.deepEqual(Object.keys(composeDocument(source).model.services.web.networks), ['app']);
  assert.throws(() => removeComposeObject(source, 'networks', 'app'), /utilise encore/);
  source = connectComposeNetwork(source, 'web', 'app', false);
  assert.equal(composeDocument(source).model.services.web.network_mode, 'none');
  assert.equal(composeGraph(source).edges.length, 0);
  assert.doesNotThrow(() => removeComposeObject(source, 'networks', 'app'));
});
test('Compose : aucune variable secrète du serveur héritée, cible CLI non modifiable par variables', () => {
  process.env.DTR_TEST_PRIVATE_SECRET = 'never inherit';
  try {
    const env = composeEnvironment({ APP_TOKEN: 'explicit' });
    assert.equal(env.DTR_TEST_PRIVATE_SECRET, undefined);
    assert.equal(env.APP_TOKEN, 'explicit');
    assert.throws(() => composeEnvironment({ DOCKER_HOST: 'tcp://wrong' }), /réservée/);
    assert.throws(() => composeEnvironment({ COMPOSE_FILE: 'elsewhere' }), /réservée/);
  } finally {
    delete process.env.DTR_TEST_PRIVATE_SECRET;
  }
});
test('projet Compose : source exacte sur disque, cible unique et immuable, historique de schéma séparé', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-compose-store-'));
  try {
    const store = await openProjectStore(dir),
      p = await store.create({
        name: 'Compose',
        hostId: 'local',
        compose: { source, projectName: 'example-unique' },
      });
    assert.equal(p.compose.source, source);
    assert.equal(p.topology.nodes.length, 0);
    const reopened = await openProjectStore(dir);
    assert.equal(reopened.get(p.id).compose.source, source);
    await assert.rejects(
      store.create({
        name: 'Duplicate',
        hostId: 'local',
        compose: { source, projectName: 'example-unique' },
      }),
      /déjà rattaché/,
    );
    await assert.rejects(
      store.update(p.id, p.revision, (r) => {
        r.compose.projectName = 'changed';
      }),
      /immuables/,
    );
    await assert.rejects(store.create({ name: 'Copy', hostId: 'local', copyFrom: p.id }), /import/);
  } finally {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-compose-store-'))
      throw Error('Unexpected path');
    await rm(dir, { recursive: true, force: true });
  }
});
