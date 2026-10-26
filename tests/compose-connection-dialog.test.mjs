import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { composeDocument } from '../shared/compose-project.mjs';

const compilation = build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/ComposeConnectionDialog.jsx'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom', 'react-dom/*'],
  loader: { '.css': 'empty', '.svg': 'dataurl' },
});

// Exercise the real JSX callbacks and resulting Compose changes. These tests
// simulate hooks only, without a browser or any Docker connection.
async function harness(properties) {
  const slots = [];
  let cursor = 0;
  const mockedReact = {
    ...React,
    useMemo: (factory) => factory(),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
  };
  const compiled = { exports: {} },
    require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', (await compilation).outputFiles[0].text)(
    (name) => (name === 'react' ? mockedReact : require(name)),
    compiled,
    compiled.exports,
  );
  return () => {
    cursor = 0;
    const elements = [];
    const visit = (element) => {
      if (Array.isArray(element)) return element.forEach(visit);
      if (!React.isValidElement(element)) return;
      elements.push(element);
      visit(element.props.children);
    };
    visit(compiled.exports.default(properties));
    return elements;
  };
}
const text = (element) =>
  Array.isArray(element)
    ? element.map(text).join('')
    : React.isValidElement(element)
      ? text(element.props.children)
      : typeof element === 'string' || typeof element === 'number'
        ? String(element)
        : '';
const button = (tree, label) =>
  tree.find((element) => element.type === 'button' && text(element) === label);
const input = (tree, label) => tree.find((element) => element.props['aria-label'] === label);
const source = `services:
  web:
    image: nginx:alpine
    environment: {PASSWORD: DO_NOT_RENDER_THIS_SECRET}
    networks: [front]
  cache:
    image: redis:alpine
    networks: [back]
networks:
  front: {}
  back: {}
  web-cache: {}
`;

test('simple connection chooses an existing endpoint network and separates deploy from draft', async () => {
  const applied = [];
  const render = await harness({
    source,
    target: { services: ['web', 'cache'] },
    onClose() {},
    onApply: (...args) => applied.push(args),
  });
  const tree = render();
  assert.equal(
    tree.find(
      (element) =>
        element.type === 'input' && element.props.type === 'radio' && element.props.checked,
    ).props.value,
    'front',
  );
  assert.equal(tree.find((element) => element.type === 'details').props.open, false);
  assert.equal(
    tree.some((element) => element.type === 'pre'),
    false,
  );
  assert.equal(text(tree[0]).includes('DO_NOT_RENDER_THIS_SECRET'), false);
  button(tree, 'Vérifier et connecter').props.onClick();
  button(tree, 'Garder en brouillon').props.onClick();
  assert.deepEqual(
    applied.map((call) => call[2]),
    [{ deploy: true }, { deploy: false }],
  );
  const model = composeDocument(applied[0][0]).model;
  assert.deepEqual(Object.keys(model.services.cache.networks), ['back', 'front']);
  assert.equal(model.services.web.environment.PASSWORD, 'DO_NOT_RENDER_THIS_SECRET');
});

test('new liaison gets a meaningful unique name, invalid names and fixed IP remain blocked', async () => {
  const applied = [];
  const render = await harness({
    source,
    target: { services: ['web', 'cache'] },
    onClose() {},
    onApply: (...args) => applied.push(args),
  });
  let tree = render();
  input(tree, 'Créer un nouveau réseau pour cette liaison').props.onChange();
  tree = render();
  assert.equal(input(tree, 'Nom du nouveau réseau').props.value, 'web-cache-2');
  button(tree, 'Garder en brouillon').props.onClick();
  assert.equal(composeDocument(applied[0][0]).model.networks['web-cache-2'].driver, 'bridge');
  input(tree, 'Nom du nouveau réseau').props.onChange({ target: { value: 'bad name' } });
  tree = render();
  assert.equal(button(tree, 'Vérifier et connecter').props.disabled, true);
  button(tree, 'Vérifier et connecter').props.onClick();
  assert.equal(applied.length, 1);
  input(tree, 'Nom du nouveau réseau').props.onChange({ target: { value: 'web-cache-2' } });
  tree = render();
  input(tree, 'IPv4 fixe de web').props.onChange({ target: { value: '10.34.0.20' } });
  tree = render();
  assert.equal(button(tree, 'Vérifier et connecter').props.disabled, true);
  assert.match(text(tree[0]), /plage IPv4/);
});

test('disconnecting one of three peers never detaches the selected partner or other peers', async () => {
  const original =
    'services:\n  web: {image: nginx:alpine}\n  api: {image: alpine:3.23}\n  cache: {image: redis:alpine}\n';
  const applied = [];
  const render = await harness({
    source: original,
    target: { services: ['web', 'api'] },
    onClose() {},
    onApply: (...args) => applied.push(args),
  });
  let tree = render();
  assert.equal(button(tree, 'Vérifier et connecter').props.disabled, true);
  assert.match(text(tree[0]), /Réseau partagé par web, api, cache/);
  button(tree, 'Retirer un branchement').props.onClick();
  tree = render();
  input(tree, 'Service à déconnecter').props.onChange({ target: { value: 'api' } });
  tree = render();
  button(tree, 'Vérifier et déconnecter').props.onClick();
  const before = composeDocument(original).model,
    after = composeDocument(applied[0][0]).model;
  assert.equal(after.services.api.network_mode, 'none');
  assert.deepEqual(after.services.web, before.services.web);
  assert.deepEqual(after.services.cache, before.services.cache);
  assert.deepEqual(applied[0][1], ['Déconnecter api de default', 'api : mode réseau none']);
  assert.deepEqual(applied[0][2], { deploy: true });
});

test('locked dialog cannot apply connection changes even through its callback', async () => {
  let applied = false;
  const render = await harness({
    source,
    target: { services: ['web', 'cache'] },
    locked: true,
    onClose() {},
    onApply() {
      applied = true;
    },
  });
  const tree = render();
  assert.equal(tree.find((element) => element.type === 'fieldset').props.disabled, true);
  button(tree, 'Vérifier et connecter').props.onClick();
  button(tree, 'Garder en brouillon').props.onClick();
  assert.equal(applied, false);
});
