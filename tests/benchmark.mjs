import os from 'node:os';
import { fixtureEngine } from './fixtures/engine.mjs';
import { buildInventory, inventoryView, layoutInventory } from '../shared/inventory.mjs';
import { qualifyInventory } from '../shared/workspace.mjs';
const f = fixtureEngine(200),
  containers = await f.docker.listContainers(),
  networks = await f.docker.listNetworks();
const samples = [];
for (let i = 0; i < 60; i++) {
  const start = performance.now(),
    inventory = qualifyInventory(buildInventory(containers, networks), {
      id: 'local',
      name: 'Local',
    }),
    view = inventoryView(inventory, {}),
    layout = layoutInventory(view);
  if (layout.size !== 220) throw Error('Perte de nœuds');
  if (i >= 10) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      cpu: os.cpus()[0].model,
      ramGiB: Math.round(os.totalmem() / 2 ** 30),
      node: process.version,
      platform: process.platform,
      containers: 200,
      networks: 20,
      samples: samples.length,
      calculationMedianMs: samples[25],
      calculationP95Ms: samples[47],
      scope:
        'Construction DTO, qualification par hôte, filtrage et placement synthétiques. Exclut découverte réelle, rendu et capture.',
    },
    null,
    2,
  ),
);
