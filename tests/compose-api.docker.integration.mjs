import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker } from '../server/docker.mjs';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { createProjectService, mountProjectApi } from '../server/projects.mjs';
import { patchComposeService } from '../shared/compose-project.mjs';
import { openProjectStore } from '../server/project-store.mjs';

const ui = process.argv.includes('--ui');
const draftsOnly = process.argv.includes('--drafts-only');
const resumeIndex = process.argv.indexOf('--resume-dir');
if (draftsOnly && (!ui || resumeIndex !== -1))
  throw Error('Le mode brouillons exige --ui et un nouveau dossier temporaire.');
let dir;
if (resumeIndex !== -1) {
  if (!ui || !process.argv[resumeIndex + 1])
    throw Error('La reprise exige --ui et un dossier de test.');
  dir = path.resolve(process.argv[resumeIndex + 1]);
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-compose-api-'))
    throw Error('Unexpected test path');
  await stat(path.join(dir, 'projects-v1.json'));
} else dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-compose-api-'));
const ownedNames = new Set(),
  events = new Set();
const app = express();
app.use(express.json({ limit: '5mb' }));
if (draftsOnly)
  app.use('/api', (req, res, next) => {
    // A deliberately small allowlist: browser QA may save drawings and read the
    // host, but cannot reach any Docker deployment, image pull or capture route.
    const allowed =
      ['GET', 'HEAD'].includes(req.method) ||
      (req.method === 'POST' &&
        (req.path === '/projects' || /^\/hosts\/[^/]+\/ai-storage-preview$/.test(req.path))) ||
      (req.method === 'PUT' && /^\/projects\/[^/]+\/compose\/source$/.test(req.path));
    if (!allowed)
      return res.status(403).json({
        error:
          'Test sans téléchargement : seuls les brouillons et les vérifications en lecture sont autorisés.',
      });
    next();
  });
let service, workspace, server;
try {
  await docker.info();
  const emit = (e) => {
    for (const res of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    events.add(res);
    req.on('close', () => events.delete(res));
  });
  workspace = await mountWorkspaceApi(app, {
    dataDir: dir,
    localDocker: docker,
    emit,
    labBusy: (id) => service?.hostBusy(id) || false,
    guardHost: (id, next) => service?.guardHost(id, next),
    projectList: () => service?.list() || [],
  });
  service = await createProjectService({ dataDir: dir, workspace, emit });
  mountProjectApi(app, service);
  app.use('/api', (_, res) => res.status(404).json({ error: 'Route inconnue.' }));
  if (ui)
    app.get('/_test/compose-drop', async (_req, res) => {
      const testName = 'dtr-ui-drop-' + Date.now().toString(36);
      const source = `name: ${testName}\nservices:\n  client:\n    image: alpine:3.23\n    pull_policy: never\n    command: [sleep, infinity]\n    network_mode: none\n    cpus: 0.1\n    mem_limit: 32m\n`;
      const html = await readFile(path.join(dist, 'index.html'), 'utf8');
      const testControls = `<aside style="position:fixed;left:20px;top:350px;z-index:9999;padding:12px;background:#edf5fa;border:1px solid #6d8b9d;max-width:220px"><button id="test-compose-source" draggable="true">Glisser compose-test.yaml sur la carte</button><small id="test-drag-status">Test isolé, Alpine déjà présent</small></aside><script>const source=document.getElementById('test-compose-source'),status=document.getElementById('test-drag-status');source.addEventListener('dragstart',event=>{event.dataTransfer.items.add(new File([${JSON.stringify(source)}],'compose-test.yaml',{type:'application/yaml'}));event.dataTransfer.effectAllowed='copy';status.textContent='Glissement: '+[...event.dataTransfer.types].join(',');});window.addEventListener('drop',event=>{status.textContent='Dépôt reçu: '+event.dataTransfer.files.length;},true);</script>`;
      res.type('html').send(html.replace('</body>', testControls + '</body>'));
    });
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  app.use(express.static(dist));
  app.get('/{*path}', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use((e, req, res, next) => res.status(e.statusCode || 400).json({ error: e.message }));
  server = app.listen(ui ? 4314 : 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  if (ui) {
    console.log(
      `Fixture Compose indépendante → http://127.0.0.1:4314 · ${dir}\nSaisir close pour fermer et nettoyer uniquement ses projets Compose.`,
    );
    if (draftsOnly)
      console.log(
        'MODE BROUILLONS : aucun déploiement, téléchargement ou changement Docker autorisé.',
      );
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.on('data', (b) => {
        if (String(b).includes('close')) {
          process.stdin.pause();
          resolve();
        }
      });
    });
  } else {
    const api = async (url, body, revision, method = 'POST') => {
      const response = await fetch(
        'http://127.0.0.1:' + server.address().port + '/api' + url,
        body === undefined
          ? {}
          : {
              method,
              headers: { 'Content-Type': 'application/json', 'If-Match': String(revision || 1) },
              body: JSON.stringify(body),
            },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      return data;
    };
    const name = 'dtr-api-' + Date.now().toString(36);
    ownedNames.add(name);
    const source =
      '# source utilisateur\nservices:\n  cache:\n    image: redis:7-alpine\n    volumes: [data:/data]\n    healthcheck:\n      test: [CMD, redis-cli, ping]\n      interval: 1s\n      retries: 10\n  client:\n    image: alpine:3.23\n    command: [sleep, infinity]\n    depends_on:\n      cache:\n        condition: service_healthy\nvolumes:\n  data: {}\n';
    const p = (
      await api('/projects', {
        name: 'Compose intégration',
        hostId: 'local',
        compose: { projectName: name, source, waitSeconds: 20 },
      })
    ).project;
    const state = () => api('/projects/' + p.id + '/state'),
      record = () => service.store.get(p.id),
      action = (route, body, method) =>
        api('/projects/' + p.id + route, body, record().revision, method);
    assert.equal(p.kind, 'compose');
    assert.equal((await state()).runtime.deployed, false);
    await assert.rejects(
      action('/compose/source', { ...record().compose, source: 'services: [' }, 'PUT'),
    );
    assert.equal((await state()).compose.source, source);
    let preview = await action('/compose/preview', record().compose);
    assert.equal(preview.services.length, 2);
    assert.equal((await state()).runtime.deployed, false);
    await action(
      '/compose/source',
      { ...record().compose, source: source + '# modification\n' },
      'PUT',
    );
    await assert.rejects(action('/compose/apply', { token: preview.token }), /expiré|changé/);
    preview = await action('/compose/preview', record().compose);
    await action('/compose/apply', { token: preview.token });
    let s = await state();
    assert.equal(s.runtime.services.cache[0].state, 'running');
    assert.equal(s.runtime.services.cache[0].health, 'healthy');
    const cacheId = s.runtime.services.cache[0].id,
      clientId = s.runtime.services.client[0].id;
    await action('/compose/nodes/' + cacheId + '/action', { action: 'stop' });
    assert.equal((await state()).runtime.services.cache[0].state, 'exited');
    await action('/compose/nodes/' + cacheId + '/action', { action: 'start' });
    await action(
      '/compose/source',
      {
        ...record().compose,
        source: patchComposeService(record().compose.source, 'client', 'environment', {
          GUI: 'preserved',
        }),
      },
      'PUT',
    );
    preview = await action('/compose/preview', record().compose);
    await action('/compose/apply', { token: preview.token });
    s = await state();
    assert.equal(s.runtime.services.cache[0].id, cacheId);
    assert.notEqual(s.runtime.services.client[0].id, clientId);
    assert.ok(s.compose.previousApplied.source.includes('depends_on'));
    const reopened = await openProjectStore(dir);
    assert.equal(reopened.get(p.id).compose.source, s.compose.source);
    assert.ok(s.deployments.some((d) => d.status === 'succeeded' && d.output));
    // An actual Docker mutation after preview must invalidate the deployment plan.
    preview = await action('/compose/preview', record().compose);
    await docker.getContainer(cacheId).stop({ t: 1 });
    await assert.rejects(action('/compose/apply', { token: preview.token }), /Docker a changé/);
    const goodSource = record().compose.lastApplied.source;
    await action(
      '/compose/source',
      {
        ...record().compose,
        source: patchComposeService(record().compose.source, 'client', 'command', ['false']),
      },
      'PUT',
    );
    preview = await action('/compose/preview', record().compose);
    await assert.rejects(action('/compose/apply', { token: preview.token }));
    s = await state();
    assert.equal(s.deployments[0].status, 'failed');
    assert.ok(s.deployments[0].output);
    assert.equal(s.compose.lastApplied.source, goodSource);
    await action('/compose/action', { action: 'down' });
    assert.equal((await state()).runtime.deployed, false);
    assert.ok(await docker.getVolume(name + '_data').inspect());
    // Existing Compose-labelled volumes cannot be silently adopted by a new project.
    const collision = 'dtr-collision-' + Date.now().toString(36);
    ownedNames.add(collision);
    await docker.createVolume({
      Name: collision + '_data',
      Labels: { 'com.docker.compose.project': collision },
    });
    const c = (
      await api('/projects', {
        name: 'Collision',
        hostId: 'local',
        compose: { projectName: collision, source },
      })
    ).project;
    await assert.rejects(
      api('/projects/' + c.id + '/compose/preview', service.store.get(c.id).compose, c.revision),
      /existent déjà/,
    );
    const adopt = 'dtr-adopt-' + Date.now().toString(36);
    ownedNames.add(adopt);
    await docker.createVolume({
      Name: adopt + '_data',
      Labels: { 'com.docker.compose.project': adopt, 'com.docker.compose.volume': 'data' },
    });
    const a = (
      await api('/projects', {
        name: 'Adoption explicite',
        hostId: 'local',
        compose: { projectName: adopt, source, adopt: true },
      })
    ).project;
    const adoption = await api(
      '/projects/' + a.id + '/compose/preview',
      service.store.get(a.id).compose,
      a.revision,
    );
    assert.equal(adoption.projectName, adopt);
    console.log(
      'Compose API : import, validation, révisions, aperçu, vrais déploiements, remplacement ciblé, actions, historique persistant, collision, adoption et conservation des volumes : OK.',
    );
  }
} finally {
  for (const res of events) res.end();
  if (server) await new Promise((r) => server.close(r));
  for (const p of service?.store.list() || []) if (p.compose) ownedNames.add(p.compose.projectName);
  await service?.shutdown();
  await workspace?.shutdown();
  for (const name of draftsOnly ? [] : ownedNames) {
    const filters = { label: ['com.docker.compose.project=' + name] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-compose-api-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Serveur et projets Compose de ce test nettoyés.');
}
