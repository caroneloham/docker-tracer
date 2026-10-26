import assert from 'node:assert/strict';
import tar from 'tar-stream';
import { docker } from '../server/docker.mjs';
import { execTool } from '../server/engine-tools.mjs';
import { checkStartup } from '../server/startup.mjs';
import { newNode } from '../shared/model.mjs';
const id = 'startup-health-' + Date.now().toString(36),
  tag = id + ':test';
const labels = { 'io.dockertracer.project': id },
  pack = tar.pack();
pack.entry(
  { name: 'Dockerfile' },
  'FROM alpine:3.23\nHEALTHCHECK --interval=1s --timeout=1s --retries=1 CMD test ! -f /tmp/unhealthy\nCMD ["sleep", "infinity"]\n',
);
pack.finalize();
let container;
try {
  const stream = await docker.buildImage(pack, { t: tag, labels });
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())),
  );
  container = await docker.createContainer({
    Image: tag,
    Labels: labels,
    HostConfig: { NetworkMode: 'none' },
  });
  await container.start();
  const n = newNode('custom', 'app', { x: 0, y: 0 }, 'app');
  n.data.startup = { mode: 'health', timeoutSeconds: 5, port: 80, path: '/', expectedStatus: 200 };
  const healthy = await checkStartup(docker, { id }, n, container);
  assert.equal(healthy.status, 'passed', JSON.stringify(healthy));
  await execTool(docker, container, ['touch', '/tmp/unhealthy']);
  const unhealthy = await checkStartup(docker, { id }, n, container);
  assert.equal(unhealthy.status, 'failed', JSON.stringify(unhealthy));
  assert.ok(unhealthy.observations.some((o) => o.state === 'unhealthy'));
  assert.equal((await container.inspect()).State.Running, true);
  console.log(
    'PASS : HEALTHCHECK hérité de l’image réelle, passage healthy → unhealthy malgré un processus toujours en marche.',
  );
} finally {
  if (container) await container.remove({ force: true, v: false });
  try {
    await docker.getImage(tag).remove();
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  console.log('Conteneur et image de validation retirés.');
}
