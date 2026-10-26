// Real capture review surface. Every API is restricted to the two containers
// created by maintenance-capture.docker.integration.mjs. No general Docker API.
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifyInventory } from '../../shared/workspace.mjs';
import { execTool } from '../../server/engine-tools.mjs';

export async function serveCaptureUi({ captures, hosts, engine, source, target, setEmit }) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const allowedIds = new Set([source.id, target.id]);
  const clients = new Set();
  const app = express();
  let server, vite, trafficTimer, expiry, pendingTraffic;
  const route = (callback) => async (req, res) => {
    try {
      await callback(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(400).json({ error: error.message });
    }
  };
  const emit = (event) => {
    for (const client of clients)
      if (!client.writableEnded) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Docker-Tracer') !== '1')
      return res.status(403).json({ error: 'En-tête requis.' });
    next();
  });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    res.write(': capture réelle isolée\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  app.get('/api/projects', (_req, res) => res.json({ projects: [] }));
  app.get(
    '/api/workspace/inventory',
    route(async (_req, res) => {
      const raw = await hosts.inventory('local');
      const containers = raw.containers.filter((container) => allowedIds.has(container.id));
      const networkIds = new Set(
        containers.flatMap((container) =>
          container.attachments.map((attachment) => attachment.networkId),
        ),
      );
      const host = {
        ...hosts.list().find((item) => item.id === 'local'),
        name: 'Docker réel, test isolé',
      };
      const snapshot = qualifyInventory(
        {
          ...raw,
          containers,
          networks: raw.networks.filter((network) => networkIds.has(network.id)),
          links: raw.links.filter((link) => allowedIds.has(link.source.slice(2))),
        },
        host,
      );
      res.json({ ...snapshot, hosts: [host], checks: [], runs: [], captures: captures.list() });
    }),
  );
  app.get(
    '/api/hosts/local/containers/:id',
    route(async (req, res) => {
      assert.ok(allowedIds.has(req.params.id), 'Seuls les conteneurs de ce test sont accessibles.');
      res.json(await hosts.inspect('local', req.params.id));
    }),
  );
  app.post(
    '/api/hosts/local/captures',
    route(async (req, res) => {
      assert.ok(
        Array.isArray(req.body.targets) &&
          req.body.targets.length >= 1 &&
          req.body.targets.length <= 2,
      );
      assert.ok(
        req.body.targets.every((ref) => ref.hostId === 'local' && allowedIds.has(ref.containerId)),
        'Capture limitée aux deux conteneurs du test.',
      );
      assert.equal(captures.active.size, 0, 'Une seule capture de test à la fois.');
      res.status(201).json(await captures.start({ targets: req.body.targets, duration: 30 }));
    }),
  );
  app.get(
    '/api/captures/:id',
    route(async (req, res) => res.json(captures.get(req.params.id))),
  );
  app.post(
    '/api/captures/:id/stop',
    route(async (req, res) => res.json(await captures.stop(req.params.id))),
  );
  app.get(
    '/api/captures/:id/files/:index',
    route(async (req, res) => {
      const file = await captures.file(req.params.id, Number(req.params.index));
      res.type('application/vnd.tcpdump.pcap').send(file.buffer);
    }),
  );
  app.use('/api', (_req, res) =>
    res
      .status(403)
      .json({ error: 'Ce test permet uniquement les captures des deux conteneurs isolés.' }),
  );
  const onInput = (data) => {
    if (String(data).trim() === 'close') finish?.();
  };
  let finish;
  try {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
    app.get(
      '/',
      route(async (_req, res) =>
        res
          .type('html')
          .send(
            await vite.transformIndexHtml(
              '/',
              '<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Capture Docker réelle isolée</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/capture-inventory-ui.jsx"></script></body></html>',
            ),
          ),
      ),
    );
    app.use(vite.middlewares);
    setEmit(emit);
    trafficTimer = setInterval(() => {
      if (
        pendingTraffic ||
        ![...captures.active.values()].some((session) => session.record.ready && !session.stopping)
      )
        return;
      pendingTraffic = execTool(engine, source, [
        'wget',
        '-q',
        '-T',
        '2',
        '-O',
        '/dev/null',
        'http://web/',
      ])
        .catch((error) => console.error('Trafic de test interrompu :', error.message))
        .finally(() => {
          pendingTraffic = null;
        });
    }, 850);
    server = app.listen(4317, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    console.log(
      'UI réelle isolée : http://127.0.0.1:4317/ · Lance une capture de 30 s dans la carte. Requêtes HTTP réelles uniquement pendant cette capture. Fermeture automatique dans 2 min, ou saisir close.',
    );
    await new Promise((resolve) => {
      finish = resolve;
      expiry = setTimeout(resolve, 120000);
      process.stdin.on('data', onInput);
      process.stdin.resume();
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    clearInterval(trafficTimer);
    clearTimeout(expiry);
    setEmit(() => {});
    process.stdin.off('data', onInput);
    process.stdin.pause();
    if (finish) {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
    }
    for (const client of clients) client.end();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await pendingTraffic;
    await vite?.close();
  }
}
