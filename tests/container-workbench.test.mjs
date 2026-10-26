import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, Readable } from 'node:stream';
import express from 'express';
import tar from 'tar-stream';
import {
  ContainerWorkbenchService,
  mountContainerWorkbench,
  UPLOAD_LIMIT,
} from '../server/container-workbench.mjs';

const ID = 'a'.repeat(64),
  OTHER = 'b'.repeat(64);
const directory = 0x80000000;
const body = { expectedName: 'web' };
function fixture(t, options = {}) {
  let running = true,
    name = '/web',
    infoId = ID,
    file = Buffer.from('initial\n'),
    fileMode = 0o640,
    labels = {},
    now = 1000;
  const paths = new Map([
    ['/', { mode: directory | 0o755, size: 0 }],
    ['/etc', { mode: directory | 0o755, size: 0 }],
  ]);
  const uploaded = new Map();
  let beforePath = () => {};
  const commands = [],
    resizes = [],
    writes = [],
    inputs = [],
    streams = [],
    inspections = [];
  let shellError = null,
    execState = { Running: false, ExitCode: 0 },
    archiveHeader = null,
    listing = 'directory\0conf.d\0file\0app.conf\0link\0linked.conf\0';
  const docker = {
    getContainer(id) {
      assert.equal(id, ID);
      return container;
    },
    modem: {
      demuxStream(stream, stdout) {
        stream.pipe(stdout);
      },
    },
  };
  const container = {
    async inspect() {
      inspections.push(ID);
      return {
        Id: infoId,
        Name: name,
        State: { Running: running, Paused: false },
        Config: { Labels: labels },
      };
    },
    async exec(input) {
      commands.push(input);
      if (shellError) throw Error(shellError);
      return {
        async start() {
          if (!input.Tty) return Readable.from([Buffer.from(listing)]);
          const stream = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              inputs.push(chunk.toString());
              callback();
            },
          });
          streams.push(stream);
          return stream;
        },
        async resize(size) {
          resizes.push(size);
        },
        async inspect() {
          return execState;
        },
      };
    },
    async infoArchive({ path }) {
      beforePath(path);
      const stat =
        paths.get(path) ||
        (uploaded.has(path)
          ? { name: path.split('/').at(-1), mode: 0o644, size: uploaded.get(path).length }
          : null) ||
        (path === '/etc/app.conf' ? { name: 'app.conf', mode: fileMode, size: file.length } : null);
      if (!stat) throw Object.assign(Error('Chemin absent.'), { statusCode: 404 });
      return {
        headers: {
          'x-docker-container-path-stat': Buffer.from(JSON.stringify(stat)).toString('base64'),
        },
        resume() {},
      };
    },
    async getArchive({ path = '/etc/app.conf' } = {}) {
      const pack = tar.pack();
      const content = uploaded.get(path) || file;
      pack.entry(
        {
          name: path.split('/').at(-1),
          type: 'file',
          size: content.length,
          mode: 0o640,
          uid: 1000,
          gid: 1001,
          ...archiveHeader,
        },
        content,
      );
      pack.finalize();
      return pack;
    },
    async putArchive(buffer, settings) {
      writes.push(settings);
      const extract = tar.extract();
      const read = new Promise((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
          const chunks = [];
          const editing = header.name === 'app.conf';
          assert.equal(header.type, 'file');
          assert.ok(!header.name.includes('/'));
          assert.equal(header.mode, editing ? 0o640 : 0o644);
          assert.equal(header.uid, editing ? 1000 : 0);
          assert.equal(header.gid, editing ? 1001 : 0);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            if (editing) file = Buffer.concat(chunks);
            else
              uploaded.set(
                `${settings.path === '/' ? '' : settings.path}/${header.name}`,
                Buffer.concat(chunks),
              );
            next();
          });
        });
        extract.on('finish', resolve);
        extract.on('error', reject);
      });
      if (Buffer.isBuffer(buffer)) extract.end(buffer);
      else buffer.pipe(extract);
      await read;
    },
  };
  const profiles = [],
    clientHosts = [];
  const hosts = {
    profile(hostId) {
      profiles.push(hostId);
      if (!['local', 'remote'].includes(hostId))
        throw Object.assign(Error('Hôte inconnu.'), { statusCode: 404 });
      return { id: hostId };
    },
    async client(hostId) {
      clientHosts.push(hostId);
      return docker;
    },
  };
  const events = [];
  const service = new ContainerWorkbenchService(hosts, {
    now: () => now,
    emit: (event) => events.push(event),
    ...options,
  });
  t.after(() => {
    service.shutdown();
    for (const stream of streams) stream.destroy();
  });
  return {
    service,
    hosts,
    profiles,
    clientHosts,
    commands,
    resizes,
    writes,
    inputs,
    streams,
    inspections,
    events,
    paths,
    uploaded,
    setBeforePath: (value) => (beforePath = value),
    setRunning: (value) => (running = value),
    setName: (value) => (name = value),
    setId: (value) => (infoId = value),
    setFile: (value) => (file = Buffer.from(value)),
    setMode: (value) => (fileMode = value),
    setLabels: (value) => (labels = value),
    setClock: (value) => (now = value),
    setShellError: (value) => (shellError = value),
    setExecState: (value) => (execState = value),
    setArchiveHeader: (value) => (archiveHeader = value),
    setListing: (value) => (listing = value),
  };
}

test('workbench : identité hôte + ID complet + nom et état vérifiés avant un shell', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.open('absent', ID, body), /Hôte inconnu/);
  await assert.rejects(f.service.open('local', 'web', body));
  await assert.rejects(
    f.service.open('local', ID, { expectedName: 'old-name' }),
    /nom du conteneur a changé/,
  );
  f.setRunning(false);
  await assert.rejects(f.service.open('local', ID, body), /Démarre le conteneur/);
  f.setRunning(true);
  f.setId(OTHER);
  await assert.rejects(f.service.open('local', ID, body), /cible Docker a changé/);
  f.setId(ID);
  f.setLabels({ 'io.dockertracer.role': 'observer' });
  await assert.rejects(f.service.open('local', ID, body), /sondes/);
  assert.equal(f.commands.length, 0);
});

test('terminal : découvre Bash puis Ash/Sh sans exécuter de commande et suit les liens internes', async (t) => {
  const f = fixture(t);
  f.paths.set('/bin/bash', { mode: 0o755, size: 1024 });
  f.paths.set('/usr/bin/bash', { mode: 0o755, size: 1024 });
  f.paths.set('/bin/ash', { mode: 0x08000000 | 0o777, size: 7, linkTarget: 'busybox' });
  f.paths.set('/bin/sh', { mode: 0x08000000 | 0o777, size: 7, linkTarget: '/bin/busybox' });
  f.paths.set('/bin/busybox', { mode: 0o755, size: 4096 });
  assert.deepEqual(await f.service.shells('local', ID, 'web'), {
    preferred: '/bin/bash',
    shells: [
      { path: '/bin/bash', label: 'Bash' },
      { path: '/bin/ash', label: 'Ash' },
      { path: '/bin/sh', label: 'Sh' },
    ],
  });
  assert.equal(f.commands.length, 0);
  f.paths.delete('/bin/bash');
  f.paths.delete('/usr/bin/bash');
  assert.equal((await f.service.shells('local', ID)).preferred, '/bin/ash');
});

test('terminal : découverte respecte la cible et ne confond pas absence, permission et panne Docker', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.service.shells('remote', ID, 'web'), { preferred: null, shells: [] });
  await assert.rejects(f.service.shells('local', ID, 'renamed'), /nom du conteneur/);
  f.setRunning(false);
  await assert.rejects(f.service.shells('local', ID), /Démarre le conteneur/);
  f.setRunning(true);
  f.paths.set('/bin/bash', { mode: 0o644, size: 1024 });
  f.paths.set('/bin/ash', { mode: 0x08000000 | 0o777, size: 3, linkTarget: 'ash' });
  f.paths.set('/bin/sh', { mode: directory | 0o755, size: 1024 });
  assert.deepEqual(await f.service.shells('local', ID), { preferred: null, shells: [] });
  f.setBeforePath(() => {
    throw Object.assign(Error('Daemon indisponible'), { statusCode: 500 });
  });
  await assert.rejects(f.service.shells('local', ID), /Daemon indisponible/);
  assert.equal(f.commands.length, 0);
});

test('terminal : Ash détecté reste un véritable shell interactif et reçoit Tab exactement', async (t) => {
  const f = fixture(t),
    session = await f.service.open('local', ID, { ...body, shell: '/bin/ash' });
  assert.deepEqual(f.commands[0].Cmd, ['/bin/ash', '-i']);
  await f.service.input('local', ID, session.id, { data: 'cd /etc/\t' });
  await f.service.input('local', ID, session.id, { data: '\t\x1b[Z' });
  assert.deepEqual(f.inputs, ['cd /etc/\t', '\t\x1b[Z']);
  assert.equal(f.commands.length, 1, 'No command is injected for completion');
});

test('workbench : terminal réel, sortie bornée, isolation des sessions et nettoyage', async (t) => {
  const f = fixture(t);
  const session = await f.service.open('remote', ID, body);
  assert.equal(f.clientHosts[0], 'remote');
  assert.deepEqual(f.commands[0].Cmd, ['/bin/sh', '-i']);
  assert.equal(f.commands[0].Tty, true);
  assert.equal(f.commands[0].AttachStdin, true);
  assert.ok(f.commands[0].Env.includes('TERM=xterm-256color'));
  assert.equal(f.commands[0].User, undefined, 'Keep configured container user');
  await f.service.input('remote', ID, session.id, { data: 'cd /etc\n' });
  assert.equal(f.inputs[0], 'cd /etc\n');
  f.streams[0].push(Buffer.alloc(150 * 1024, 'x'));
  await new Promise((resolve) => setImmediate(resolve));
  const output = f.service.readSession('remote', ID, session.id);
  assert.equal(Buffer.byteLength(output.output), 128 * 1024);
  assert.equal(Buffer.from(output.dataBase64, 'base64').length, 128 * 1024);
  assert.equal(output.truncated, true);
  assert.equal(f.service.readSession('remote', ID, session.id, output.cursor).output, '');
  assert.throws(() => f.service.readSession('local', ID, session.id), /introuvable/);
  assert.throws(() => f.service.readSession('remote', OTHER, session.id), /introuvable/);
  await assert.rejects(f.service.input('remote', ID, session.id, { data: 'x'.repeat(8193) }));
  f.setName('/renamed');
  await assert.rejects(
    f.service.input('remote', ID, session.id, { data: 'echo changed\n' }),
    /nom du conteneur/,
  );
  f.service.close('remote', ID, session.id);
  assert.ok(f.inputs.at(-1).includes('exit\n'));
  assert.equal(f.service.sessions.size, 0);
  assert.ok(!JSON.stringify(f.events).includes('cd /etc'));
});

test('workbench : dimensions initiales et redimensionnement PTY bornés et liés à la cible', async (t) => {
  const f = fixture(t);
  const session = await f.service.open('remote', ID, { ...body, cols: 94, rows: 27 });
  assert.equal(session.cols, 94);
  assert.equal(session.rows, 27);
  assert.deepEqual(f.resizes, [{ w: 94, h: 27 }]);
  assert.deepEqual(await f.service.resize('remote', ID, session.id, { cols: 137, rows: 43 }), {
    ok: true,
    cols: 137,
    rows: 43,
  });
  assert.deepEqual(f.resizes.at(-1), { w: 137, h: 43 });
  for (const invalid of [
    { cols: 0, rows: 20 },
    { cols: 401, rows: 20 },
    { cols: 80, rows: 161 },
    { cols: 80.5, rows: 25 },
    { cols: 80, rows: 25, user: 'root' },
  ])
    await assert.rejects(f.service.resize('remote', ID, session.id, invalid));
  await assert.rejects(
    f.service.resize('local', ID, session.id, { cols: 80, rows: 25 }),
    /introuvable/,
  );
  assert.equal(f.resizes.length, 2);
  f.setName('/changed');
  await assert.rejects(
    f.service.resize('remote', ID, session.id, { cols: 80, rows: 25 }),
    /nom du conteneur/,
  );
  f.setName('/web');
  f.setRunning(false);
  await assert.rejects(
    f.service.resize('remote', ID, session.id, { cols: 80, rows: 25 }),
    /Démarre le conteneur/,
  );
  f.setRunning(true);
  f.service.close('remote', ID, session.id);
  await assert.rejects(
    f.service.resize('remote', ID, session.id, { cols: 80, rows: 25 }),
    /introuvable/,
  );
  assert.equal(f.resizes.length, 2);
  await assert.rejects(f.service.open('remote', ID, { ...body, cols: 80, columns: 100 }));
  const legacy = await f.service.open('remote', ID, { ...body, columns: 88, rows: 22 });
  assert.equal(legacy.cols, 88);
});

test('workbench : polling base64 conserve UTF-8 découpé et séquences de terminal exactes', async (t) => {
  const f = fixture(t),
    session = await f.service.open('local', ID, body);
  const bytes = Buffer.from('\x1b[31mélève 🐳\x1b[0m\r\n');
  f.streams[0].push(bytes.subarray(0, 6));
  await new Promise((resolve) => setImmediate(resolve));
  const first = f.service.readSession('local', ID, session.id);
  f.streams[0].push(bytes.subarray(6));
  await new Promise((resolve) => setImmediate(resolve));
  const second = f.service.readSession('local', ID, session.id, first.cursor);
  assert.deepEqual(
    Buffer.concat([
      Buffer.from(first.dataBase64, 'base64'),
      Buffer.from(second.dataBase64, 'base64'),
    ]),
    bytes,
  );
  assert.equal(second.cursor, bytes.length);
  assert.equal(f.service.readSession('local', ID, session.id, second.cursor).dataBase64, '');
  await f.service.input('local', ID, session.id, { data: '\t\x1b[A\x1b[D\r\x03' });
  assert.equal(f.inputs.at(-1), '\t\x1b[A\x1b[D\r\x03');
});

test('workbench : sessions limitées et expiration même si le navigateur continue à lire', async (t) => {
  const f = fixture(t, { idleMs: 100, lifetimeMs: 500 });
  for (let index = 0; index < 6; index++) await f.service.open('local', ID, body);
  await assert.rejects(f.service.open('local', ID, body), (error) => error.statusCode === 429);
  f.setClock(1101);
  f.service.sweep();
  assert.equal(f.service.sessions.size, 0);
  const session = await f.service.open('local', ID, body);
  f.setClock(1550);
  f.service.readSession('local', ID, session.id);
  f.setClock(1602);
  f.service.sweep();
  assert.equal(f.service.sessions.size, 0);
});

test('workbench : image sans shell produit une erreur utile sans installer aucun outil', async (t) => {
  const f = fixture(t);
  f.setShellError('exec: /bin/sh not found');
  await assert.rejects(f.service.open('local', ID, body), /images sans shell/);
  assert.equal(f.service.sessions.size, 0);
  assert.equal(f.service.opening, 0);
  assert.equal((await f.service.readFile('local', ID, '/etc/app.conf')).content, 'initial\n');
});

test('workbench : échec OCI dans un flux HTTP réussi ne crée pas une fausse session', async (t) => {
  const f = fixture(t);
  f.setExecState({ Running: false, ExitCode: 126 });
  await assert.rejects(
    f.service.open('local', ID, { ...body, shell: '/bin/bash' }),
    /n’a pas pu démarrer/,
  );
  assert.equal(f.service.sessions.size, 0);
  assert.equal(f.service.opening, 0);
  assert.equal(f.events.length, 0);
});

test('workbench : parcours shell sans interpolation, liens et noms spéciaux distincts', async (t) => {
  const f = fixture(t);
  const odd = '/etc/a;touch hacked';
  f.paths.set(odd, { mode: directory | 0o755, size: 0 });
  f.setListing('file\0$(touch hacked)\0file\0line\nbreak\0link\0link\0directory\0conf.d\0');
  const result = await f.service.files('remote', ID, odd);
  assert.equal(f.commands[0].Cmd.at(-1), odd);
  assert.ok(
    !f.commands[0].Cmd[2].includes(odd),
    'Path passed as argv, never interpolated into shell',
  );
  assert.equal(result.entries[0].name, 'conf.d');
  assert.equal(result.entries.find((entry) => entry.name === 'line\nbreak').accessible, false);
  assert.equal(result.entries.find((entry) => entry.name === 'link').accessible, false);
  assert.equal(result.entries.find((entry) => entry.name === '$(touch hacked)').accessible, true);
});

test('workbench : chemins canoniques, liens parents et fichiers spéciaux refusés', async (t) => {
  const f = fixture(t);
  for (const filename of [
    'etc/app.conf',
    '/etc/../etc/app.conf',
    '//etc/app.conf',
    '/proc/1/mem',
    '/dev/null',
    '/sys/kernel/a',
    '/etc/app.conf\0',
  ])
    await assert.rejects(f.service.readFile('local', ID, filename));
  assert.equal(f.inspections.length, 0, 'Invalid paths rejected before Docker access');
  f.paths.set('/etc', { mode: 0x08000000 | 0o777, size: 0, linkTarget: '/elsewhere' });
  await assert.rejects(f.service.readFile('local', ID, '/etc/app.conf'), /lien symbolique/);
  f.paths.set('/etc', { mode: directory | 0o755, size: 0 });
  f.setMode(0x01000000 | 0o600);
  await assert.rejects(f.service.readFile('local', ID, '/etc/app.conf'), /fichiers spéciaux/);
  assert.equal(f.writes.length, 0);
});

test('workbench : lecture bornée UTF-8 et archive strictement vérifiée', async (t) => {
  const f = fixture(t);
  f.setFile(Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(
    f.service.readFile('local', ID, '/etc/app.conf'),
    (error) => error.statusCode === 413,
  );
  f.setFile('a\0b');
  await assert.rejects(f.service.readFile('local', ID, '/etc/app.conf'), /binaire/);
  f.setFile(Buffer.from([0xc3, 0x28]));
  await assert.rejects(f.service.readFile('local', ID, '/etc/app.conf'), /UTF-8/);
  f.setFile('valid');
  f.setArchiveHeader({ name: '../wrong' });
  await assert.rejects(f.service.readFile('local', ID, '/etc/app.conf'), /Archive inattendue/);
});

test('workbench : édition optimiste, conflit sans écriture et permissions préservées', async (t) => {
  const f = fixture(t);
  f.setRunning(false);
  const original = await f.service.readFile('local', ID, '/etc/app.conf');
  f.setFile('changed outside');
  await assert.rejects(
    f.service.writeFile('local', ID, {
      ...body,
      path: original.path,
      hash: original.hash,
      content: 'my edit',
    }),
    (error) => error.statusCode === 409,
  );
  assert.equal(f.writes.length, 0);
  const fresh = await f.service.readFile('local', ID, original.path);
  const saved = await f.service.writeFile('local', ID, {
    ...body,
    path: fresh.path,
    hash: fresh.hash,
    content: 'mon réglage\n',
  });
  assert.equal(saved.content, 'mon réglage\n');
  assert.notEqual(saved.hash, fresh.hash);
  assert.equal(f.writes[0].path, '/etc');
  assert.equal(f.writes[0].noOverwriteDirNonDir, true);
  assert.equal(f.writes[0].abortSignal.aborted, true);
  assert.equal(f.events[0].action, 'saved');
  assert.ok(!JSON.stringify(f.events).includes('mon réglage'));
  await assert.rejects(
    f.service.writeFile('local', ID, {
      ...body,
      path: fresh.path,
      hash: saved.hash,
      content: 'é'.repeat(140000),
    }),
    (error) => error.statusCode === 413,
  );
  assert.equal(f.writes.length, 1);
});

test('workbench API : mutation refusée si hôte occupé, lecture et fermeture permises', async (t) => {
  const f = fixture(t),
    app = express();
  let busy = false;
  app.use(express.json());
  const mounted = mountContainerWorkbench(app, { hosts: f.hosts, labBusy: () => busy });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    mounted.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/hosts/local/containers/${ID}/workbench`;
  const post = (url, value) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const open = await post('/terminal', body);
  assert.equal(open.status, 200);
  const session = await open.json();
  busy = true;
  assert.equal((await post('/terminal', body)).status, 409);
  assert.equal((await post(`/terminal/${session.id}/input`, { data: 'echo test\n' })).status, 409);
  assert.equal((await post(`/terminal/${session.id}/resize`, { cols: 100, rows: 30 })).status, 409);
  busy = false;
  assert.equal((await post(`/terminal/${session.id}/resize`, { cols: 100, rows: 30 })).status, 200);
  assert.equal((await post(`/terminal/${session.id}/resize`, { cols: 0, rows: 30 })).status, 400);
  assert.equal((await fetch(base + '/file?path=/etc/app.conf')).status, 200);
  assert.equal((await fetch(base + `/terminal/${session.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + `/terminal/${session.id}`)).status, 404);
});

test('workbench upload : bytes binaires exacts, fichier ordinaire sans shell et identité vérifiée', async (t) => {
  const f = fixture(t),
    content = Buffer.from([0, 255, 128, 1, 13, 10, 65]);
  f.setShellError('No shell installed');
  f.setRunning(false);
  await assert.rejects(
    f.service.uploadFile('local', ID, { expectedName: 'old', path: '/etc/image.bin' }, content),
    /nom du conteneur/,
  );
  const result = await f.service.uploadFile(
    'remote',
    ID,
    { ...body, path: '/etc/image.bin' },
    content,
  );
  assert.deepEqual(f.uploaded.get('/etc/image.bin'), content);
  assert.equal(result.path, '/etc/image.bin');
  assert.equal(result.bytes, content.length);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(f.commands.length, 0);
  assert.equal(f.writes[0].path, '/etc');
  assert.equal(f.writes[0].noOverwriteDirNonDir, true);
  assert.equal(f.writes[0].abortSignal.aborted, true);
  assert.equal(f.events[0].action, 'uploaded');
  assert.equal(f.events[0].hostId, 'remote');
  await f.service.uploadFile('local', ID, { ...body, path: '/etc/empty.txt' }, Buffer.alloc(0));
  assert.equal(f.uploaded.get('/etc/empty.txt').length, 0);
});

test('workbench upload : traversal, chemins spéciaux et limites refusés avant Docker', async (t) => {
  const f = fixture(t);
  for (const value of [
    '/',
    'etc/new',
    '/etc/../new',
    '//etc/new',
    '/etc/new/',
    '/proc/new',
    '/sys/new',
    '/dev/new',
    '/etc/a\\b',
    '/etc/new\0',
  ])
    await assert.rejects(
      f.service.uploadFile('local', ID, { ...body, path: value }, Buffer.from('x')),
    );
  await assert.rejects(
    f.service.uploadFile(
      'local',
      ID,
      { ...body, path: '/etc/new', overwrite: true },
      Buffer.from('x'),
    ),
  );
  await assert.rejects(
    f.service.uploadFile('local', ID, { ...body, path: '/etc/new' }, 'text'),
    (error) => error.statusCode === 415,
  );
  await assert.rejects(
    f.service.uploadFile(
      'local',
      ID,
      { ...body, path: '/etc/new' },
      Buffer.alloc(UPLOAD_LIMIT + 1),
    ),
    (error) => error.statusCode === 413,
  );
  assert.equal(f.inspections.length, 0);
  assert.equal(f.writes.length, 0);
});

test('workbench upload : aucun remplacement de fichier, dossier, lien ni fichier spécial', async (t) => {
  const f = fixture(t);
  f.paths.set('/etc/folder', { mode: directory | 0o755, size: 0 });
  f.paths.set('/etc/link', { mode: 0x08000000 | 0o777, size: 0, linkTarget: '/elsewhere' });
  f.paths.set('/etc/socket', { mode: 0x01000000 | 0o600, size: 0 });
  for (const filename of ['/etc/app.conf', '/etc/folder', '/etc/link', '/etc/socket'])
    await assert.rejects(
      f.service.uploadFile('local', ID, { ...body, path: filename }, Buffer.from('x')),
      (error) => error.statusCode === 409,
    );
  assert.equal(f.writes.length, 0);
  assert.equal((await f.service.readFile('local', ID, '/etc/app.conf')).content, 'initial\n');
});

test('workbench upload : parent manquant, lien ou non-dossier refusé', async (t) => {
  const f = fixture(t),
    upload = (value) =>
      f.service.uploadFile('local', ID, { ...body, path: value }, Buffer.from('x'));
  await assert.rejects(upload('/missing/new'), (error) => error.statusCode === 404);
  await assert.rejects(upload('/etc/app.conf/new'), /pas un dossier/);
  f.paths.set('/etc', { mode: 0x08000000 | 0o777, size: 0, linkTarget: '/elsewhere' });
  await assert.rejects(upload('/etc/new'), /lien symbolique/);
  f.paths.set('/etc', { mode: 0x01000000 | 0o600, size: 0 });
  await assert.rejects(upload('/etc/new'), /fichiers spéciaux/);
  assert.equal(f.writes.length, 0);
});

test('workbench upload : parents et absence revérifiés juste avant extraction', async (t) => {
  const f = fixture(t);
  let visits = 0;
  f.setBeforePath((value) => {
    if (value === '/etc/new' && ++visits === 2) f.paths.set(value, { mode: 0o600, size: 7 });
  });
  await assert.rejects(
    f.service.uploadFile('local', ID, { ...body, path: '/etc/new' }, Buffer.from('x')),
    (error) => error.statusCode === 409,
  );
  assert.equal(visits, 2);
  assert.equal(f.writes.length, 0);
  visits = 0;
  f.setBeforePath((value) => {
    if (value === '/etc' && ++visits === 2)
      f.paths.set('/etc', { mode: 0x08000000 | 0o777, size: 0, linkTarget: '/elsewhere' });
  });
  await assert.rejects(
    f.service.uploadFile('local', ID, { ...body, path: '/etc/other' }, Buffer.from('x')),
    /lien symbolique/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.service.writes.size, 0, 'Failed uploads release the file lock');
});

test('workbench upload HTTP : binaire brut borné, pas de JSON, hôte occupé et conflit explicites', async (t) => {
  const f = fixture(t),
    app = express();
  let busy = false;
  app.use(express.json({ limit: '1mb' }));
  const service = mountContainerWorkbench(app, { hosts: f.hosts, labBusy: () => busy });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    service.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/hosts/local/containers/${ID}/workbench/upload?expectedName=web&path=/etc/upload.bin`;
  const post = (content, type = 'application/octet-stream') =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: content });
  assert.equal((await post('{}', 'application/json')).status, 415);
  busy = true;
  assert.equal((await post(Buffer.from([0, 255]))).status, 409);
  busy = false;
  const oversized = await post(Buffer.alloc(UPLOAD_LIMIT + 1));
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /20 Mio/);
  assert.equal(f.writes.length, 0);
  const content = Buffer.from([0, 255, 9, 200, 0]);
  const first = await post(content);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).bytes, 5);
  assert.deepEqual(f.uploaded.get('/etc/upload.bin'), content);
  const second = await post(Buffer.from('different'));
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /autre nom/);
  assert.deepEqual(f.uploaded.get('/etc/upload.bin'), content);
});

test('workbench upload : vérification du contenu après extraction et limite exacte', async (t) => {
  const f = fixture(t);
  const maximum = Buffer.alloc(UPLOAD_LIMIT, 127);
  const saved = await f.service.uploadFile(
    'local',
    ID,
    { ...body, path: '/etc/maximum.bin' },
    maximum,
  );
  assert.equal(saved.bytes, UPLOAD_LIMIT);
  assert.deepEqual(f.uploaded.get('/etc/maximum.bin'), maximum);
  f.setBeforePath((value) => {
    if (value === '/etc/changed.bin' && f.uploaded.has(value))
      f.uploaded.set(value, Buffer.from('y'));
  });
  await assert.rejects(
    f.service.uploadFile('local', ID, { ...body, path: '/etc/changed.bin' }, Buffer.from('x')),
    (error) => error.statusCode === 409 && /contenu/.test(error.message),
  );
  assert.equal(f.events.length, 1, 'No success event for a changed upload');
  assert.equal(f.service.writes.size, 0);
});
