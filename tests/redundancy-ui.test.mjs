import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['src/RedundancyDialog.jsx'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom', 'react-dom/*'],
  loader: { '.css': 'empty', '.svg': 'dataurl' },
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  compiled,
  compiled.exports,
);
const RedundancyDialog = compiled.exports.ManualRedundancyDialog;
const AutomaticDialog = compiled.exports.default;
const source = `services:
  app:
    image: nginx:alpine
    ports: ["127.0.0.1:8080:80"]
    environment:
      APP_SECRET: sentinel-secret-never-render
    depends_on: [db]
  db:
    image: postgres:17
    volumes: ["database:/var/lib/postgresql/data"]
volumes:
  database: {}
`;
const render = (properties = {}) =>
  renderToStaticMarkup(
    React.createElement(RedundancyDialog, {
      source,
      serviceNames: ['app', 'db'],
      hostName: 'Mon PC',
      onClose() {},
      onApply() {
        throw Error('Rendering must never apply a plan.');
      },
      ...properties,
    }),
  );

test('redondance UI : accès public conservé et protocole à choisir explicitement', () => {
  const html = render();
  assert.match(html, /127\.0\.0\.1:8080 → 80/);
  assert.match(html, /<option value="" selected="">Choisir le protocole/);
  assert.match(html, /TCP \/ TLS transmis au conteneur/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Ajouter au brouillon<\/button>/);
});

test('redondance UI : base conservée unique et attestation distincte de l’application', () => {
  const html = render();
  assert.match(
    html,
    /<input type="checkbox"\/><span><strong>db<\/strong><small>Conservé en instance unique/,
  );
  assert.match(html, /Je confirme que <strong>app<\/strong>/);
  assert.doesNotMatch(html, /Je confirme que <strong>db<\/strong>/);
  assert.match(html, /Instance unique conservée : <strong>db<\/strong>/);
});

test('redondance UI : modal accessible, brouillon actuel et limites de la reprise explicites', () => {
  const html = render({ dirty: true, locked: true });
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /modifications non enregistrées/);
  assert.match(html, /<fieldset disabled="">/);
  assert.match(html, /points de panne uniques/);
  assert.match(html, /unhealthy.*n’est pas redémarré/);
  assert.match(html, /Docker ne change qu’après/);
  assert.doesNotMatch(html, /sentinel-secret-never-render/);
});

test('redondance UI : une sélection limitée à la base ne propose aucun ajout applicable', () => {
  const html = render({ serviceNames: ['db'] });
  assert.match(html, /Sélectionne au moins une application à multiplier/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Ajouter au brouillon<\/button>/);
});

test('redondance UI : un plan déjà préparé est signalé sans afficher son Compose', () => {
  const html = render({ source: source + '\nx-docker-tracer-redundancy: { version: 1 }\n' });
  assert.match(html, /déjà une préparation de redondance locale/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Ajouter au brouillon<\/button>/);
  assert.doesNotMatch(html, /sentinel-secret-never-render/);
});

test('redondance UI : des services internes ne promettent pas un proxy public', () => {
  const html = render({
    source: 'services:\n  worker:\n    image: custom-worker:1\n',
    serviceNames: ['worker'],
  });
  assert.match(html, /sans nouveau port public/);
  assert.match(html, /se reconnecter/);
  assert.doesNotMatch(html, /plus un proxy commun/);
  assert.doesNotMatch(html, /<legend>Points d’entrée/);
});

test('redondance UI : ComposeWorkspace reste un module JSX valide', async () => {
  const text = await readFile(new URL('../src/ComposeWorkspace.jsx', import.meta.url), 'utf8');
  await transform(text, { loader: 'jsx' });
});

test('redondance automatique UI : protocoles et services choisis sans questionnaire', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutomaticDialog, {
      source,
      serviceNames: ['app', 'db'],
      hostName: 'Mon PC',
      onClose() {},
      onApply() {},
    }),
  );
  assert.match(html, /HTTP détecté/);
  assert.match(html, /2 instances/);
  assert.match(html, /Relance automatique/);
  assert.match(html, /Vérifier et activer/);
  assert.doesNotMatch(html, /Je confirme que|Choisir le protocole|sentinel-secret-never-render/);
});

test('redondance automatique UI : relance seule clairement distincte des copies', () => {
  const html = renderToStaticMarkup(
    React.createElement(AutomaticDialog, {
      source,
      serviceNames: ['db'],
      hostName: 'Mon PC',
      onClose() {},
      onApply() {},
    }),
  );
  assert.match(html, /Aucun service multiplié/);
  assert.match(html, /relance automatique/);
  assert.doesNotMatch(html, /redondance active|À résoudre avant/);
});
