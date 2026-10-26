import test from 'node:test';
import assert from 'node:assert/strict';
import { topologySchema, initialTopology, newNode, composeObject } from '../shared/model.mjs';
import { appFileSchema, configurationFiles, PROXY_PATH } from '../shared/configuration.mjs';
import { configureProxy, detachProxy } from '../shared/proxy.mjs';
import { planLabChanges } from '../shared/lab-changes.mjs';
import { validateEquipmentTemplate } from '../shared/templates.mjs';

test('a new UI refuses to send file configuration to a server that would discard it', async () => {
  const { assertConfigurationSupport } = await import('../shared/configuration.mjs');
  const t = fixture();
  assert.doesNotThrow(() => assertConfigurationSupport(t, undefined));
  t.nodes.find((n) => n.id === 'web').data.files = [{ path: '/a.txt', content: 'keep' }];
  assert.throws(() => assertConfigurationSupport(t, undefined), /Redémarre Docker Tracer/);
  assert.doesNotThrow(() => assertConfigurationSupport(t, { applicationFiles: true }));
  const p = configureProxy(fixture(), 'proxy', settings);
  assert.throws(() => assertConfigurationSupport(p, { applicationFiles: false }), /Redémarre/);
});

const fixture = () => {
  const t = topologySchema.parse(initialTopology());
  t.nodes.push(newNode('nginx', 'proxy', { x: 0, y: 0 }, 'proxy'));
  t.nodes.at(-1).measured = { width: 88, height: 94 };
  return t;
};
const settings = {
  targetId: 'web',
  networkId: 'frontend',
  port: 80,
  listenPort: 8080,
  websocket: true,
};

test('application files validate paths, UTF-8 bytes and overlapping files or volumes', () => {
  for (const path of [
    'relative',
    '/',
    '/a/../b',
    '/a/./b',
    '/a//b',
    '/a/',
    '/proc/x',
    '/sys/x',
    '/dev/x',
    'C:/a',
    '/a\0',
  ]) {
    assert.equal(appFileSchema.safeParse({ path, content: '' }).success, false, path);
  }
  assert.ok(
    appFileSchema.safeParse({ path: '/etc/app config/site.conf', content: 'été\n$host' }).success,
  );
  assert.equal(appFileSchema.safeParse({ path: '/a', content: 'é'.repeat(33000) }).success, false);
  assert.equal(appFileSchema.safeParse({ path: '/a', content: 'a\0b' }).success, false);
  const t = fixture(),
    web = t.nodes.find((n) => n.id === 'web');
  web.data.files = [
    { path: '/site', content: '' },
    { path: '/site/index.html', content: '' },
  ];
  assert.equal(topologySchema.safeParse(t).success, false);
  web.data.files = [{ path: '/data/file', content: 'unsafe' }];
  web.data.volume = '/data';
  assert.equal(topologySchema.safeParse(t).success, false);
});

test('graphical proxy follows target names and retains graph measurements; detaches to an editable file', () => {
  const t = configureProxy(fixture(), 'proxy', settings);
  const p = t.nodes.find((n) => n.id === 'proxy');
  assert.equal(p.measured.width, 88);
  assert.ok(t.edges.some((e) => e.source === 'proxy' && e.target === 'frontend'));
  const files = configurationFiles(t, p);
  assert.equal(files[0].path, PROXY_PATH);
  assert.match(files[0].content, /resolver 127\.0\.0\.11/);
  assert.match(files[0].content, /http:\/\/web:80/);
  const next = structuredClone(t);
  next.nodes.find((n) => n.id === 'web').data.label = 'website';
  assert.deepEqual(
    planLabChanges(t, next)
      .changes.map((c) => c.id)
      .sort(),
    ['proxy', 'web'],
  );
  assert.equal(
    detachProxy(t, 'proxy', true).nodes.find((n) => n.id === 'proxy').data.files[0].content,
    files[0].content,
  );
  assert.equal(detachProxy(t, 'proxy').nodes.find((n) => n.id === 'proxy').data.proxy, null);
  assert.equal(
    validateEquipmentTemplate({ id: 'template', title: 'Proxy', data: p.data }).data.proxy,
    null,
  );
});

test('proxy validation rejects self targets, cycles, absent network membership and file collisions', () => {
  assert.throws(() => configureProxy(fixture(), 'proxy', { ...settings, targetId: 'proxy' }));
  assert.throws(() => configureProxy(fixture(), 'proxy', { ...settings, networkId: 'backend' }));
  const t = configureProxy(fixture(), 'proxy', settings);
  assert.throws(() => configureProxy(t, 'web', { ...settings, targetId: 'proxy' }));
  t.nodes.find((n) => n.id === 'proxy').data.files = [{ path: PROXY_PATH, content: 'collision' }];
  assert.equal(topologySchema.safeParse(t).success, false);
});

test('Compose preserves literal dollar signs and configuration updates replace only the affected service', () => {
  const t = fixture(),
    n = t.nodes.find((n) => n.id === 'web');
  n.data.files = [{ path: '/usr/share/nginx/html/index.html', content: 'été $host $' + '{VALUE}' }];
  const compose = composeObject(topologySchema.parse(t));
  assert.equal(compose.configs['web-file-0'].content, 'été $$host $$' + '{VALUE}');
  assert.equal(compose.services.web.configs[0].target, n.data.files[0].path);
  const next = structuredClone(t);
  next.nodes.find((n) => n.id === 'web').data.files[0].content = 'updated';
  assert.deepEqual(
    planLabChanges(t, next).changes.map((c) => c.id),
    ['web'],
  );
});
