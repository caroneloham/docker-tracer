import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import YAML from 'yaml';
import { docker, deploy, ensureImage, resources, execute } from '../server/docker.mjs';
import { createLabEditor } from '../server/lab-editor.mjs';
import { installConfiguration } from '../server/configuration.mjs';
import { archiveFile } from '../server/engine-tools.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { dockerSshEndpoint } from './docker-ssh.fixture.mjs';
import { LABEL, newNode, topologySchema, composeObject } from '../shared/model.mjs';
import { configureProxy } from '../shared/proxy.mjs';

await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-files-'));
const ids = [],
  extra = [],
  composeFiles = [];
let ssh;
const freePort = async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
};
const http = async (port, body) => {
  const end = Date.now() + 25000;
  let observed;
  do {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/', {
        signal: AbortSignal.timeout(2000),
      });
      observed = { status: r.status, body: await r.text() };
      if (r.status === 200 && observed.body === body) return;
    } catch (e) {
      observed = e.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < end);
  assert.fail('HTTP attendu non reçu : ' + JSON.stringify(observed));
};
const cli = promisify(execFile);
const compose = (f, args) =>
  cli('docker', ['compose', '-f', f, ...args], { windowsHide: true, timeout: 90000 });
async function scenario(engine, mode) {
  const id = 'files-' + mode + '-' + Date.now().toString(36),
    port = await freePort();
  ids.push(id);
  let t = {
    id,
    name: 'Application avec proxy',
    nodes: [
      newNode('nginx', 'proxy', { x: 0, y: 0 }, 'proxy'),
      newNode('nginx', 'web', { x: 200, y: 0 }, 'web'),
      newNode('client', 'client', { x: 0, y: 200 }, 'client'),
      newNode('network', 'front', { x: 200, y: 200 }, 'front'),
    ],
    edges: ['web', 'client'].map((source) => ({
      id: source + '-front',
      source,
      target: 'front',
      type: 'traffic',
    })),
  };
  const body = 'été — ' + mode + ' $host $' + '{VALUE}\n';
  t.nodes[1].data.files = [
    { path: '/usr/share/nginx/html/index.html', content: body },
    { path: '/etc/docker-tracer/nested/info.txt', content: body },
  ];
  t.nodes[0].data.ports = [{ host: port, container: 80, protocol: 'tcp' }];
  t.nodes[2].data.volume = '/data';
  t = topologySchema.parse(
    configureProxy(t, 'proxy', { targetId: 'web', networkId: 'front', port: 80, listenPort: 80 }),
  );
  const find = async (id) => {
    const r = await resources(t, engine);
    return engine.getContainer(r.containers.find((c) => c.Labels[LABEL + '.node'] === id).Id);
  };
  const config = {
    engine,
    readTopology: () => t,
    persist: async (n) => {
      await writeFile(path.join(dir, id + '.json'), JSON.stringify(n));
      t = n;
    },
    ensureImage: (i, notify) => ensureImage(i, notify, engine),
    stopCapture: async () => {},
    notify: () => {},
  };
  await deploy(t, () => {}, engine);
  await http(port, body);
  const web = await find('web'),
    proxy = await find('proxy'),
    proxyInfo = await proxy.inspect();
  assert.equal(
    (await archiveFile(web, '/etc/docker-tracer/nested/info.txt')).toString('utf8'),
    body,
  );
  const editor = createLabEditor(config),
    next = structuredClone(t);
  next.nodes[1].data.files[0].content = body + 'modifié\n';
  const plan = await editor.preview(next);
  assert.deepEqual(
    plan.changes.map((c) => c.id),
    ['web'],
  );
  await editor.apply(plan.token);
  await http(port, body + 'modifié\n');
  assert.equal((await find('proxy')).id, proxy.id);
  assert.equal((await proxy.inspect()).State.StartedAt, proxyInfo.State.StartedAt);
  const stable = await find('web');
  const failing = new Proxy(engine, {
    get(target, key) {
      if (key === 'createContainer')
        return async (options) => {
          const c = await target.createContainer(options);
          c.putArchive = async () => {
            throw Error('Transfert de fichier interrompu volontairement');
          };
          return c;
        };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  const failingEditor = createLabEditor({ ...config, engine: failing }),
    broken = structuredClone(t);
  broken.nodes[1].data.files[0].content = 'ne doit pas remplacer la version stable';
  const failedPlan = await failingEditor.preview(broken);
  await assert.rejects(
    failingEditor.apply(failedPlan.token),
    /anciens conteneurs ont été conservés et restaurés/,
  );
  assert.equal((await find('web')).id, stable.id);
  await http(port, body + 'modifié\n');
  const rename = structuredClone(t);
  rename.nodes[1].data.label = 'website';
  const renamePlan = await editor.preview(rename);
  assert.deepEqual(renamePlan.changes.map((c) => c.id).sort(), ['proxy', 'web']);
  await editor.apply(renamePlan.token);
  await http(port, body + 'modifié\n');
  console.log(
    'PASS ' +
      mode +
      ' : fichiers UTF-8, nouveaux dossiers, proxy HTTP/DNS, mise à jour partielle, transfert interrompu restauré, renommage suivi.',
  );
  if (mode === 'local') {
    const exported = structuredClone(t),
      composePort = await freePort();
    exported.id += '-compose';
    exported.nodes[0].data.ports[0].host = composePort;
    const f = path.join(dir, 'compose.yaml');
    await writeFile(f, YAML.stringify(composeObject(exported)));
    composeFiles.push(f);
    await compose(f, ['config', '--quiet']);
    await compose(f, ['up', '-d', '--wait', '--wait-timeout', '45']);
    await http(composePort, body + 'modifié\n');
    console.log(
      'PASS Compose réel : démarrage et HTTP via proxy, dollars et UTF-8 préservés dans les configs exportées.',
    );
  }
}
try {
  await scenario(docker, 'local');
  ssh = await dockerSshEndpoint(dir, docker);
  const hosts = new HostRegistry(await openWorkspaceStore(dir), docker);
  const h = await hosts.save(ssh.profile),
    trust = await hosts.test(h.id);
  assert.equal(trust.state, 'untrusted');
  assert.equal((await hosts.trust(h.id, trust.fingerprint)).state, 'connected');
  await scenario(await hosts.client(h.id), 'ssh');

  const id = 'files-paths-' + Date.now().toString(36);
  ids.push(id);
  const labels = { [LABEL + '.project']: id };
  const volume = id + '-data';
  await docker.createVolume({ Name: volume, Labels: labels });
  const c = await docker.createContainer({
    Image: 'alpine:3.23',
    Cmd: ['sleep', 'infinity'],
    Labels: labels,
    HostConfig: {
      NetworkMode: 'none',
      Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }],
    },
  });
  extra.push(c);
  await c.start();
  // This fixture owns both the container and volume; do not mutate any existing application.
  const e = await c.exec({
    Cmd: [
      '/bin/sh',
      '-c',
      'ln -s /data /alias; printf intact > /data/marker; printf file > /ordinary',
    ],
    AttachStdout: true,
    AttachStderr: true,
  });
  const s = await e.start();
  s.resume();
  await new Promise((r) => s.on('end', r));
  await c.stop({ t: 1 });
  const n = newNode('client', 'test', { x: 0, y: 0 }, 'test');
  const t = { nodes: [n] };
  for (const [file, pattern] of [
    ['/data/marker', /recouvre un volume/],
    ['/alias/marker', /lien symbolique/],
    ['/ordinary/child', /pas un dossier/],
  ]) {
    n.data.files = [{ path: file, content: 'écrasé' }];
    await assert.rejects(installConfiguration(c, t, n), pattern);
  }
  assert.equal((await archiveFile(c, '/data/marker')).toString(), 'intact');
  n.data.files = [
    { path: '/etc/new/directory/info.txt', content: 'copie sans exécution de shell' },
  ];
  await installConfiguration(c, t, n);
  assert.equal((await archiveFile(c, n.data.files[0].path)).toString(), n.data.files[0].content);
  console.log(
    'PASS chemins : volumes, liens symboliques et fichiers parents refusés ; données préservées.',
  );
  const image = 'registry.k8s.io/pause:3.10.1';
  await ensureImage(image, () => {});
  const noShell = await docker.createContainer({
    Image: image,
    Labels: labels,
    HostConfig: { NetworkMode: 'none' },
  });
  await installConfiguration(noShell, t, n);
  assert.equal(
    (await archiveFile(noShell, n.data.files[0].path)).toString(),
    n.data.files[0].content,
  );
  await noShell.start();
  assert.equal((await noShell.inspect()).State.Running, true);
  console.log('PASS image sans shell : transfert par archive Docker, puis démarrage de pause.');
} finally {
  for (const f of composeFiles) await compose(f, ['down', '--volumes', '--remove-orphans']);
  for (const id of ids) {
    const filters = { label: [LABEL + '.project=' + id] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true, v: false });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
    assert.equal((await docker.listContainers({ all: true, filters })).length, 0);
  }
  await ssh?.close();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-files-'))
    throw Error('Chemin de test inattendu');
  await rm(dir, { recursive: true, force: true });
  console.log('Nettoyage des seules ressources de test terminé.');
}
