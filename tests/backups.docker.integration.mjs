import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tar from 'tar-stream';
import { Readable } from 'node:stream';
import { docker, ownedContainer } from '../server/docker.mjs';
import { archiveFile, execTool } from '../server/engine-tools.mjs';
import { LABEL } from '../shared/model.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';
import { openBackupStore } from '../server/backup-store.mjs';
import { dockerSshEndpoint } from './docker-ssh.fixture.mjs';

await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-backup-docker-')),
  ids = [];
let service, server, workspace, ssh;
const archive = async (entries) => {
  const pack = tar.pack(),
    chunks = [];
  const done = (async () => {
    for await (const b of pack) chunks.push(b);
    return Buffer.concat(chunks);
  })();
  for (const [header, body] of entries) pack.entry(header, body);
  pack.finalize();
  return done;
};
try {
  const app = express();
  app.use(express.json());
  workspace = await mountWorkspaceApi(app, {
    dataDir: dir,
    localDocker: docker,
    emit: () => {},
    labBusy: (id) => service?.hostBusy(id) || false,
    guardHost: (id, next) => service?.guardHost(id, next),
    projectList: () => service?.list() || [],
  });
  service = await createProjectService({ dataDir: dir, workspace, emit: () => {} });
  mountProjectApi(app, service);
  app.use((e, _req, res, _next) => res.status(e.statusCode || 400).json({ error: e.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  const api = async (url, body, p, method = 'POST') => {
    const res = await fetch(
      base + url,
      body === undefined
        ? {}
        : {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(p ? { 'If-Match': String(service.store.get(p.id).revision) } : {}),
            },
            body: JSON.stringify(body),
          },
    );
    const result = await res.json();
    if (!res.ok) throw Error(result.error);
    return result;
  };
  ssh = await dockerSshEndpoint(dir, docker);
  const h = await api('/hosts', ssh.profile),
    trust = await api('/hosts/' + h.id + '/test', {});
  await api('/hosts/' + h.id + '/trust', { fingerprint: trust.fingerprint });
  for (const hostId of ['local', h.id]) {
    const p = (
      await api('/projects', { name: 'Sauvegardes ' + hostId, hostId, template: 'example' })
    ).project;
    ids.push(p.id);
    const prefix = '/projects/' + p.id,
      mutate = (url, body, method) => api(prefix + url, body, p, method),
      t = service.store.get(p.id).topology;
    t.nodes.find((n) => n.id === 'web').data.volume = '/usr/share/nginx/html';
    await mutate('/topology', t, 'PUT');
    const setupEngine = await workspace.hosts.client(hostId);
    // Existing volume from a previous version: no mount-target label to rely on.
    await setupEngine.createVolume({
      Name: `dtr-${p.id}-web-data`,
      Labels: { [LABEL + '.project']: p.id, [LABEL + '.role']: 'volume', [LABEL + '.node']: 'web' },
    });
    await mutate('/deploy', {});
    const engine = await workspace.hosts.client(hostId),
      topology = () => service.store.get(p.id).topology;
    const web = await ownedContainer(topology(), 'web', engine),
      client = await ownedContainer(topology(), 'client', engine),
      spare = await ownedContainer(topology(), 'worker', engine);
    await spare.stop({ t: 3 });
    const untouched = await client.inspect();
    const original = Buffer.from([0, 1, 2, 255, 128, 10]);
    await web.putArchive(
      await archive([
        [{ name: 'binary.dat', mode: 0o640, uid: 1001, gid: 1002 }, original],
        [{ name: 'alias.dat', type: 'symlink', linkname: 'binary.dat' }, null],
        [{ name: 'index.html' }, Buffer.from('page sauvegardée $value')],
      ]),
      { path: '/usr/share/nginx/html', copyUIDGID: true },
    );
    const list = await api(prefix + '/volumes'),
      volume = list.volumes.find((v) => v.nodeId === 'web').name;
    const plan = await mutate('/backups/preview', { volume, name: 'Avant modification' });
    assert.deepEqual(
      plan.interrupted.map((c) => c.id),
      [web.id],
    );
    const b = (await mutate('/backups/create', { token: plan.token })).backup;
    assert.equal(b.status, 'ready');
    assert.equal(b.helperId, null);
    assert.deepEqual(b.resume, []);
    assert.equal((await web.inspect()).State.Running, true);
    assert.equal((await spare.inspect()).State.Running, false);
    assert.equal((await client.inspect()).State.StartedAt, untouched.State.StartedAt);
    const reopened = await openBackupStore(dir);
    assert.equal(reopened.get(b.id, p.id).sha256, b.sha256);
    const download = await fetch(base + prefix + '/backups/' + b.id + '/download');
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, b.bytes);
    await execTool(engine, web, [
      'sh',
      '-c',
      'echo nouvelle-version > /usr/share/nginx/html/index.html; rm /usr/share/nginx/html/binary.dat /usr/share/nginx/html/alias.dat; echo recent > /usr/share/nginx/html/recent.txt',
    ]);
    const restore = await mutate('/backups/' + b.id + '/restore-preview', {});
    assert.equal(restore.changes.filter((c) => c.kind === 'recreate').length, 1);
    const applied = await mutate('/backups/restore', { token: restore.token });
    const next = await ownedContainer(topology(), 'web', engine);
    assert.notEqual(next.id, web.id);
    assert.deepEqual(await archiveFile(next, '/usr/share/nginx/html/binary.dat'), original);
    assert.equal(
      (await archiveFile(next, '/usr/share/nginx/html/index.html')).toString(),
      'page sauvegardée $value',
    );
    const attrs = await execTool(engine, next, [
      'sh',
      '-c',
      "stat -c '%u:%g:%a' /usr/share/nginx/html/binary.dat; readlink /usr/share/nginx/html/alias.dat; test ! -e /usr/share/nginx/html/recent.txt",
    ]);
    assert.equal(attrs.exitCode, 0, attrs.output);
    assert.match(attrs.stdout, /1001:1002:640/);
    assert.match(attrs.stdout, /binary.dat/);
    await engine.getVolume(volume).inspect();
    assert.equal((await client.inspect()).State.StartedAt, untouched.State.StartedAt);
    assert.equal((await spare.inspect()).State.Running, false);
    assert.ok(applied.restoredVolume);
    assert.equal(service.deployments.list(p.id)[0].kind, 'restore');
    console.log(
      hostId +
        ' : sauvegarde binaire, permissions, lien, reprise, téléchargement, persistance et restauration API : OK.',
    );
    // Checksum failure cannot replace the current service.
    const pathToArchive = service.backups.archive(b.id),
      valid = await readFile(pathToArchive);
    const corrupt = Buffer.from(valid);
    corrupt[530] ^= 1;
    await writeFile(pathToArchive, corrupt);
    const bad = await mutate('/backups/' + b.id + '/restore-preview', {});
    await assert.rejects(
      mutate('/backups/restore', { token: bad.token }),
      /empreinte|checksum|archive|Archive/,
    );
    assert.equal((await ownedContainer(topology(), 'web', engine)).id, next.id);
    await writeFile(pathToArchive, valid);
    const activeVolume = (await api(prefix + '/volumes')).volumes.find(
      (v) => v.nodeId === 'web' && v.configured,
    ).name;
    const capacity = service.backups.capacity;
    service.backups.capacity = async () => ({ ...(await capacity()), available: 512 });
    try {
      const small = await mutate('/backups/preview', {
        volume: activeVolume,
        name: 'Limite volontaire',
      });
      await assert.rejects(mutate('/backups/create', { token: small.token }), /limite|place/);
      assert.equal(
        (await next.inspect()).State.Running,
        true,
        'La limite reprend le service interrompu',
      );
    } finally {
      service.backups.capacity = capacity;
    }
    const foreign = await engine.createContainer({
      Image: 'alpine:3.23',
      Cmd: ['true'],
      Labels: { [LABEL + '.project']: p.id, [LABEL + '.role']: 'foreign-test' },
      HostConfig: {
        NetworkMode: 'none',
        Mounts: [
          {
            Type: 'volume',
            Source: activeVolume,
            Target: '/data',
            ReadOnly: true,
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
    });
    try {
      await assert.rejects(
        mutate('/backups/preview', { volume: activeVolume, name: 'Refus extérieur' }),
        /extérieur/,
      );
      assert.equal((await next.inspect()).State.Running, true);
    } finally {
      await foreign.remove({ force: true });
    }
    const stale = await mutate('/backups/preview', { volume: activeVolume, name: 'Aperçu périmé' });
    await next.stop({ t: 3 });
    await assert.rejects(mutate('/backups/create', { token: stale.token }), /changé/);
    await next.start();
    console.log(
      'Limite de stockage, service extérieur et aperçu périmé : refus sans perte, reprise vérifiée.',
    );
    // Previously stopped service stays stopped across a backup and restore.
    await next.stop({ t: 3 });
    const newVolume = (await api(prefix + '/volumes')).volumes.find(
      (v) => v.nodeId === 'web' && v.configured,
    ).name;
    const stoppedPlan = await mutate('/backups/preview', {
      volume: newVolume,
      name: 'Service arrêté',
    });
    assert.equal(stoppedPlan.interrupted.length, 0);
    const stoppedBackup = (await mutate('/backups/create', { token: stoppedPlan.token })).backup;
    assert.equal((await next.inspect()).State.Running, false);
    await mutate('/backups/' + stoppedBackup.id, {}, 'DELETE');
    await assert.rejects(
      api(prefix + '/backups/' + stoppedBackup.id + '/restore-preview', {}, p),
      /introuvable/,
    );
    const interrupted = service.backups.list(p.id).find((b) => b.name === 'Limite volontaire');
    const leftover = await engine.createContainer({
      Image: 'alpine:3.23',
      Cmd: ['true'],
      Labels: {
        [LABEL + '.project']: p.id,
        [LABEL + '.role']: 'backup',
        [LABEL + '.backup']: interrupted.id,
      },
      HostConfig: { NetworkMode: 'none' },
    });
    await service.backups.update(interrupted.id, {
      status: 'interrupted',
      helperId: leftover.id,
      resume: [{ id: next.id, name: 'web' }],
    });
    await mutate('/backups/' + interrupted.id + '/recover', {});
    assert.equal((await next.inspect()).State.Running, true);
    assert.equal(service.backups.get(interrupted.id, p.id).helperId, null);
    assert.deepEqual(service.backups.get(interrupted.id, p.id).resume, []);
    await assert.rejects(leftover.inspect(), { statusCode: 404 });
    await next.stop({ t: 3 });
    assert.equal(
      (
        await engine.listContainers({
          all: true,
          filters: { label: [LABEL + '.project=' + p.id, LABEL + '.role=backup'] },
        })
      ).length,
      0,
    );
    if (hostId !== 'local') {
      // A restore upload deliberately idle beyond the old SSH deadline must complete.
      const tiny = await archive([[{ name: 'slow.txt' }, Buffer.from('long SSH upload')]]);
      const delayed = Readable.from(
        (async function* () {
          yield tiny.subarray(0, 512);
          await new Promise((r) => setTimeout(r, 13000));
          yield tiny.subarray(512);
        })(),
      );
      await next.putArchive(delayed, {
        path: '/usr/share/nginx/html',
        abortSignal: AbortSignal.timeout(25000),
      });
      assert.equal(
        (await archiveFile(next, '/usr/share/nginx/html/slow.txt')).toString(),
        'long SSH upload',
      );
      console.log('Transfert SSH avec 13 secondes de pause : OK.');
    }
    if (hostId === 'local') {
      await mutate('/backups/' + b.id, {}, 'DELETE');
      const preserved = (await api(prefix + '/volumes')).volumes.find((v) => v.name === volume);
      assert.equal(preserved.configured, false);
      assert.equal(preserved.target, '/usr/share/nginx/html');
      const again = await mutate('/backups/preview', {
        volume,
        name: 'Ancien volume toujours accessible',
      });
      assert.equal(again.target, '/usr/share/nginx/html');
      console.log(
        'Ancien volume sans label de chemin : encore sauvegardable après suppression de son archive.',
      );
    }
  }
  await ssh.close();
  const offline = await api('/projects/' + ids[1] + '/volumes');
  assert.match(offline.warning, /indisponibles/);
  assert.ok(offline.backups.some((b) => b.status === 'ready'));
  const one = service.backups.list(ids[0])[0];
  await assert.rejects(
    api(
      '/projects/' + ids[1] + '/backups/' + one.id + '/restore-preview',
      {},
      service.store.get(ids[1]),
    ),
    /introuvable/,
  );
  console.log('Empreinte altérée, portée projet, service arrêté et suppression explicite : OK.');
} finally {
  await service?.shutdown();
  await workspace?.shutdown();
  await ssh?.close();
  if (server) await new Promise((r) => server.close(r));
  for (const id of ids) {
    const filters = { label: [LABEL + '.project=' + id] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true, v: false });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-backup-docker-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Projets, volumes et archives de test nettoyés.');
}
