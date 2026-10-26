// Browser validation on real, isolated Docker resources; never uses the user's lab.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialTopology, LABEL } from '../shared/model.mjs';
import { docker, deploy } from '../server/docker.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-lab-ui-'));
const topology = initialTopology();
topology.id = `ui-${Date.now().toString(36)}`;
topology.name = 'Atelier de validation isolé';
await writeFile(path.join(dir, 'topology.json'), JSON.stringify(topology));
const filters = { label: [`${LABEL}.project=${topology.id}`] };
let child,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  for (const c of await docker.listContainers({ all: true, filters }))
    await docker.getContainer(c.Id).remove({ force: true, v: false });
  for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
  for (const v of (await docker.listVolumes({ filters })).Volumes || [])
    await docker.getVolume(v.Name).remove();
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-lab-ui-'))
    throw Error('Chemin de test inattendu');
  await rm(dir, { recursive: true, force: true });
  console.log('Atelier isolé nettoyé.');
  process.exit(0);
}
try {
  await deploy(topology, console.log);
  child = spawn(process.execPath, ['server/index.mjs', '--production'], {
    env: { ...process.env, PORT: '4313', DTR_DATA_DIR: dir },
    windowsHide: true,
    stdio: 'inherit',
  });
  console.log(`Validation réelle : ${topology.id} · ${dir}`);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} catch (e) {
  console.error(e);
  await close();
}
