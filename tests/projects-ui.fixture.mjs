import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialTopology, LABEL } from '../shared/model.mjs';
import { docker } from '../server/docker.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-project-ui-')),
  topology = initialTopology();
topology.id = 'ui-' + Date.now().toString(36);
topology.name = 'Atelier UI isolé';
await writeFile(path.join(dir, 'topology.json'), JSON.stringify(topology));
const child = spawn(process.execPath, ['server/index.mjs', '--production'], {
  env: { ...process.env, PORT: '4313', DTR_DATA_DIR: dir },
  windowsHide: true,
  stdio: 'inherit',
});
console.log('Fixture UI projets : ' + dir);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child.kill();
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  const ids = [topology.id];
  for (const name of await readdir(path.join(dir, 'projects')))
    if (name.endsWith('.json'))
      ids.push(JSON.parse(await readFile(path.join(dir, 'projects', name), 'utf8')).id);
  for (const id of new Set(ids)) {
    const filters = { label: [LABEL + '.project=' + id] };
    for (const c of await docker.listContainers({ all: true, filters }))
      await docker.getContainer(c.Id).remove({ force: true, v: false });
    for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove();
    for (const v of (await docker.listVolumes({ filters })).Volumes || [])
      await docker.getVolume(v.Name).remove();
  }
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dtr-project-ui-'))
    throw Error('Unexpected temporary path');
  await rm(dir, { recursive: true, force: true });
  console.log('Fixture UI et tous ses projets nettoyés.');
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('data', (b) => {
  if (String(b).includes('close')) close();
});
process.on('SIGINT', close);
process.on('SIGTERM', close);
