import test from 'node:test';
import assert from 'node:assert/strict';
import { addContainerToCompose, suggestedServiceName } from '../shared/add-container.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
test('ajout conserve les services, commentaires, options et réseau existants', () => {
  const input =
    '# Configuration client\nservices:\n  web:\n    image: nginx:alpine\n    custom: keep\nnetworks:\n  attached_network: {}\n';
  const out = addContainerToCompose(input, {
    name: 'cache',
    image: 'redis:7-alpine',
    network: 'client-backend',
    environment: 'TOKEN=a$b\nMODE=test',
    containerPort: 6379,
    hostPort: 16379,
  });
  const { model } = composeDocument(out);
  assert.match(out, /# Configuration client/);
  assert.equal(model.services.web.custom, 'keep');
  assert.deepEqual(model.services.cache.networks, ['attached_network_2']);
  assert.equal(model.networks.attached_network_2.name, 'client-backend');
  assert.equal(model.services.cache.environment.TOKEN, 'a$$b');
  assert.equal(model.services.cache.pull_policy, 'missing');
  assert.deepEqual(model.services.cache.ports, [
    { target: 6379, published: '16379', host_ip: '127.0.0.1', protocol: 'tcp' },
  ]);
});
test('ajout refuse collision, interpolation image, ports invalides et doublons de variables', () => {
  const source = 'services:\n  web:\n    image: nginx:alpine\n';
  for (const extra of [
    { name: 'web' },
    { image: '${IMAGE}' },
    { hostPort: 8080 },
    { containerPort: 70000 },
    { environment: 'X=1\nX=2' },
  ])
    assert.throws(() =>
      addContainerToCompose(source, { name: 'cache', image: 'redis:7', ...extra }),
    );
});
test('ajout réutilise un réseau externe sans publier de port implicitement', () => {
  const { model } = composeDocument(
    addContainerToCompose(
      'services: {}\nnetworks:\n  shared:\n    external: true\n    name: clients\n',
      { name: 'worker', image: 'example/worker:1', network: 'clients' },
    ),
  );
  assert.deepEqual(model.services.worker.networks, ['shared']);
  assert.equal(model.services.worker.ports, undefined);
  assert.equal(Object.keys(model.networks).length, 1);
});

test('ajout utilise directement un réseau déclaré du projet avant son déploiement', () => {
  const input = 'services: {}\nnetworks:\n  backend:\n    internal: true\n';
  const { model } = composeDocument(
    addContainerToCompose(input, { name: 'worker', image: 'redis', networkKey: 'backend' }),
  );
  assert.deepEqual(model.services.worker.networks, ['backend']);
  assert.equal(model.services.worker.image, 'redis:latest');
  assert.deepEqual(model.networks, { backend: { internal: true } });
  assert.throws(
    () => addContainerToCompose(input, { name: 'worker', image: 'redis', networkKey: 'missing' }),
    /réseau du projet a changé/,
  );
  assert.throws(
    () =>
      addContainerToCompose(input, {
        name: 'worker',
        image: 'redis',
        networkKey: 'backend',
        network: 'other',
      }),
    /seul réseau/,
  );
});

test('ajout accepte références précises et refuse URL, faux digest et nom invalide', () => {
  const input = 'services: {}\n',
    digest = `ghcr.io/team/web@sha256:${'a'.repeat(64)}`;
  const { model } = composeDocument(addContainerToCompose(input, { name: 'web', image: digest }));
  assert.equal(model.services.web.image, digest);
  for (const image of [
    'https://registry.test/app',
    'user:password@registry.test/app',
    'nginx@sha256:123',
    'nginx:',
    'NGINX:latest',
  ])
    assert.throws(() => addContainerToCompose(input, { name: 'web', image }));
  assert.equal(suggestedServiceName(digest), 'web');
  assert.equal(suggestedServiceName('registry.test:5000/team/web:stable'), 'web');
});
