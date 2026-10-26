import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import tar from 'tar-stream';
import { saveArchive, verifyArchive } from '../server/backup-archive.mjs';
import { openBackupStore } from '../server/backup-store.mjs';
import { restoreTopology } from '../shared/backups.mjs';
import { initialTopology, volumeMounts, topologySchema } from '../shared/model.mjs';
import { requestTimeout } from '../server/streams.mjs';
const temp = async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-backup-unit-'));
  t.after(() => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-backup-unit-'))
      throw Error('Unexpected path');
    return rm(dir, { recursive: true, force: true });
  });
  return dir;
};
const packArchive = async (entries) => {
  const p = tar.pack(),
    chunks = [];
  const done = (async () => {
    for await (const b of p) chunks.push(b);
    return Buffer.concat(chunks);
  })();
  for (const [header, body] of entries) p.entry(header, body);
  p.finalize();
  return done;
};
const hash = (b) => ({ bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });

test('sauvegardes : archive en flux, contenu binaire, limites et intégrité', async (t) => {
  const dir = await temp(t),
    file = path.join(dir, 'archive.tar');
  const body = await packArchive([
    [{ name: '.', type: 'directory' }, null],
    [{ name: 'db', type: 'directory' }, null],
    [{ name: 'db/bytes', uid: 1024, gid: 1025, mode: 0o640 }, Buffer.from([0, 255, 128])],
    [{ name: 'alias', type: 'symlink', linkname: 'db/bytes' }, null],
  ]);
  const result = await saveArchive(Readable.from(body), file, body.length);
  assert.deepEqual(result, hash(body));
  assert.equal((await verifyArchive(file, result)).entries, 4);
  await assert.rejects(
    saveArchive(Readable.from(body), path.join(dir, 'too-big'), 512),
    /limite|place/,
  );
  await assert.rejects(verifyArchive(file, { ...result, sha256: '0'.repeat(64) }), /empreinte/);
  await assert.rejects(verifyArchive(file, { ...result, bytes: 512 }), /Taille/);
  await assert.rejects(
    saveArchive(
      Readable.from(
        (async function* () {
          await new Promise((r) => setTimeout(r, 30));
          yield body;
        })(),
      ),
      path.join(dir, 'slow'),
      body.length,
      { timeout: 5 },
    ),
    /abort/i,
  );
});
test('restauration : refuse traversées, doublons, liens parents et fichiers spéciaux avant extraction', async (t) => {
  const dir = await temp(t),
    file = path.join(dir, 'unsafe.tar');
  for (const entries of [
    [[{ name: '../escape' }, Buffer.from('x')]],
    [[{ name: '/absolute' }, Buffer.from('x')]],
    [
      [{ name: 'file' }, Buffer.from('x')],
      [{ name: 'file' }, Buffer.from('y')],
    ],
    [
      [{ name: 'parent/child' }, Buffer.from('x')],
      [{ name: 'parent', type: 'symlink', linkname: '/tmp' }, null],
    ],
    [[{ name: 'hard', type: 'link', linkname: '../escape' }, null]],
    [[{ name: 'fifo', type: 'fifo' }, null]],
  ]) {
    const bytes = await packArchive(entries);
    await writeFile(file, bytes);
    await assert.rejects(verifyArchive(file, hash(bytes)));
  }
  const bytes = await packArchive([
    [{ name: 'a' }, Buffer.from('x')],
    [{ name: 'b' }, Buffer.from('y')],
  ]);
  await writeFile(file, bytes);
  await assert.rejects(verifyArchive(file, hash(bytes), { maxEntries: 1 }), /trop de fichiers/);
});
test('sauvegardes : persistance, reprise interrompue, portée projet et accès exclusif', async (t) => {
  const dir = await temp(t),
    store = await openBackupStore(dir),
    id = randomUUID();
  const record = {
    id,
    projectId: 'a',
    hostId: 'local',
    nodeId: 'db',
    volume: 'v',
    target: '/data',
    name: 'avant',
    createdAt: Date.now(),
    status: 'running',
    resume: [{ id: 'container', name: 'db' }],
    helperId: 'helper',
  };
  await store.update(id, record);
  await writeFile(store.archive(id, true), 'interrupted');
  const reopened = await openBackupStore(dir),
    saved = reopened.get(id, 'a');
  assert.equal(saved.status, 'interrupted');
  assert.equal(saved.resume[0].id, 'container');
  assert.equal(saved.helperId, 'helper');
  await assert.rejects(readFile(store.archive(id, true)), { code: 'ENOENT' });
  assert.throws(() => reopened.get(id, 'b'), /introuvable/);
  assert.throws(() => store.archive('../path'));
  let release;
  const running = store.exclusive(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await assert.rejects(
    store.exclusive(() => {}),
    /déjà en cours/,
  );
  release();
  await running;
  await store.exclusive(() => {});
  await reopened.update(id, null);
  const afterDelete = await openBackupStore(dir);
  assert.equal(afterDelete.list('a').length, 0);
  assert.equal(afterDelete.knownVolume('a', 'v').target, '/data');
});
test('restauration : nouveau volume à chemin identique, autres réglages préservés', () => {
  const t = topologySchema.parse(initialTopology()),
    n = t.nodes.find((n) => n.id === 'redis'),
    before = structuredClone(t),
    backup = { nodeId: n.id, target: '/data' };
  assert.equal(volumeMounts(n)[0].id, 'data');
  const next = restoreTopology(t, backup, 'restored-example'),
    changed = next.nodes.find((n) => n.id === 'redis');
  assert.equal(changed.data.volume, '');
  assert.equal(changed.data.volumes[0].id, 'restored-example');
  assert.equal(changed.data.volumes[0].target, '/data');
  assert.deepEqual(t, before);
  assert.deepEqual(next.edges, t.edges);
  assert.deepEqual(
    next.nodes.filter((n) => n.id !== 'redis'),
    t.nodes.filter((n) => n.id !== 'redis'),
  );
  assert.throws(() => restoreTopology(t, { ...backup, target: '/missing' }, 'new'), /chemin/);
});
test('délais Docker : transferts longs et arrêt gracieux, délai court pour les lectures', () => {
  assert.equal(
    requestTimeout({
      path: 'http://server:22/containers/id/archive?path=%2Fvolume',
      method: 'PUT',
    }),
    1800000,
  );
  assert.equal(requestTimeout({ path: '/v1.53/containers/id/stop?t=30', method: 'POST' }), 35000);
  assert.equal(requestTimeout({ path: '/containers/json', method: 'GET' }), 12000);
  assert.equal(requestTimeout({ path: '/containers/id/stop?t=9999999', method: 'POST' }), 125000);
});
