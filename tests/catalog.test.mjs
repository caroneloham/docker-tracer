import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalog,
  buildCatalogProject,
  generateCatalogPassword,
  newCatalogProjectName,
  suggestCatalogPort,
  catalogConnection,
  catalogErrorMessage,
} from '../shared/catalog.mjs';
import { composeDocument, composeGraph, patchComposeService } from '../shared/compose-project.mjs';
const defaults = {
  name: 'Mon application',
  hostId: 'local',
  projectName: 'catalog-test',
  port: 18880,
  password: 'very-long-app-password',
  rootPassword: 'different-long-root-password',
};
test('catalogue : erreurs de port et de téléchargement expliquées sans inventer une panne applicative', () => {
  assert.match(
    catalogErrorMessage('Bind for 127.0.0.1:8081 failed: port is already allocated'),
    /Modifier les réglages/,
  );
  assert.match(catalogErrorMessage('manifest unknown'), /nom, sa version/);
  assert.match(catalogErrorMessage('SSH timed out'), /Vérifie l’état/);
  assert.equal(catalogErrorMessage('Nom invalide.'), 'Nom invalide.');
});
test('catalogue : chaque recette conserve une infrastructure Compose entièrement éditable', () => {
  for (const item of catalog) {
    const project = buildCatalogProject({ ...defaults, templateId: item.id }),
      model = composeDocument(project.compose.source).model;
    assert.equal(Object.keys(model.services).length, item.services);
    assert.equal(model['x-docker-tracer-catalog'].id, item.id);
    assert.ok(composeGraph(project.compose.source).nodes.length > 1);
    for (const s of Object.values(model.services))
      for (const port of s.ports || []) assert.equal(port.host_ip, '127.0.0.1');
    const service = Object.keys(model.services)[0],
      patched = composeDocument(
        patchComposeService(project.compose.source, service, 'mem_limit', '1g'),
      ).model;
    assert.equal(patched.services[service].mem_limit, '1g');
    assert.deepEqual(patched.volumes, model.volumes);
    assert.ok(!project.compose.source.includes(defaults.password));
  }
});
test('catalogue : un service au nom hérité ne lit pas les propriétés du prototype', () => {
  const source =
    'services:\n  web:\n    image: nginx\nx-docker-tracer-catalog:\n  id: wordpress\n  access:\n    protocol: http\n    target: 80\n    service: constructor\n';
  assert.doesNotThrow(() =>
    catalogConnection({ source }, { connected: false, services: {} }, { kind: 'local' }),
  );
  assert.equal(
    catalogConnection({ source }, { connected: true, services: {} }, { kind: 'local' }).url,
    undefined,
  );
});
test('catalogue : WordPress et MariaDB partagent seulement le réseau prévu, base non publiée', () => {
  const m = composeDocument(
    buildCatalogProject({ ...defaults, templateId: 'wordpress', exposure: 'network' }).compose
      .source,
  ).model;
  assert.equal(m.services.database.ports, undefined);
  assert.deepEqual(m.services.database.networks, ['database']);
  assert.equal(m.networks.database.internal, true);
  assert.equal(m.services.wordpress.ports[0].host_ip, '0.0.0.0');
  assert.equal(m.services.wordpress.depends_on.database.condition, 'service_healthy');
  assert.notEqual(
    m.services.database.environment.MARIADB_PASSWORD,
    m.services.database.environment.MARIADB_ROOT_PASSWORD,
  );
});
test('catalogue : secrets aléatoires, noms uniques, validation et ports déjà publiés', () => {
  assert.notEqual(generateCatalogPassword(), generateCatalogPassword());
  assert.equal(generateCatalogPassword().length, 48);
  assert.equal(newCatalogProjectName('Mon réseau $', 'ab1234'), 'mon-reseau-ab1234');
  assert.equal(
    suggestCatalogPort(8080, [{ ports: [{ host: 8080 }, { host: 8081 }, { host: null }] }]),
    8082,
  );
  assert.throws(() => buildCatalogProject({ ...defaults, templateId: 'redis', password: '123' }));
  assert.throws(() => buildCatalogProject({ ...defaults, templateId: 'custom', volumePath: '/' }));
  assert.throws(() => buildCatalogProject({ ...defaults, templateId: 'nginx', port: 70000 }));
  assert.throws(() =>
    buildCatalogProject({ ...defaults, templateId: 'wordpress', rootPassword: defaults.password }),
  );
});
test('catalogue : le titre web reste du texte et les dollars Compose restent littéraux', () => {
  const m = composeDocument(
    buildCatalogProject({ ...defaults, templateId: 'nginx', name: '<script>$HOME ${x}</script>' })
      .compose.source,
  ).model;
  assert.match(m.configs.homepage.content, /&lt;script&gt;\$\$HOME \$\$\{x\}/);
  assert.doesNotMatch(m.configs.homepage.content, /<script>/);
});
test('accès application : ports observés, état réel, serveur SSH et brouillon indépendant', () => {
  const compose = buildCatalogProject({ ...defaults, templateId: 'nginx' }).compose;
  const runtime = {
    connected: true,
    services: {
      web: [
        {
          state: 'running',
          ports: [{ container: 80, protocol: 'tcp', host: 19999, hostIp: '127.0.0.1' }],
        },
      ],
    },
  };
  assert.equal(
    catalogConnection(compose, runtime, { kind: 'local' }).url,
    'http://127.0.0.1:19999/',
  );
  assert.equal(
    catalogConnection(compose, runtime, { kind: 'ssh', address: 'nas.local' }).url,
    undefined,
  );
  runtime.services.web[0].ports[0].hostIp = '0.0.0.0';
  assert.equal(
    catalogConnection(compose, runtime, { kind: 'ssh', address: 'nas.local' }).url,
    'http://nas.local:19999/',
  );
  assert.equal(
    catalogConnection(compose, runtime, { kind: 'ssh', address: 'evil.com/redirect' }).url,
    undefined,
  );
  assert.equal(
    catalogConnection(compose, { ...runtime, connected: false }, { kind: 'local' }).url,
    undefined,
  );
  assert.equal(
    catalogConnection({ source: 'broken YAML', lastApplied: compose }, runtime, { kind: 'local' })
      .url,
    'http://127.0.0.1:19999/',
  );
  runtime.services.web[0].state = 'exited';
  assert.equal(catalogConnection(compose, runtime, { kind: 'local' }).url, undefined);
});
