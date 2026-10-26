import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { docker } from '../server/docker.mjs';
import { HostRegistry } from '../server/hosts.mjs';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { createComposeRunner } from '../server/compose-runner.mjs';
import { patchComposeObject, composeDocument } from '../shared/compose-project.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-network-test-'));
const projectName = 'dtr-network-' + Date.now().toString(36),
  filters = { label: ['com.docker.compose.project=' + projectName] };
let runner;
try {
  const hosts = new HostRegistry(await openWorkspaceStore(dir), docker);
  runner = createComposeRunner({ dataDir: dir, hosts });
  const probe = await docker.createNetwork({
    Name: projectName + '-allocation',
    Driver: 'bridge',
    Labels: { 'com.docker.compose.project': projectName },
  });
  const allocation = (await probe.inspect()).IPAM.Config[0];
  await probe.remove();
  let source =
    'services:\n  web:\n    image: nginx:alpine\n    networks:\n      site:\n        aliases: [website]\n  client:\n    image: alpine:3.23\n    command: [sleep, infinity]\n    networks: [site]\nnetworks:\n  site: {}\n';
  const ipv6 =
    'fd' +
    randomBytes(1).toString('hex') +
    ':' +
    randomBytes(2).toString('hex') +
    ':' +
    randomBytes(2).toString('hex') +
    '::/64';
  const patches = {
    ipam: {
      config: [{ subnet: allocation.Subnet, gateway: allocation.Gateway }, { subnet: ipv6 }],
    },
    enable_ipv6: true,
    driver_opts: {
      'com.docker.network.driver.mtu': '1400',
      'com.docker.network.bridge.enable_icc': 'true',
      'com.docker.network.bridge.enable_ip_masquerade': 'true',
    },
    'x-docker-tracer': { label: 'Site maison', color: '#2475a7', description: 'Pont personnalisé' },
  };
  for (const [field, value] of Object.entries(patches))
    source = patchComposeObject(source, 'networks', 'site', field, value);
  const settings = { source, projectName, waitSeconds: 30 };
  let firstIds;
  await runner.withProject(settings, 'local', async ({ run }) => {
    await run(['up', '-d', '--wait', '--wait-timeout', '30']);
    const cs = await docker.listContainers({ all: true, filters });
    firstIds = cs.map((c) => c.Id).sort();
    const network = (await docker.listNetworks({ filters }))[0];
    assert.equal(network.Options['com.docker.network.driver.mtu'], '1400');
    assert.equal(network.Options['com.docker.network.bridge.enable_icc'], 'true');
    assert.equal(network.EnableIPv6, true);
    assert.ok(network.IPAM.Config.some((p) => p.Subnet === allocation.Subnet));
    const client = docker.getContainer(
      cs.find((c) => c.Labels['com.docker.compose.service'] === 'client').Id,
    );
    assert.ok(
      Object.values((await client.inspect()).NetworkSettings.Networks)[0].GlobalIPv6Address,
    );
    const exec = await client.exec({
        Cmd: ['wget', '-qO-', 'http://website'],
        AttachStdout: true,
        AttachStderr: true,
      }),
      chunks = [];
    for await (const chunk of await exec.start({})) chunks.push(chunk);
    assert.equal((await exec.inspect()).ExitCode, 0);
    assert.match(Buffer.concat(chunks).toString(), /Welcome to nginx/);
  });
  settings.source = patchComposeObject(source, 'networks', 'site', 'x-docker-tracer', {
    label: 'Nouveau nom visuel',
    color: '#398357',
  });
  await runner.withProject(settings, 'local', async ({ run }) => {
    await run(['up', '-d', '--wait']);
    assert.deepEqual(
      (await docker.listContainers({ all: true, filters })).map((c) => c.Id).sort(),
      firstIds,
    );
    assert.equal(
      composeDocument(settings.source).model.networks.site['x-docker-tracer'].label,
      'Nouveau nom visuel',
    );
    await run(['down']);
  });
  console.log(
    'Bridge réel : IPAM, IPv6, MTU, DNS par alias, trafic HTTP et personnalisation visuelle sans remplacement : OK.',
  );
} finally {
  await runner?.shutdown();
  for (const c of await docker.listContainers({ all: true, filters }))
    await docker.getContainer(c.Id).remove({ force: true });
  for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-network-test-'))
    throw Error('Unexpected test path');
  await rm(dir, { recursive: true, force: true });
  console.log('Ressources du test de bridge nettoyées.');
}
