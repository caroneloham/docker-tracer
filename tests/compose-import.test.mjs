import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSE_IMPORT_LIMIT,
  readComposeImportFile,
  summarizeComposeImport,
} from '../shared/compose-import.mjs';

const file = (name, content) => {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    name,
    size: bytes.length,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
};

test('import Compose : YAML UTF-8 borné, extension et contenu binaire contrôlés', async () => {
  const source = '# commentaire à conserver\nservices:\n  client:\n    image: alpine:3.23\n';
  assert.deepEqual(await readComposeImportFile(file('mon-infra.YAML', source)), {
    filename: 'mon-infra.YAML',
    source,
  });
  await assert.rejects(readComposeImportFile(file('compose.json', source)), /yaml.*yml/);
  await assert.rejects(
    readComposeImportFile(file('compose.yaml', Buffer.from([0xff, 0x80]))),
    /UTF-8/,
  );
  await assert.rejects(
    readComposeImportFile(file('compose.yaml', Buffer.from([0, 65]))),
    /binaires/,
  );
  await assert.rejects(
    readComposeImportFile({
      name: 'compose.yaml',
      size: COMPOSE_IMPORT_LIMIT + 1,
      arrayBuffer() {
        throw Error('must not read');
      },
    }),
    /2 Mio/,
  );
  await assert.rejects(
    readComposeImportFile({
      name: 'compose.yaml',
      size: 0,
      async arrayBuffer() {
        return new ArrayBuffer(COMPOSE_IMPORT_LIMIT + 1);
      },
    }),
    /2 Mio/,
  );
});

test('import Compose : récap fidèle des services, ports, montages et ancres sans interpolation', () => {
  const source = `name: maison\nx-base: &base\n  image: nginx:alpine\nservices:\n  web:\n    <<: *base\n    ports: ["127.0.0.1:8080:80"]\n    volumes: ["html:/usr/share/nginx/html:ro"]\n  api:\n    image: mon-api:stable\n    ports:\n      - target: 8000\n        published: "8001"\n        protocol: tcp\n    volumes:\n      - type: bind\n        source: ./config\n        target: /config\nvolumes:\n  html: {}\n`;
  const summary = summarizeComposeImport(source, 'compose.yaml');
  assert.equal(summary.projectName, 'maison');
  assert.equal(summary.name, 'maison');
  assert.equal(summary.services.length, 2);
  assert.equal(summary.services[0].image, 'nginx:alpine');
  assert.deepEqual(summary.services[0].ports, ['127.0.0.1:8080:80']);
  assert.deepEqual(summary.services[1].ports, ['8001 → 8000/tcp']);
  assert.deepEqual(summary.volumes, ['html']);
  assert.deepEqual(summary.dependencies, [
    { kind: 'Dossier monté', path: './config', service: 'api', relative: true },
  ]);
  assert.equal(summary.needsDirectory, true);
  assert.equal(
    summarizeComposeImport(source.replace('name: maison\n', ''), 'Mon Réseau.yaml').projectName,
    'mon-reseau',
  );
});

test('import Compose : dépendances externes et variables signalées sans divulguer les valeurs', () => {
  const source = `services:\n  app:\n    image: alpine:3.23\n    env_file:\n      - path: .env.app\n    environment:\n      PASSWORD: super-secret-value\n      INHERITED:\n      URL: "http://\${HOST}:\${PORT:-8080}"\n      TOKEN: "\${TOKEN:?requis}"\n      OPTIONAL: "\${OPT+yes}"\n      LITERAL: "$$LITERAL"\n    build: ./app\n    extends:\n      file: other.yaml\n      service: base\n    volumes:\n      - /srv/data:/data\n      - ./config:/config\n      - named:/named\nconfigs:\n  config:\n    file: ./application.ini\nsecrets:\n  key:\n    file: ./client.pem\ninclude:\n  - ./extra.yaml\n`;
  const summary = summarizeComposeImport(source);
  assert.ok(summary.dependencies.some((entry) => entry.path === '.env.app'));
  assert.ok(summary.dependencies.some((entry) => entry.path === './app' && entry.kind === 'Build'));
  assert.ok(summary.dependencies.some((entry) => entry.path === './application.ini'));
  assert.ok(summary.dependencies.some((entry) => entry.path === './client.pem'));
  assert.ok(summary.dependencies.some((entry) => entry.path === 'other.yaml'));
  assert.ok(summary.dependencies.some((entry) => entry.path === './extra.yaml'));
  assert.ok(summary.dependencies.some((entry) => entry.path === '/srv/data' && !entry.relative));
  assert.ok(!summary.dependencies.some((entry) => entry.path === 'named'));
  assert.deepEqual(
    Object.fromEntries(summary.variables.map((entry) => [entry.name, entry.required])),
    { HOST: true, PORT: false, TOKEN: true, OPT: false, INHERITED: true },
  );
  assert.ok(!JSON.stringify(summary).includes('super-secret-value'));
  assert.ok(!JSON.stringify(summary).includes('LITERAL'));
});

test('import Compose : chemins Windows, URL de build et profils distingués', () => {
  const summary = summarizeComposeImport(
    `services:\n  win:\n    image: alpine\n    volumes: ['C:\\data:/data']\n    profiles: [debug]\n  remote:\n    build: https://example.com/repo.git\n    environment: [FROM_ENV, 'VALUE=fixed']\n`,
  );
  assert.equal(summary.needsDirectory, false);
  assert.deepEqual(summary.profiles, ['debug']);
  assert.deepEqual(summary.dependencies, [
    { kind: 'Dossier monté', path: 'C:\\data', service: 'win', relative: false },
  ]);
  assert.deepEqual(summary.variables, [{ name: 'FROM_ENV', required: true }]);
  assert.ok(summary.warnings.some((message) => /profil/.test(message)));
});

test('import Compose : erreurs YAML et doublons refusés avant toute création', () => {
  for (const source of [
    'services: [',
    'services:\n  web: {image: nginx}\n  web: {image: redis}\n',
    '- not-a-compose',
    'services:\n  web:\n    ports: wrong',
  ])
    assert.throws(() => summarizeComposeImport(source));
  assert.throws(() => summarizeComposeImport('x'.repeat(COMPOSE_IMPORT_LIMIT + 1)), /2 Mio/);
  assert.doesNotThrow(() => summarizeComposeImport('include: [./other.yaml]\n'));
  const alias = `services:\n  app:\n    image: alpine\nx-cycle: &cycle\n  self: *cycle\n`;
  assert.doesNotThrow(() => summarizeComposeImport(alias));
});
