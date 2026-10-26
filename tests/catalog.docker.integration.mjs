import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { docker } from '../server/docker.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createComposeRunner } from '../server/compose-runner.mjs';
import { catalog, buildCatalogProject, generateCatalogPassword } from '../shared/catalog.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-catalog-test-')),
  names = [];
let runner;
async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await new Promise((r, reject) => {
    s.once('listening', r);
    s.once('error', reject);
  });
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function command(id, Cmd, Env = []) {
  const exec = await docker
    .getContainer(id)
    .exec({ Cmd, Env, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({}),
    chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal((await exec.inspect()).ExitCode, 0, 'Commande de vérification en échec');
  return Buffer.concat(chunks).toString();
}
async function page(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return { url: r.url, text: await r.text() };
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('Aucune réponse HTTP réussie sur le port de test');
}
try {
  await docker.info();
  const hosts = new HostRegistry(await openWorkspaceStore(dir), docker);
  runner = createComposeRunner({ dataDir: dir, hosts });
  for (const item of catalog) {
    const projectName = 'dtr-catalog-' + item.id + '-' + Date.now().toString(36),
      port = await freePort();
    names.push(projectName);
    const password = generateCatalogPassword() + "'$x `z`",
      rootPassword = generateCatalogPassword();
    const p = buildCatalogProject({
      templateId: item.id,
      name: 'Catalogue $littéral ' + item.id,
      hostId: 'local',
      projectName,
      port,
      password,
      rootPassword,
    });
    await runner.withProject(p.compose, 'local', async ({ run }) => {
      await run(['config', '--quiet']);
      console.log(item.name + ' : installation réelle…');
      await run(['up', '-d', '--wait', '--wait-timeout', '180']);
      const filters = { label: ['com.docker.compose.project=' + projectName] };
      const cs = await docker.listContainers({ all: true, filters });
      assert.equal(cs.length, item.services);
      const id = (service) => cs.find((c) => c.Labels['com.docker.compose.service'] === service).Id;
      for (const c of cs) {
        const state = await docker.getContainer(c.Id).inspect();
        assert.equal(state.State.Running, true);
        if (state.State.Health) assert.equal(state.State.Health.Status, 'healthy');
        for (const bindings of Object.values(state.NetworkSettings.Ports))
          for (const b of bindings || []) assert.equal(b.HostIp, '127.0.0.1');
      }
      if (item.id === 'postgres') {
        assert.match(
          await command(
            id('database'),
            [
              'psql',
              '-h',
              '127.0.0.1',
              '-U',
              'app',
              '-d',
              'application',
              '-Atc',
              "CREATE TABLE catalog_test (value text); INSERT INTO catalog_test VALUES ('persisted'); SELECT value FROM catalog_test;",
            ],
            ['PGPASSWORD=' + password],
          ),
          /persisted/,
        );
      } else if (item.id === 'redis') {
        assert.match(await command(id('cache'), ['redis-cli', 'ping']), /NOAUTH/);
        assert.match(
          await command(
            id('cache'),
            ['redis-cli', 'SET', 'catalog-test', 'persisted'],
            ['REDISCLI_AUTH=' + password],
          ),
          /OK/,
        );
      } else {
        const r = await page(port);
        if (item.id === 'nginx') assert.match(r.text, /Catalogue \$littéral nginx/);
        if (item.id === 'wordpress') {
          assert.match(r.url, /wp-admin\/install.php/);
          assert.match(r.text, /WordPress/);
        }
        if (item.id === 'uptime-kuma') assert.match(r.text, /Uptime Kuma/);
        if (item.id === 'custom') assert.match(r.text, /Welcome to nginx/);
      }
      if (['redis', 'postgres'].includes(item.id)) {
        await run(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60']);
        const after = await docker.listContainers({ all: true, filters }),
          nextId = after[0].Id;
        assert.notEqual(nextId, cs[0].Id);
        const result =
          item.id === 'redis'
            ? await command(
                nextId,
                ['redis-cli', 'GET', 'catalog-test'],
                ['REDISCLI_AUTH=' + password],
              )
            : await command(
                nextId,
                [
                  'psql',
                  '-h',
                  '127.0.0.1',
                  '-U',
                  'app',
                  '-d',
                  'application',
                  '-Atc',
                  'SELECT value FROM catalog_test;',
                ],
                ['PGPASSWORD=' + password],
              );
        assert.match(result, /persisted/);
      }
      await run(['down']);
      assert.equal((await docker.listContainers({ all: true, filters })).length, 0);
      if (item.password || item.id === 'uptime-kuma')
        assert.ok((await docker.listVolumes({ filters })).Volumes.length > 0);
      console.log(item.name + ' : démarrage, accès applicatif et conservation des volumes OK.');
    });
  }
} finally {
  await runner?.shutdown();
  for (const name of names) {
    const filters = { label: ['com.docker.compose.project=' + name] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-catalog-test-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Ressources propres aux tests du catalogue nettoyées.');
}
