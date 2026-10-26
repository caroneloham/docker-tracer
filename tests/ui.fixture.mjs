// Explicit visual test server. Synthetic data lives in a disposable directory.
import express from 'express';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mountWorkspaceApi } from '../server/workspace-api.mjs';
import { fixtureEngine } from './fixtures/engine.mjs';
import { initialTopology } from '../shared/model.mjs';
const app = express();
app.use(express.json());
const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-ui-fixture-')),
  fixture = fixtureEngine(200),
  clients = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
app.get('/api/state', (_req, res) =>
  res.json({
    topology: initialTopology(),
    runtime: { online: false, deployed: false, nodes: {}, networks: [] },
    capture: false,
    busy: false,
    journal: [],
  }),
);
const workspace = await mountWorkspaceApi(app, {
  dataDir: dir,
  localDocker: fixture.docker,
  emit: (e) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
  },
});
const vite = await createServer({
  server: { middlewareMode: true, hmr: { port: 24680 } },
  appType: 'spa',
});
app.use(vite.middlewares);
const server = app.listen(4312, '127.0.0.1', () =>
  console.log('Données synthétiques : http://127.0.0.1:4312'),
);
async function close() {
  await workspace.shutdown();
  for (const c of clients) c.end();
  await vite.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
