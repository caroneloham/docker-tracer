// Real integration test: one disposable container, an image already cached, no pulls.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { docker } from '../server/docker.mjs';
import { mountContainerWorkbench } from '../server/container-workbench.mjs';
import { mountContainerResources } from '../server/container-resources.mjs';
import { decodeDockerLog } from '../server/streams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID(),
  label = 'io.dockertracer.maintenance-workbench-test';
const name = `dtr-workbench-test-${runId.slice(0, 8)}`;
const evidenceDir = path.resolve(root, '..', '..', 'work');
const evidencePath = path.join(evidenceDir, `maintenance-workbench-${runId}.json`);
const ui = process.argv.includes('--ui');
const evidence = {
  runId,
  startedAt: new Date().toISOString(),
  tests: [],
  image: 'alpine:3.23',
  noPull: true,
};
let owned, id, server, workbench, vite, closing, uiTimer;
const snapshot = async () => {
  const [containers, images, networks, volumes] = await Promise.all([
    docker.listContainers({ all: true }),
    docker.listImages({ all: true }),
    docker.listNetworks(),
    docker.listVolumes(),
  ]);
  return {
    containers: containers
      .map((item) => ({ id: item.Id, state: item.State }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    images: images.map((item) => item.Id).sort(),
    networks: networks.map((item) => item.Id).sort(),
    volumes: (volumes.Volumes || []).map((item) => item.Name).sort(),
  };
};
const saveEvidence = async () => {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
};
async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    clearTimeout(uiTimer);
    workbench?.shutdown();
    await vite?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (owned) {
      const info = await owned.inspect().catch((error) => {
        if (error.statusCode !== 404) throw error;
        return null;
      });
      if (info) {
        assert.equal(info.Id, id);
        assert.equal(info.Config.Labels[label], runId);
        assert.equal(info.Name, '/' + name);
        await owned.remove({ force: true, v: false });
      }
    }
    evidence.after = await snapshot();
    evidence.finishedAt = new Date().toISOString();
    evidence.cleanup = {
      testContainerRemoved: !evidence.after.containers.some((entry) => entry.id === id),
      imagesUnchanged:
        JSON.stringify(evidence.before.images) === JSON.stringify(evidence.after.images),
      networksUnchanged:
        JSON.stringify(evidence.before.networks) === JSON.stringify(evidence.after.networks),
      volumesUnchanged:
        JSON.stringify(evidence.before.volumes) === JSON.stringify(evidence.after.volumes),
      originalContainersPreserved: evidence.before.containers.every((entry) =>
        evidence.after.containers.some((after) => after.id === entry.id),
      ),
      originalContainerStatesUnchanged: evidence.before.containers.every((entry) =>
        evidence.after.containers.some(
          (after) => after.id === entry.id && after.state === entry.state,
        ),
      ),
      addedContainerIds: evidence.after.containers
        .filter((entry) => !evidence.before.containers.some((before) => before.id === entry.id))
        .map((entry) => entry.id),
    };
    await saveEvidence();
    console.log(JSON.stringify({ evidencePath, tests: evidence.tests, cleanup: evidence.cleanup }));
    assert.equal(evidence.cleanup.testContainerRemoved, true);
    assert.equal(evidence.cleanup.imagesUnchanged, true);
    assert.equal(evidence.cleanup.originalContainersPreserved, true);
  })();
  return closing;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ownExec(command, user) {
  const execution = await owned.exec({
    Cmd: ['/bin/sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    ...(user ? { User: user } : {}),
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const info = await execution.inspect();
  assert.equal(info.ExitCode, 0, decodeDockerLog(Buffer.concat(chunks)));
  return decodeDockerLog(Buffer.concat(chunks));
}

try {
  evidence.before = await snapshot();
  await docker.getImage(evidence.image).inspect(); // Throws if absent. Never pulls.
  await saveEvidence();
  owned = await docker.createContainer({
    Image: evidence.image,
    name,
    Cmd: [
      '/bin/sh',
      '-c',
      'mkdir -p /tmp/workbench; if [ ! -e /tmp/workbench/app.conf ]; then printf "port=8080\\n" > /tmp/workbench/app.conf; chmod 640 /tmp/workbench/app.conf; chown 1234:1235 /tmp/workbench/app.conf; ln -s /tmp/workbench/app.conf /tmp/workbench/linked.conf; mkfifo /tmp/workbench/fifo; fi; exec sleep 86400',
    ],
    Labels: { [label]: runId },
    HostConfig: {
      NetworkMode: 'none',
      Memory: 64 * 1024 * 1024,
      NanoCpus: 100000000,
      PidsLimit: 64,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN'],
    },
  });
  id = owned.id;
  evidence.containerId = id;
  await owned.start();
  await saveEvidence();
  const scopedEngine = {
    info: () => docker.info(),
    getContainer(target) {
      assert.equal(target, id, 'Only the test container is accessible');
      return owned;
    },
    modem: docker.modem,
  };
  const hosts = {
    profile(host) {
      assert.equal(host, 'local');
      return { id: 'local', name: 'Test réel isolé', kind: 'local' };
    },
    async client(host) {
      this.profile(host);
      return scopedEngine;
    },
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    if (!['127.0.0.1', 'localhost'].includes(req.hostname))
      return res.status(403).json({ error: 'Hôte interdit.' });
    if (
      req.headers.origin &&
      ![
        `http://127.0.0.1:${server.address().port}`,
        `http://localhost:${server.address().port}`,
      ].includes(req.headers.origin)
    )
      return res.status(403).json({ error: 'Origine interdite.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-docker-tracer'] !== '1')
      return res.status(403).json({ error: 'En-tête requis.' });
    next();
  });
  workbench = mountContainerWorkbench(app, { hosts });
  mountContainerResources(app, { hosts });
  app.get('/api/test-target', async (_req, res) =>
    res.json({
      id,
      name,
      hostId: 'local',
      hostName: 'TEST RÉEL ISOLÉ',
      image: evidence.image,
      state: (await owned.inspect()).State.Running ? 'running' : 'exited',
    }),
  );
  app.get('/api/hosts/local/containers/:id/logs', async (req, res) => {
    if (req.params.id !== id) return res.status(403).json({ error: 'Cible non autorisée.' });
    const result = await owned.logs({ stdout: true, stderr: true, timestamps: true, tail: 150 });
    res.json({ output: decodeDockerLog(result).slice(-48000) });
  });
  app.post('/api/hosts/local/containers/:id/action', async (req, res) => {
    if (
      req.params.id !== id ||
      req.body.expectedName !== name ||
      !['start', 'stop', 'restart'].includes(req.body.action)
    )
      return res.status(403).json({ error: 'Cible non autorisée.' });
    try {
      await owned[req.body.action](req.body.action === 'start' ? {} : { t: 1 });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route absente du test isolé.' }));
  if (ui) {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
    app.get('/', async (_req, res) =>
      res
        .type('html')
        .send(
          await vite.transformIndexHtml(
            '/',
            '<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Workbench · Docker réel isolé</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/maintenance-workbench-ui.jsx"></script></body></html>',
          ),
        ),
    );
    app.use(vite.middlewares);
  }
  server = app.listen(ui ? 4316 : 0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/hosts/local/containers/${id}/workbench`;
  const resourcesBase = base.replace(/\/workbench$/, '/resources');
  const resourceCall = async (suffix = '', body) => {
    const response = await fetch(resourcesBase + suffix, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };
  const resourceBefore = await resourceCall();
  const beforeHostConfig = (await owned.inspect()).HostConfig;
  const resourcePreview = await resourceCall('/preview', {
    expectedName: name,
    version: resourceBefore.version,
    cpus: 0.2,
    memoryBytes: 80 * 1024 * 1024,
  });
  const resourceApplied = await resourceCall('/apply', {
    expectedName: name,
    token: resourcePreview.token,
  });
  assert.equal(resourceApplied.resources.limits.cpus, 0.2);
  assert.equal(resourceApplied.resources.limits.memoryBytes, 80 * 1024 * 1024);
  const afterHostConfig = (await owned.inspect()).HostConfig;
  for (const field of [
    'MemorySwap',
    'NetworkMode',
    'PidsLimit',
    'CapDrop',
    'CapAdd',
    'RestartPolicy',
    'DeviceRequests',
  ])
    assert.deepEqual(
      afterHostConfig[field],
      beforeHostConfig[field],
      `Resource update preserves ${field}`,
    );
  evidence.tests.push(
    'real CPU/RAM preview and update, preserving swap, capabilities, networks, GPU and restart policy',
  );
  const call = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error), { status: response.status });
    return result;
  };
  let terminalOutput = '',
    cursor = 0;
  await assert.rejects(
    call('/terminal', { expectedName: name, shell: '/bin/bash' }),
    /n’a pas pu démarrer/,
  );
  evidence.tests.push('missing shell produces actionable error and no false open session');
  const discoveredShells = await call('/terminal/shells?expectedName=' + encodeURIComponent(name));
  assert.equal(discoveredShells.preferred, '/bin/ash');
  assert.ok(discoveredShells.shells.some((shell) => shell.path === '/bin/sh'));
  assert.ok(!discoveredShells.shells.some((shell) => shell.label === 'Bash'));
  evidence.tests.push('real shell detection resolves Alpine symlinks and prefers installed Ash');
  const session = await call('/terminal', {
    expectedName: name,
    shell: '/bin/sh',
    cols: 96,
    rows: 28,
  });
  const terminalDecoder = new StringDecoder('utf8');
  const waitOutput = async (pattern) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await call(`/terminal/${session.id}?cursor=${cursor}`);
      cursor = result.cursor;
      terminalOutput += terminalDecoder.write(Buffer.from(result.dataBase64, 'base64'));
      if (pattern.test(terminalOutput)) return result;
      await pause(100);
    }
    throw Error(
      `Expected terminal output not received: ${pattern}; actual: ${terminalOutput.slice(-2000)}`,
    );
  };
  await call(`/terminal/${session.id}/input`, { data: 'stty size\r' });
  await waitOutput(/(?:\r?\n)28 96\r?\n/);
  terminalOutput = '';
  assert.deepEqual(await call(`/terminal/${session.id}/resize`, { cols: 137, rows: 43 }), {
    ok: true,
    cols: 137,
    rows: 43,
  });
  await call(`/terminal/${session.id}/input`, { data: 'stty size\rprintf "%s\\n" "$TERM"\r' });
  await waitOutput(/(?:\r?\n)43 137\r?\n/);
  await waitOutput(/(?:\r?\n)xterm-256color\r?\n/);
  evidence.tests.push(
    'real PTY size: initial 28x96, resize to 43x137 verified with stty; TERM=xterm-256color',
  );
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, { data: 'cd /tmp/workb\t\r' });
  for (const data of ['p', 'w', 'd', '\r']) await call(`/terminal/${session.id}/input`, { data });
  await waitOutput(/(?:\r?\n)\/tmp\/workbench\r?\n/);
  evidence.tests.push(
    'real keyboard: Tab completes directory, character-by-character pwd + Enter executes',
  );
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, { data: 'echo arrow-kk\x1b[D\x7fo\x1b[F\r' });
  await waitOutput(/(?:\r?\n)arrow-ok\r?\n/);
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, { data: '\x1b[A\r' });
  await waitOutput(/(?:\r?\n)arrow-ok\r?\n/);
  evidence.tests.push(
    'real keyboard: left arrow edits line, backspace removes character, up arrow recalls history',
  );
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, { data: 'printf "élève 🐳\\n"\r' });
  await waitOutput(/(?:\r?\n)élève 🐳\r?\n/);
  evidence.tests.push(
    'real terminal: UTF-8 accented text and emoji round-trip through base64 polling',
  );
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, {
    data: 'cd /tmp/workbench\npwd\nprintf "real-shell-ok\\n"\n',
  });
  await waitOutput(/\/tmp\/workbench[\r\n]+.*(?:\r?\n)?/);
  await waitOutput(/(?:\r?\n)real-shell-ok\r?\n/);
  evidence.tests.push('real terminal: cd + pwd + printf, same shell session');
  terminalOutput = '';
  await call(`/terminal/${session.id}/input`, { data: 'sleep 30\n' });
  await pause(300);
  await call(`/terminal/${session.id}/input`, { data: '\x03' });
  await call(`/terminal/${session.id}/input`, { data: 'printf "interrupt-ok\\n"\n' });
  await waitOutput(/(?:\r?\n)interrupt-ok\r?\n/);
  evidence.tests.push('real terminal: Ctrl+C interrupts child and shell remains usable');
  await call(`/terminal/${session.id}`, undefined, 'DELETE');
  await pause(1200);
  const lingering = await ownExec('ps -o pid,ppid,args');
  assert.ok(!lingering.includes('/bin/sh -i'), 'Interactive shell should exit after session close');
  evidence.tests.push('closed terminal leaves no interactive shell process');
  const listing = await call('/files?path=/tmp/workbench');
  assert.equal(listing.entries.find((entry) => entry.name === 'app.conf').type, 'file');
  assert.equal(listing.entries.find((entry) => entry.name === 'linked.conf').accessible, false);
  assert.equal(listing.entries.find((entry) => entry.name === 'fifo').accessible, false);
  const initial = await call('/file?path=/tmp/workbench/app.conf');
  assert.equal(initial.content, 'port=8080\n');
  await assert.rejects(call('/file?path=/tmp/workbench/linked.conf'), /lien symbolique/);
  await assert.rejects(call('/file?path=/tmp/workbench/fifo'), /fichiers spéciaux/);
  const saved = await call(
    '/file',
    { expectedName: name, path: initial.path, hash: initial.hash, content: 'port=9090\n' },
    'PUT',
  );
  assert.equal(saved.content, 'port=9090\n');
  assert.equal(
    (await ownExec('stat -c "%a:%u:%g" /tmp/workbench/app.conf')).trim(),
    '640:1234:1235',
  );
  evidence.tests.push(
    'real file listing/read/write, symlink and FIFO blocked, mode/uid/gid preserved',
  );
  await ownExec('printf "external-change\\n" > /tmp/workbench/app.conf', '1234:1235');
  await assert.rejects(
    call(
      '/file',
      { expectedName: name, path: saved.path, hash: saved.hash, content: 'must-not-write\n' },
      'PUT',
    ),
    (error) => error.status === 409,
  );
  assert.equal((await call('/file?path=/tmp/workbench/app.conf')).content, 'external-change\n');
  evidence.tests.push('real concurrent edit rejected without overwriting external content');
  const upload = async (target, content) => {
    const response = await fetch(
      `${base}/upload?${new URLSearchParams({ path: target, expectedName: name })}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Docker-Tracer': '1' },
        body: content,
      },
    );
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error), { status: response.status });
    return result;
  };
  const binary = Buffer.from([0, 255, 128, 13, 10, 0, 65, 197, 21]);
  const binaryHash = createHash('sha256').update(binary).digest('hex');
  const uploaded = await upload('/tmp/workbench/roundtrip.bin', binary);
  assert.equal(uploaded.bytes, binary.length);
  assert.equal(uploaded.hash, binaryHash);
  assert.equal(
    (await ownExec('sha256sum /tmp/workbench/roundtrip.bin')).split(/\s/)[0],
    binaryHash,
  );
  assert.equal(
    (await ownExec('stat -c "%a:%u:%g" /tmp/workbench/roundtrip.bin')).trim(),
    '644:0:0',
  );
  for (const target of [
    '/tmp/workbench/roundtrip.bin',
    '/tmp/workbench/linked.conf',
    '/tmp/workbench/fifo',
    '/tmp/workbench',
  ])
    await assert.rejects(
      upload(target, Buffer.from('must-not-overwrite')),
      (error) => error.status === 409,
    );
  assert.equal(
    (await ownExec('sha256sum /tmp/workbench/roundtrip.bin')).split(/\s/)[0],
    binaryHash,
  );
  await assert.rejects(
    upload('/tmp/missing-upload-parent/file.txt', Buffer.from('x')),
    (error) => error.status === 404,
  );
  await assert.rejects(
    upload('/tmp/workbench/../escaped', Buffer.from('x')),
    (error) => error.status === 400,
  );
  evidence.tests.push(
    'real binary upload: exact SHA-256, 0644 regular file, existing file/directory/symlink/FIFO refused, traversal and missing parent refused',
  );
  await owned.stop({ t: 1 });
  const stopped = await call('/file?path=/tmp/workbench/app.conf');
  assert.equal(stopped.content, 'external-change\n');
  await call(
    '/file',
    {
      expectedName: name,
      path: stopped.path,
      hash: stopped.hash,
      content: 'edited-while-stopped\n',
    },
    'PUT',
  );
  assert.equal(
    (await call('/file?path=/tmp/workbench/app.conf')).content,
    'edited-while-stopped\n',
  );
  await assert.rejects(call('/terminal', { expectedName: name }), (error) => error.status === 409);
  evidence.tests.push('stopped container: file read/edit works, terminal rejected');
  const stoppedUpload = await upload(
    '/tmp/workbench/stopped-upload.txt',
    Buffer.from('uploaded-while-stopped\n'),
  );
  assert.equal(stoppedUpload.bytes, 23);
  assert.equal(
    (await call('/file?path=/tmp/workbench/stopped-upload.txt')).content,
    'uploaded-while-stopped\n',
  );
  evidence.tests.push('stopped container: file upload works through Docker archive without shell');
  await saveEvidence();
  console.log(JSON.stringify({ passed: evidence.tests, evidencePath }));
  if (ui) {
    await owned.start();
    console.log(
      JSON.stringify({
        ui: 'http://127.0.0.1:4316/',
        containerId: id,
        name,
        command: 'Type close then Enter to remove only this test container.',
      }),
    );
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    await new Promise((resolve) => {
      process.stdin.on('data', (text) => {
        if (text.trim() === 'close') resolve();
      });
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      uiTimer = setTimeout(resolve, 20 * 60 * 1000);
    });
    process.stdin.pause();
  }
} catch (error) {
  evidence.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await cleanup();
}
