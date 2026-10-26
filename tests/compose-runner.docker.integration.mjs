import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { docker } from '../server/docker.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createComposeRunner } from '../server/compose-runner.mjs';
import { composeLinuxEndpoint } from './compose-linux.fixture.mjs';
import { shellQuote } from '../server/compose-remote.mjs';
await docker.info();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-compose-runner-')),
  names = [];
let ssh, runner;
try {
  const store = await openWorkspaceStore(dir),
    hosts = new HostRegistry(store, docker);
  runner = createComposeRunner({ dataDir: dir, hosts });
  ssh = await composeLinuxEndpoint(dir, docker);
  const h = await hosts.save(ssh.profile),
    test = await hosts.test(h.id);
  await hosts.trust(h.id, test.fingerprint);
  const context = path.join(dir, 'context');
  await mkdir(context);
  await writeFile(path.join(context, 'page.txt'), 'contenu Compose $littéral');
  await writeFile(
    path.join(context, 'Dockerfile'),
    'FROM alpine:3.23\nCMD ["sleep", "infinity"]\n',
  );
  await ssh.run(
    `printf '%s' 'contenu Compose $littéral' > ${shellQuote(ssh.directory + '/page.txt')}\nprintf 'FROM alpine:3.23\\nCMD ["sleep", "infinity"]\\n' > ${shellQuote(ssh.directory + '/Dockerfile')}\n`,
  );
  for (const hostId of ['local', h.id]) {
    const name = 'dtr-compose-' + Date.now().toString(36);
    names.push(name);
    const source = `services:\n  web:\n    image: nginx:alpine\n    environment:\n      CUSTOM: \${VALUE}\n    configs:\n      - source: page\n        target: /usr/share/nginx/html/index.html\n    healthcheck:\n      test: [CMD, wget, -q, -O, /dev/null, http://127.0.0.1]\n      interval: 1s\n      retries: 10\n  built:\n    build: .\n    image: ${name}-built\n    depends_on:\n      web:\n        condition: service_healthy\n    volumes:\n      - db:/data\nconfigs:\n  page:\n    file: ./page.txt\nvolumes:\n  db: {}\n`;
    const settings = {
      source,
      directory: hostId === 'local' ? context : ssh.directory,
      projectName: name,
      variables: { VALUE: "défini explicitement '$HOME `false` $(false)" },
      waitSeconds: 30,
    };
    await runner.withProject(settings, hostId, async ({ run }) => {
      const config = JSON.parse((await run(['config', '--format', 'json'], { json: true })).stdout);
      assert.equal(
        config.services.web.environment.CUSTOM,
        settings.variables.VALUE.replaceAll('$', '$$$$'),
      );
      assert.equal(config.services.built.depends_on.web.condition, 'service_healthy');
      await run(['--dry-run', 'up', '-d', '--wait', '--wait-timeout', '30']);
      assert.equal(
        (
          await docker.listContainers({
            all: true,
            filters: { label: ['com.docker.compose.project=' + name] },
          })
        ).length,
        0,
      );
      const up = await run(['up', '-d', '--wait', '--wait-timeout', '30']);
      assert.equal(up.code, 0);
      const cs = await docker.listContainers({
        all: true,
        filters: { label: ['com.docker.compose.project=' + name] },
      });
      assert.equal(cs.length, 2);
      assert.ok(cs.every((c) => c.State === 'running'));
      const configFile = await docker
        .getContainer(cs.find((c) => c.Labels['com.docker.compose.service'] === 'web').Id)
        .inspect();
      assert.ok(configFile.Config.Healthcheck);
      assert.ok(configFile.Config.Env.includes('CUSTOM=' + settings.variables.VALUE));
      assert.ok(
        configFile.Mounts.some((m) => m.Destination === '/usr/share/nginx/html/index.html'),
      );
      const exec = await docker
        .getContainer(configFile.Id)
        .exec({
          Cmd: ['wget', '-qO-', 'http://127.0.0.1'],
          AttachStdout: true,
          AttachStderr: true,
        });
      const stream = await exec.start({}),
        chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.match(Buffer.concat(chunks).toString(), /contenu Compose \$littéral/);
      await run(['down']);
      assert.equal(
        (
          await docker.listContainers({
            all: true,
            filters: { label: ['com.docker.compose.project=' + name] },
          })
        ).length,
        0,
      );
    });
    console.log(
      hostId +
        ' : Compose config, dry-run sans mutation, build, dépendance healthy, fichier et déploiement : OK.',
    );
  }
} finally {
  await runner?.shutdown();
  await ssh?.close();
  for (const name of names) {
    const filters = { label: ['com.docker.compose.project=' + name] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
    await docker
      .getImage(name + '-built')
      .remove()
      .catch((e) => {
        if (e.statusCode !== 404) throw e;
      });
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-compose-runner-'))
    throw Error('Unexpected test directory');
  await rm(dir, { recursive: true, force: true });
  console.log('Projets Compose, images construites et fichiers de test nettoyés.');
}
