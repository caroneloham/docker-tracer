import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureEngine } from './fixtures/engine.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { Diagnostics } from '../server/diagnostics.mjs';
import { TargetCaptures, CAPTURE_LIMIT } from '../server/target-captures.mjs';
import { resourceRef } from '../shared/workspace.mjs';

test('contrat Docker : diagnostic complet, pannes distinctes, avant/après, PCAP et nettoyage', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = fixtureEngine(),
    store = await openWorkspaceStore(dir),
    hosts = new HostRegistry(store, fixture.docker),
    events = [];
  const captures = new TargetCaptures(store, hosts, (e) => events.push(e)),
    diagnostics = new Diagnostics(store, hosts, captures, (e) => events.push(e));
  t.after(() => captures.shutdown());
  const inv = await hosts.inventory('local'),
    source = resourceRef(
      'local',
      inv.containers.find((c) => c.name === 'client'),
    ),
    target = resourceRef(
      'local',
      inv.containers.find((c) => c.name === 'web'),
    );
  const check = await diagnostics.save({
    name: 'client doit joindre web',
    source,
    target,
    protocol: 'HTTP',
    hostname: 'web',
  });
  const run = async (c = check, capture = false) => {
    const started = await diagnostics.start(c.id, capture);
    await Promise.all([...diagnostics.tasks]);
    return store.read().runs.find((r) => r.id === started.id);
  };
  let r = await run(check, true);
  assert.equal(r.status, 'passed', r.summary);
  assert.ok(r.captureId);
  assert.equal(fixture.helpers.size, 0);
  assert.equal(
    fixture.state.created.find((c) => c.Labels['io.dockertracer.role'] === 'diagnostic').HostConfig
      .NetworkMode,
    `container:${source.containerId}`,
  );
  const cap = captures.get(r.captureId);
  assert.equal(cap.targets.length, 2);
  assert.equal(cap.files.length, 2);
  assert.ok(cap.count > 0);
  assert.equal(cap.packets[0].route.length, 2);
  assert.equal(cap.packets[0].association, 'compatible-ambiguous');
  assert.ok(cap.bytes <= CAPTURE_LIMIT);
  assert.equal((await captures.file(cap.id, 0)).buffer.readUInt32LE(0), 0xa1b2c3d4);
  await assert.rejects(captures.file(cap.id, 2));
  fixture.state.dns = false;
  r = await run();
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /alias DNS/);
  assert.equal(r.steps.find((s) => s.kind === 'tcp').status, 'passed');
  const failedId = r.id;
  fixture.state.dns = true;
  r = await run();
  assert.equal(r.status, 'passed');
  assert.equal(r.previousRunId, failedId);
  fixture.state.tcp = false;
  r = await run();
  assert.equal(r.steps.find((s) => s.kind === 'tcp').status, 'failed');
  assert.ok(!r.steps.some((s) => s.kind === 'http'));
  fixture.state.tcp = true;
  fixture.state.http = 404;
  r = await run();
  assert.equal(r.status, 'failed');
  assert.equal(r.steps.find((s) => s.kind === 'http').evidence.code, 404);
  fixture.state.http = 200;
  fixture.state.tls = false;
  const tls = await diagnostics.save({ ...check, id: 'https', protocol: 'HTTPS', port: 443 });
  r = await run(tls);
  assert.equal(r.steps.find((s) => s.kind === 'tls').status, 'failed');
  fixture.state.tls = true;
  fixture.apps.get(source.containerId).State = 'exited';
  r = await run();
  assert.equal(r.status, 'failed');
  assert.equal(r.steps[0].kind, 'state');
  fixture.apps.get(source.containerId).State = 'running';
  fixture.state.imageAvailable = false;
  r = await run();
  assert.equal(r.status, 'inconclusive');
  fixture.state.imageAvailable = true;
  fixture.state.offline = true;
  r = await run();
  assert.equal(r.status, 'inconclusive');
  fixture.state.offline = false;
  assert.equal(fixture.helpers.size, 0);
  assert.equal(diagnostics.active.size, 0);
  const reopened = await openWorkspaceStore(dir);
  assert.equal(reopened.read().runs.length, 9);
  assert.equal(reopened.read().checks.length, 2);
  assert.ok(
    events.filter((e) => e.type === 'diagnostic').every((e) => e.hostId === 'local' && e.runId),
  );
});

test('capture : erreur de démarrage et arrêt manuel retirent seulement les sondes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixtureEngine(),
    s = await openWorkspaceStore(dir),
    h = new HostRegistry(s, f.docker),
    c = new TargetCaptures(s, h, () => {}),
    inv = await h.inventory('local');
  t.after(() => c.shutdown());
  const targets = inv.containers.map((x) => resourceRef('local', x));
  f.apps.get(targets[1].containerId).State = 'exited';
  await assert.rejects(c.start({ targets }), /démarré/);
  assert.equal(f.helpers.size, 0);
  assert.equal(c.list()[0].status, 'interrupted');
  f.apps.get(targets[1].containerId).State = 'running';
  const cap = await c.start({ targets: [targets[0]], duration: 5 });
  const [a, b] = await Promise.all([c.stop(cap.id), c.stop(cap.id)]);
  assert.equal(a.status, 'completed');
  assert.equal(b.id, a.id);
  assert.equal(c.active.size, 0);
  assert.equal(f.apps.size, 2);
});
