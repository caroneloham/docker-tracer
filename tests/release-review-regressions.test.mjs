import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import YAML from 'yaml';
import { composeDocument } from '../shared/compose-project.mjs';
import { applyComposeConnection } from '../shared/compose-connections.mjs';
import { patchAiServiceSettings } from '../shared/ai-service-context.mjs';
import { buildAiCompose, defaultAiSettings, newAiSecrets } from '../shared/ai-infrastructure.mjs';
import { prepareAiStoragePreview, estimateAiStorageRequirements } from '../server/ai-storage.mjs';
import { LOCAL_REDUNDANCY_MARKER, planLocalRedundancy } from '../shared/redundancy-network.mjs';

const anchoredSource = `x-common: &common
  KEEP: yes
services:
  first: &engine
    image: vllm/vllm-openai
    environment: *common
    command: [--model, org/a]
  second: *engine
`;

test('release review: AI edits preserve backward aliases and other services over repeated edits', () => {
  const before = composeDocument(anchoredSource).model;
  let source = anchoredSource;
  for (let index = 1; index <= 10; index++) {
    source = patchAiServiceSettings(source, 'first', { model: `org/model-${index}` });
    const after = composeDocument(source).model;
    assert.equal(after.services.first.command[1], `org/model-${index}`);
    assert.deepEqual(after.services.first.environment, before.services.first.environment);
    assert.deepEqual(after.services.second, before.services.second);
    assert.deepEqual(after['x-common'], before['x-common']);
  }
  assert.ok(
    source.length < 2000,
    'Repeated field edits must not recursively duplicate preserved anchors.',
  );
});

test('release review: cable edits preserve backward aliases and stay bounded on repetition', () => {
  const before = composeDocument(anchoredSource).model;
  let source = applyComposeConnection(anchoredSource, {
    services: ['first'],
    network: 'newnet',
    create: true,
  });
  for (let index = 1; index <= 10; index++) {
    source = applyComposeConnection(source, {
      services: ['first'],
      network: 'newnet',
      settings: { first: { aliases: [`backend-${index}`] } },
    });
    const after = composeDocument(source).model;
    assert.deepEqual(after.services.first.networks.newnet.aliases, [`backend-${index}`]);
    assert.deepEqual(after.services.second, before.services.second);
    assert.deepEqual(after['x-common'], before['x-common']);
  }
  assert.ok(
    source.length < 2500,
    'Repeated cable edits must not recursively duplicate preserved anchors.',
  );
});

function cachedEstimate(model, profiles = []) {
  const plan = prepareAiStoragePreview({ source: YAML.stringify(model), profiles });
  return {
    plan,
    estimate: estimateAiStorageRequirements(
      plan.settings,
      plan.images.map((image) => ({ RepoTags: [image] })),
      plan.images,
      { modelActive: plan.modelActive, modelEstimateKnown: plan.modelEstimateKnown },
    ),
  };
}

test('release review: active custom inference image or command keeps model storage unknown', () => {
  const source = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'release-review').source;
  for (const mutation of [
    (model) => {
      model.services.inference.image = 'registry.example/vllm-mirror:1';
    },
    (model) => {
      model.services.inference.command = ['sh', '-c', 'exec custom-inference'];
    },
  ]) {
    const model = YAML.parse(source);
    mutation(model);
    const { plan, estimate } = cachedEstimate(model);
    assert.ok(plan.activeServices.includes('inference'));
    assert.equal(plan.modelActive, true);
    assert.equal(plan.modelEstimateKnown, false);
    assert.equal(estimate.modelGiB, null);
    assert.equal(estimate.modelStorage.status, 'unknown');
    assert.equal(estimate.complete, false);
  }
});

test('release review: inference genuinely excluded by profiles has no model storage estimate', () => {
  const source = buildAiCompose(defaultAiSettings(), newAiSecrets(), 'release-review').source;
  const model = YAML.parse(source);
  model.services.inference.image = 'registry.example/vllm-mirror:1';
  model.services.inference.profiles = ['inference'];
  const { plan, estimate } = cachedEstimate(model);
  assert.ok(!plan.activeServices.includes('inference'));
  assert.equal(plan.modelActive, false);
  assert.equal(estimate.modelStorage.status, 'not-required');
  assert.equal(estimate.modelGiB, 0);
});

test('release review: network appliances cannot be multiplied by stateless attestation', () => {
  for (const settings of [
    { 'x-docker-tracer': { kind: 'router' } },
    { privileged: true },
    { cap_add: ['NET_ADMIN'] },
    { cap_add: ['ALL'] },
    { sysctls: { 'net.ipv4.ip_forward': '1' } },
    { sysctls: ['net.ipv4.ip_forward=1'] },
    { sysctls: { 'net.ipv6.conf.all.forwarding': '1' } },
    { sysctls: ['net.ipv6.conf.all.forwarding=1'] },
  ]) {
    const source = YAML.stringify({ services: { router: { image: 'alpine:3.23', ...settings } } });
    const result = planLocalRedundancy(source, {
      serviceNames: ['router'],
      replicas: 2,
      confirmations: { statelessServices: ['router'] },
    });
    assert.ok(result.blockers.some((issue) => issue.code === 'NETWORK_APPLIANCE_UNSUPPORTED'));
    assert.equal(result.summary.applicable, false);
    assert.equal(result.source, source);
  }
});

// Exercise the actual JSX callbacks without a browser or DOM. The useState and
// useMemo hooks are simulated; returned React elements are walked.
async function redundancyDialogHarness(properties) {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/RedundancyDialog.jsx'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty', '.svg': 'dataurl' },
  });
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
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    (name) => (name === 'react' ? mockedReact : require(name)),
    compiled,
    compiled.exports,
  );
  return () => {
    cursor = 0;
    const tree = compiled.exports.ManualRedundancyDialog(properties);
    const elements = [];
    const visit = (element) => {
      if (Array.isArray(element)) return element.forEach(visit);
      if (!React.isValidElement(element)) return;
      elements.push(element);
      visit(element.props.children);
    };
    visit(tree);
    return elements;
  };
}

const labelText = (element) => {
  if (Array.isArray(element)) return element.map(labelText).join('');
  if (React.isValidElement(element)) return labelText(element.props.children);
  return typeof element === 'string' || typeof element === 'number' ? String(element) : '';
};

test('release review: HTTP host entered in the dialog reaches the applied HAProxy configuration', async () => {
  let applied;
  const render = await redundancyDialogHarness({
    source: 'services:\n  web:\n    image: nginx:alpine\n    ports: ["127.0.0.1:8080:80"]\n',
    serviceNames: ['web'],
    hostName: 'Audit host',
    onClose() {},
    onApply(source) {
      applied = source;
    },
  });
  let tree = render();
  const protocol = () =>
    tree.find((element) => element.type === 'select' && typeof element.props.value === 'string');
  protocol().props.onChange({ target: { value: 'http' } });
  tree = render();
  const host = tree.find(
    (element) => element.type === 'label' && /Domaine de la sonde/.test(labelText(element)),
  );
  assert.ok(host, 'HTTP health checks need an editable Host field.');
  React.Children.toArray(host.props.children)
    .find((element) => element.type === 'input')
    .props.onChange({ target: { value: ' app.example:8443 ' } });
  const confirm = tree.find(
    (element) => element.type === 'label' && /Je confirme que/.test(labelText(element)),
  );
  React.Children.toArray(confirm.props.children)
    .find((element) => element.type === 'input')
    .props.onChange({ target: { checked: true } });
  tree = render();
  const apply = tree.find(
    (element) => element.type === 'button' && labelText(element) === 'Ajouter au brouillon',
  );
  assert.equal(apply.props.disabled, false);
  apply.props.onClick();
  const model = composeDocument(applied).model;
  const marker = model[LOCAL_REDUNDANCY_MARKER];
  assert.match(model.configs[marker.configName].content, /hdr Host app\.example:8443/);
  assert.equal(
    model.services[marker.proxyService].read_only,
    undefined,
    'Compose inline configs must remain usable by the generated proxy.',
  );
  assert.deepEqual(model.services[marker.proxyService].cap_drop, ['ALL']);
});
