// Explicit offline browser fixture. Nothing in this file contacts Docker or
// launches a child process. Synthetic resources are held in memory and records
// are stored in one disposable directory owned by this process.
import express from 'express';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureEngine } from './fixtures/engine.mjs';
import { createWorkbenchDockerFixture } from './helpers/container-workbench-fixture.mjs';
import { tsharkFields } from '../server/packets.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-maintenance-ui-'));
const neverExecute = () => {
  throw Error('TEST SYNTHETIQUE : tout sous-processus, Docker CLI et Compose est désactivé.');
};
// server/docker.mjs normally discovers a context at import time. Keep its
// fallback client disconnected and make process execution impossible even if a
// future API route forgets the HTTP allowlist below.
process.env.DOCKER_HOST = `unix://${path.join(dir, 'docker-disabled.sock')}`;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  childProcess[name] = neverExecute;
syncBuiltinESMExports();

const { docker: unusedGlobalDocker } = await import('../server/docker.mjs');
unusedGlobalDocker.modem.buildRequest = neverExecute;
unusedGlobalDocker.modem.dial = neverExecute;
const { mountWorkspaceApi } = await import('../server/workspace-api.mjs');
const { createProjectService, mountProjectApi } = await import('../server/projects.mjs');

const fixture = fixtureEngine(4);
const workbenches = new Map();
const rawStreams = new WeakSet();
const originalGetContainer = fixture.docker.getContainer.bind(fixture.docker);
const originalDemux = fixture.docker.modem.demuxStream.bind(fixture.docker.modem);
const originalNetworks = fixture.docker.listNetworks.bind(fixture.docker);
fixture.docker.modem.demuxStream = (stream, stdout, stderr) =>
  rawStreams.has(stream) ? stream.pipe(stdout) : originalDemux(stream, stdout, stderr);
fixture.docker.listVolumes = async () => ({ Volumes: [], Warnings: [] });
fixture.docker.listImages = async () => [];
fixture.docker.version = async () => ({ Version: 'fixture-synthetic', Os: 'linux', Arch: 'amd64' });
fixture.docker.pull = neverExecute;
fixture.docker.listNetworks = async ({ filters } = {}) => {
  const networks = (await originalNetworks()).map((network) => ({
    ...network,
    Labels: { 'com.docker.compose.project': 'projet-1', 'com.docker.compose.network': 'default' },
  }));
  return networks.filter(
    (network) =>
      !filters?.label ||
      filters.label.every((entry) => {
        const [key, value] = entry.split('=');
        return network.Labels[key] === value;
      }),
  );
};
for (const [id, app] of fixture.apps) {
  app.Names = [`/test-synthetique-${app.Labels['com.docker.compose.service']}`];
  if (app.Labels['com.docker.compose.service'] === 'web')
    app.Ports = [{ PrivatePort: 80, PublicPort: 8088, IP: '127.0.0.1', Type: 'tcp' }];
  const workbench = createWorkbenchDockerFixture({ id, name: app.Names[0].slice(1) });
  workbenches.set(id, workbench);
}
fixture.docker.getContainer = (id) => {
  const base = originalGetContainer(id);
  const app = fixture.apps.get(id);
  if (!app) return base; // Observer and diagnostic helpers also remain in-memory.
  const wb = workbenches.get(id).container;
  return {
    ...base,
    inspect: async () => ({
      ...(await base.inspect()),
      Id: app.Id,
      Name: app.Names[0],
      Config: { Tty: false, Image: app.Image, Labels: app.Labels, Env: ['FIXTURE=synthetic'] },
      NetworkSettings: {
        ...app.NetworkSettings,
        Ports: {
          '80/tcp': app.Ports[0]?.PublicPort
            ? [{ HostIp: '127.0.0.1', HostPort: String(app.Ports[0].PublicPort) }]
            : null,
        },
      },
    }),
    infoArchive: wb.infoArchive.bind(wb),
    getArchive: (options) =>
      /\/(resolv\.conf|hosts)$/.test(options.path)
        ? base.getArchive(options)
        : wb.getArchive(options),
    putArchive: wb.putArchive.bind(wb),
    exec: async (settings) => {
      if (app.Image === 'fixture/no-shell')
        throw Error('TEST SYNTHETIQUE : cette image de scénario ne contient aucun shell.');
      const execution = await wb.exec(settings);
      return {
        ...execution,
        start: async (...args) => {
          const stream = await execution.start(...args);
          rawStreams.add(stream);
          return stream;
        },
      };
    },
  };
};

const app = express();
const clients = new Set();
let service, workspace, server, packetsTimer, closing;
const emit = (event) => {
  for (const client of clients)
    if (!client.writableEnded) client.write(`data: ${JSON.stringify(event)}\n\n`);
};
app.use(express.json({ limit: '5mb' }));
app.use('/api', (req, res, next) => {
  // Host creation and remote access are never available, even in a draft.
  const host = /^\/hosts\/([^/]+)/.exec(req.path)?.[1];
  if (host && host !== 'local')
    return res
      .status(403)
      .json({ error: 'TEST SYNTHETIQUE : seul le faux serveur local est disponible.' });
  const readOnly = ['GET', 'HEAD'].includes(req.method);
  const localContainer = /^\/hosts\/local\/containers\/[a-f0-9]{64}/;
  const allowed =
    readOnly ||
    (req.method === 'POST' &&
      (req.path === '/projects' ||
        /^\/projects\/[^/]+\/refresh$/.test(req.path) ||
        req.path === '/refresh' ||
        req.path === '/hosts/local/test' ||
        req.path === '/hosts/local/captures' ||
        req.path === '/hosts/local/diagnostics' ||
        req.path === '/checks' ||
        /^\/captures\/[^/]+\/stop$/.test(req.path) ||
        (localContainer.test(req.path) &&
          /\/(action|workbench\/upload|workbench\/terminal|workbench\/terminal\/[^/]+\/(?:input|resize))$/.test(
            req.path,
          )))) ||
    (req.method === 'PUT' &&
      (/^\/projects\/[^/]+\/compose\/source$/.test(req.path) ||
        /^\/checks\/[^/]+$/.test(req.path) ||
        (localContainer.test(req.path) && /\/workbench\/file$/.test(req.path)))) ||
    (req.method === 'DELETE' &&
      (/^\/checks\/[^/]+$/.test(req.path) ||
        (localContainer.test(req.path) && /\/workbench\/terminal\/[^/]+$/.test(req.path))));
  if (!allowed)
    return res.status(403).json({
      error:
        'TEST SYNTHETIQUE : déploiement, Compose, téléchargements et changements de serveurs désactivés.',
    });
  if (req.method === 'POST' && req.path === '/projects' && req.body.hostId !== 'local')
    return res.status(403).json({ error: 'TEST SYNTHETIQUE : aucun hôte distant.' });
  next();
});
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  clients.add(res);
  res.write(': TEST SYNTHETIQUE\n\n');
  req.on('close', () => clients.delete(res));
});
// Keep catalogue UI deterministic and offline. These are explicit synthetic
// search results, not a claim that Docker Hub was queried.
app.get('/api/image-catalog/search', (req, res) =>
  res.json({
    results: [
      {
        name: 'nginx',
        repository: 'library/nginx',
        description: 'TEST SYNTHETIQUE — serveur web de démonstration',
        official: true,
        automated: false,
        stars: 0,
        pulls: 0,
      },
      {
        name: 'redis',
        repository: 'library/redis',
        description: 'TEST SYNTHETIQUE — cache de démonstration',
        official: true,
        automated: false,
        stars: 0,
        pulls: 0,
      },
    ].filter((entry) => entry.name.includes(String(req.query.q || '').toLowerCase())),
    page: 1,
    total: 2,
    pageSize: 25,
    source: 'Catalogue synthétique de test',
    hasNext: false,
    cached: false,
    synthetic: true,
  }),
);
app.get('/api/image-catalog/tags', (req, res) =>
  res.json({
    results: [
      {
        tag: 'alpine',
        image: `${req.query.repository || 'nginx'}:alpine`,
        size: 0,
        updatedAt: '',
        platforms: ['linux/amd64'],
      },
    ],
    page: 1,
    total: 1,
    pageSize: 25,
    source: 'Catalogue synthétique de test',
    hasNext: false,
    cached: false,
    synthetic: true,
  }),
);

try {
  workspace = await mountWorkspaceApi(app, {
    dataDir: dir,
    localDocker: fixture.docker,
    emit,
    labBusy: (id) => service?.hostBusy(id) || false,
    projectList: () => service?.list() || [],
  });
  await workspace.store.mutate((store) => {
    store.hosts[0].name = 'TEST SYNTHETIQUE — serveur mémoire';
  });
  // A direct guard complements the HTTP middleware for every caller, including
  // background project refreshes. There is no SSH client path in this fixture.
  workspace.hosts.client = async (hostId) => {
    if (hostId !== 'local') throw Error('TEST SYNTHETIQUE : hôte distant interdit.');
    return fixture.docker;
  };
  service = await createProjectService({ dataDir: dir, workspace, emit });
  await service.store.update(service.store.defaultId, undefined, (record) => {
    record.topology.name = 'TEST SYNTHETIQUE — laboratoire vide';
    record.topology.nodes = [];
    record.topology.edges = [];
  });
  const project = await service.store.create({
    name: 'TEST SYNTHETIQUE — maintenance Compose',
    hostId: 'local',
    compose: {
      projectName: 'projet-1',
      adopt: true,
      source:
        '# TEST SYNTHETIQUE — aucun conteneur reel\nservices:\n  client:\n    image: fixture/no-shell\n  web:\n    image: nginx:alpine\n    ports: ["8088:80"]\n  service-3:\n    image: nginx:alpine\n  service-4:\n    image: nginx:alpine\nnetworks:\n  default:\n    name: net-1\n',
    },
  });
  // Fail before exposing the browser fixture if its Docker contract no longer
  // covers both the legacy landing screen and the maintenance map.
  const initialInventory = await workspace.hosts.inventory('local');
  const initialLegacy = await service.controller(service.store.defaultId).state();
  const initialCompose = await service.controller(project.id).state();
  if (
    initialInventory.containers.length !== 4 ||
    !initialLegacy.runtime.connected ||
    !initialCompose.runtime.connected ||
    Object.keys(initialCompose.runtime.services || {}).length !== 4
  )
    throw Error(
      `Scénario synthétique incomplet : ${initialLegacy.runtime.message || initialCompose.runtime.message || 'inventaire'} `,
    );
  mountProjectApi(app, service);
  app.get('/api/fixture', (_req, res) =>
    res.json({
      synthetic: true,
      projectId: project.id,
      containers: [...fixture.apps.values()].map((c) => ({ id: c.Id, name: c.Names[0].slice(1) })),
    }),
  );
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'Route absente du scénario de test.' }),
  );
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  const html = (await readFile(path.join(dist, 'index.html'), 'utf8')).replace(
    '<body>',
    '<body><div role="note" style="position:fixed;bottom:4px;left:8px;z-index:2147483647;pointer-events:none;padding:5px 9px;border:1px solid #d97706;border-radius:4px;background:#fff7db;color:#713f12;font:11px system-ui">TEST SYNTHÉTIQUE — aucune infrastructure réelle · déploiement désactivé</div>',
  );
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => res.type('html').send(html));
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 400).json({ error: error.message }),
  );

  // Feed observer streams only while the user has explicitly started a fake
  // capture. Every frame carries the synthetic label; no socket is sniffed.
  packetsTimer = setInterval(() => {
    const values = {
      'frame.time_epoch': String(Date.now() / 1000),
      'ip.src': '172.20.0.2',
      'ip.dst': '172.20.0.3',
      'frame.len': '60',
      'frame.protocols': 'eth:ip:tcp',
      'tcp.srcport': '42500',
      'tcp.dstport': '80',
      '_ws.col.Info': 'TEST SYNTHETIQUE — 42500 → 80 [SYN]',
      'tcp.flags': '0x0002',
    };
    const body = Buffer.from(tsharkFields.map((field) => values[field] || '').join('\t') + '\n');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    for (const helper of fixture.helpers.values())
      if (helper.running && helper.options.Labels['io.dockertracer.role'] === 'observer')
        helper.stream.write(Buffer.concat([header, body]));
  }, 1000);
  server = app.listen(4315, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(
    `TEST SYNTHETIQUE → http://127.0.0.1:4315\nDossier temporaire : ${dir}\nProjet : ${project.id}\nAucun Docker réel, aucune commande système, aucun téléchargement. PCAP de fixture sans paquet réel.\nSaisir close pour arrêter et supprimer uniquement ce dossier temporaire.`,
  );
  process.stdin.resume();
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += String(chunk);
    const lines = input.split(/[\r\n]+/);
    input = lines.pop();
    if (lines.some((line) => line.trim() === 'close')) close();
  });
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} catch (error) {
  console.error(error);
  await close(1);
}

async function close(exitCode = 0) {
  if (closing) return closing;
  closing = (async () => {
    clearInterval(packetsTimer);
    process.stdin.pause();
    for (const client of clients) client.end();
    clients.clear();
    await workspace?.shutdown();
    await service?.shutdown();
    for (const workbench of workbenches.values()) workbench.dispose();
    if (server)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    const target = path.resolve(dir);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('dtr-maintenance-ui-'))
      throw Error('Dossier temporaire inattendu : nettoyage refusé.');
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw Error('Dossier temporaire remplacé : nettoyage refusé.');
    await rm(target, { recursive: true, force: true });
    console.log('Fixture synthétique fermée ; son dossier temporaire a été supprimé.');
    process.exit(typeof exitCode === 'number' ? exitCode : 0);
  })();
  return closing;
}
