import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openWorkspaceStore, pruneRuns } from '../server/workspace-store.mjs';
import {
  checkSchema,
  captureSchema,
  qualifyInventory,
  resolveResource,
} from '../shared/workspace.mjs';
import { conclude, explain, Diagnostics } from '../server/diagnostics.mjs';
import { unifiedInventory } from '../server/unified-inventory.mjs';
import { resolverContext } from '../server/engine-tools.mjs';

test('workspace : écritures atomiques concurrentes, rétention et opérations interrompues', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openWorkspaceStore(dir);
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => store.mutate((s) => s.actions.push({ id: i }))),
  );
  assert.equal(store.read().actions.length, 30);
  const now = Date.now();
  assert.equal(
    pruneRuns(Array.from({ length: 120 }, (_, i) => ({ startedAt: now - i }))).length,
    100,
  );
  assert.equal(pruneRuns([{ startedAt: now - 8 * 86400000 }]).length, 0);
  await store.mutate((s) => {
    s.runs.push({ id: 'r', status: 'running', startedAt: now });
    s.captures.push({ id: 'c', status: 'running', startedAt: now });
  });
  const reopened = await openWorkspaceStore(dir);
  assert.equal(reopened.read().runs[0].status, 'inconclusive');
  assert.equal(reopened.read().captures[0].status, 'interrupted');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'workspace-v1.json'), 'utf8')).version, 1);
  await writeFile(path.join(dir, 'workspace-v1.json'), '{broken');
  await assert.rejects(openWorkspaceStore(dir));
});
const ref = (id) => ({ hostId: 'local', containerId: id.repeat(64) });
test('contrôles : validation avant commande et captures bornées', () => {
  const input = { id: 'test', name: 'Connexion', source: ref('a'), target: ref('b') };
  assert.equal(checkSchema.parse(input).protocol, 'TCP');
  for (const change of [
    { port: 0 },
    { hostname: '$(whoami)' },
    { address: '-exec' },
    { path: '/foo\nbar' },
    { target: ref('a') },
  ])
    assert.throws(() => checkSchema.parse({ ...input, ...change }));
  assert.throws(() => checkSchema.parse({ ...input, target: { ...ref('b'), hostId: 'remote' } }));
  assert.equal(captureSchema.parse({ targets: [ref('a')] }).duration, 30);
  assert.throws(() => captureSchema.parse({ targets: [ref('a'), ref('b'), ref('c')] }));
});
test('ressources : hôte qualifié et résolution après recréation sans sélection ambiguë', () => {
  const c = {
    id: 'a'.repeat(64),
    name: 'web',
    projectKey: 'compose:demo',
    project: 'demo',
    service: 'web',
    attachments: [{ networkId: 'net', ip: '172.20.0.2' }],
  };
  const snapshot = {
    containers: [c],
    networks: [{ id: 'net' }],
    links: [{ id: 'edge', source: `c:${c.id}`, target: 'n:net' }],
  };
  const a = qualifyInventory(snapshot, { id: 'a', name: 'A' }),
    b = qualifyInventory(snapshot, { id: 'b', name: 'B' });
  assert.notEqual(a.containers[0].id, b.containers[0].id);
  assert.equal(a.links[0].source, `c:a:${c.id}`);
  const selector = { ...ref('b'), project: 'demo', service: 'web' };
  assert.equal(resolveResource(selector, snapshot), c);
  assert.throws(() => resolveResource(selector, { containers: [c, { ...c, id: 'c'.repeat(64) }] }));
});
test('diagnostics : preuve DNS distincte de TCP et indisponibilité distincte d’une panne', () => {
  const steps = [
    { kind: 'dns', status: 'failed' },
    { kind: 'tcp', status: 'passed' },
  ];
  assert.equal(conclude(steps), 'failed');
  assert.match(explain(steps), /alias DNS/);
  assert.equal(conclude([{ kind: 'observer', status: 'inconclusive' }]), 'inconclusive');
  assert.equal(
    conclude([
      { kind: 'tcp', status: 'passed' },
      { kind: 'network', status: 'info' },
    ]),
    'passed',
  );
});
test('diagnostic : moteur coupé donne non concluant et libère le verrou', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-diagnostic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openWorkspaceStore(dir);
  await store.mutate((s) =>
    s.checks.push(
      checkSchema.parse({ id: 'test', name: 'Connexion', source: ref('a'), target: ref('b') }),
    ),
  );
  const d = new Diagnostics(
    store,
    {
      clearInventory() {},
      inventory: async () => {
        throw Error('SSH interrupted');
      },
    },
    null,
    () => {},
  );
  const run = await d.start('test');
  await d.shutdown();
  assert.equal(store.read().runs.find((r) => r.id === run.id).status, 'inconclusive');
  assert.equal(d.active.size, 0);
});
test('inventaire unifié : un SSH lent laisse le moteur local disponible et ne multiplie pas les requêtes', async () => {
  let remoteCalls = 0,
    release;
  const hosts = {
    list: () => [
      { id: 'local', name: 'Local' },
      { id: 'remote', name: 'Remote' },
    ],
    inventory: async (id) => {
      if (id === 'remote') {
        remoteCalls++;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return {
        containers: [{ id: 'a', name: 'web', projectKey: 'x', project: 'x', attachments: [] }],
        networks: [],
        links: [],
      };
    },
  };
  const read = unifiedInventory(hosts, 20),
    start = performance.now();
  const result = await read();
  assert.ok(performance.now() - start < 500);
  assert.equal(result.containers.length, 1);
  await read();
  assert.equal(remoteCalls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await read()).containers.length, 2);
});
test('DNS : résolveurs et fichier hosts de la source, commentaires et IPv6', () => {
  const r = resolverContext(
    'nameserver 127.0.0.11\nsearch project.local # x\nnameserver ::1',
    '172.20.0.4 mysql db # local',
  );
  assert.deepEqual(r.servers, ['127.0.0.11', '::1']);
  assert.deepEqual(r.search, ['project.local']);
  assert.deepEqual(r.hosts[0].names, ['mysql', 'db']);
});
