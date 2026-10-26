import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { openWorkspaceStore } from './workspace-store.mjs';
import { HostRegistry } from './hosts.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { TargetCaptures } from './target-captures.mjs';
import { containerId, recordId, resolveResource } from '../shared/workspace.mjs';
import { unifiedInventory } from './unified-inventory.mjs';
import { decodeDockerLog } from './docker.mjs';
import { aiHostReport } from './ai-infrastructure.mjs';
import { prepareAiStoragePreview, readAiStoragePreview } from './ai-storage.mjs';
import { mountImageCatalog } from './image-catalog.mjs';
import { mountContainerWorkbench } from './container-workbench.mjs';
import { mountContainerResources } from './container-resources.mjs';

export async function mountWorkspaceApi(
  app,
  {
    dataDir,
    localDocker,
    emit,
    labBusy = () => false,
    guardHost = () => {},
    projectList = () => [],
    storageDependencies,
  },
) {
  const store = await openWorkspaceStore(dataDir),
    hosts = new HostRegistry(store, localDocker),
    captures = new TargetCaptures(store, hosts, emit),
    diagnostics = new Diagnostics(store, hosts, captures, emit);
  const operations = new Set();
  mountImageCatalog(app);
  const workbench = mountContainerWorkbench(app, { hosts, labBusy, emit });
  mountContainerResources(app, { hosts, labBusy, emit });
  await captures.pruneFiles();
  const route =
    (fn, { readOnly = false } = {}) =>
    async (req, res, next) => {
      try {
        if (
          !readOnly &&
          !['GET', 'HEAD'].includes(req.method) &&
          req.params.hostId &&
          labBusy(req.params.hostId)
        )
          throw Object.assign(
            Error('Une modification du laboratoire est en cours. Réessaie après sa fin.'),
            { statusCode: 409 },
          );
        await fn(req, res);
      } catch (e) {
        if (!res.headersSent)
          res.status(e instanceof z.ZodError ? 400 : e.statusCode || 400).json({
            error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join(' ') : e.message,
          });
        else next(e);
      }
    };
  app.get('/api/hosts', (_req, res) => res.json(hosts.list()));
  app.get(
    '/api/hosts/:hostId/ai-readiness',
    route(async (req, res) => {
      const engine = await hosts.client(req.params.hostId);
      res.json(
        await aiHostReport(engine, {
          kind: hosts.profile(req.params.hostId).kind,
          socketPath: engine.modem?.socketPath,
        }),
      );
    }),
  );
  app.post(
    '/api/hosts/:hostId/ai-storage-preview',
    route(
      async (req, res) => {
        const plan = prepareAiStoragePreview(req.body),
          profile = hosts.profile(req.params.hostId),
          engine = await hosts.client(req.params.hostId);
        res.json(
          await readAiStoragePreview(
            plan,
            engine,
            {
              kind: profile.kind,
              socketPath: engine.modem?.socketPath,
            },
            { storageDependencies },
          ),
        );
      },
      { readOnly: true },
    ),
  );
  app.post(
    '/api/hosts',
    route(async (req, res) => {
      if (req.body.id) guardHost(req.body.id, req.body);
      res.json(await hosts.save(req.body));
    }),
  );
  app.put(
    '/api/hosts/:hostId',
    route(async (req, res) => {
      hosts.profile(req.params.hostId);
      guardHost(req.params.hostId, req.body);
      res.json(await hosts.save({ ...req.body, id: req.params.hostId }));
    }),
  );
  app.delete(
    '/api/hosts/:hostId',
    route(async (req, res) => {
      if (
        diagnostics.active.has(req.params.hostId) ||
        captures
          .list()
          .some(
            (c) => c.status === 'running' && c.targets.some((t) => t.hostId === req.params.hostId),
          )
      )
        throw Error('Attends la fin des opérations de cet hôte.');
      guardHost(req.params.hostId, null);
      await hosts.remove(req.params.hostId);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/hosts/:hostId/test',
    route(async (req, res) => res.json(await hosts.test(req.params.hostId))),
  );
  app.post(
    '/api/hosts/:hostId/trust',
    route(async (req, res) =>
      res.json(await hosts.trust(req.params.hostId, z.string().parse(req.body.fingerprint))),
    ),
  );
  app.get(
    '/api/hosts/:hostId/inventory',
    route(async (req, res) => res.json(await hosts.inventory(req.params.hostId))),
  );
  app.get(
    '/api/hosts/:hostId/containers/:id',
    route(async (req, res) =>
      res.json(await hosts.inspect(req.params.hostId, containerId.parse(req.params.id))),
    ),
  );
  app.get(
    '/api/hosts/:hostId/containers/:id/logs',
    route(async (req, res) => {
      const id = containerId.parse(req.params.id);
      await hosts.inspect(req.params.hostId, id);
      const c = (await hosts.client(req.params.hostId)).getContainer(id),
        info = await c.inspect();
      const logs = await c.logs({ stdout: true, stderr: true, tail: 150, timestamps: true });
      res.json({
        output: (info.Config.Tty ? logs.toString() : decodeDockerLog(logs)).slice(-48000),
      });
    }),
  );
  app.post(
    '/api/hosts/:hostId/containers/:id/action',
    route(async (req, res) => {
      const hostId = req.params.hostId,
        id = containerId.parse(req.params.id),
        action = z.enum(['start', 'stop', 'restart']).parse(req.body.action);
      const key = `${hostId}:${id}`;
      if (operations.has(key) || diagnostics.active.has(hostId))
        throw Object.assign(Error('Une opération est déjà en cours sur cet hôte.'), {
          statusCode: 409,
        });
      operations.add(key);
      try {
        const inv = await hosts.inventory(hostId),
          target = inv.containers.find((c) => c.id === id);
        if (!target || target.isProbe) throw Error('Sélectionne un conteneur applicatif connu.');
        if (req.body.expectedName !== target.name)
          throw Error('La cible a changé. Actualise avant d’appliquer cette action.');
        for (const capture of captures
          .list()
          .filter(
            (c) =>
              c.status === 'running' &&
              c.targets.some((t) => t.hostId === hostId && t.containerId === id),
          ))
          await captures.stop(capture.id);
        const c = (await hosts.client(hostId)).getContainer(id);
        await c[action](action === 'start' ? {} : { t: 5 });
        const record = {
          id: randomUUID(),
          hostId,
          containerId: id,
          name: target.name,
          action,
          time: Date.now(),
        };
        await store.mutate((s) => {
          s.actions.push(record);
        });
        hosts.clearInventory(hostId);
        emit({ type: 'workspace-action', ...record });
        const matches = (ref) => {
          if (ref.hostId !== hostId) return false;
          try {
            return resolveResource(ref, inv).id === id;
          } catch {
            return false;
          }
        };
        res.json({
          ...record,
          checks: store.read((s) => s.checks).filter((c) => matches(c.source) || matches(c.target)),
        });
      } finally {
        operations.delete(key);
      }
    }),
  );
  const readInventory = unifiedInventory(hosts);
  let cacheUntil = 0;
  app.get(
    '/api/workspace/inventory',
    route(async (_req, res) => {
      const inventory = await readInventory(),
        state = store.read((s) => ({ checks: s.checks, runs: s.runs }));
      const projectNames = new Map(projectList().map((p) => [p.hostId + ':' + p.id, p.name]));
      for (const c of inventory.containers) {
        const name = projectNames.get(c.hostId + ':' + c.labId);
        if (name) c.project = c.hostName + ' / ' + name;
      }
      res.json({
        ...inventory,
        checks: state.checks,
        runs: state.runs,
        captures: captures.list().map((c) => ({ ...c, packets: undefined })),
      });
    }),
  );
  app.get('/api/checks', (_req, res) => res.json(store.read().checks));
  app.post(
    '/api/checks',
    route(async (req, res) => {
      const c = await diagnostics.save(req.body);
      cacheUntil = 0;
      res.json(c);
    }),
  );
  app.put(
    '/api/checks/:id',
    route(async (req, res) => {
      const c = await diagnostics.save({ ...req.body, id: recordId.parse(req.params.id) });
      cacheUntil = 0;
      res.json(c);
    }),
  );
  app.delete(
    '/api/checks/:id',
    route(async (req, res) => {
      await store.mutate((s) => {
        s.checks = s.checks.filter((c) => c.id !== req.params.id);
      });
      cacheUntil = 0;
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/hosts/:hostId/diagnostics',
    route(async (req, res) => {
      const id = recordId.parse(req.body.checkId),
        c = store.read().checks.find((c) => c.id === id);
      if (c?.source.hostId !== req.params.hostId)
        throw Error('Le contrôle appartient à un autre hôte source.');
      if (
        [c.source.hostId, c.target.hostId].some(
          (id) => labBusy(id) || [...operations].some((key) => key.startsWith(id + ':')),
        )
      )
        throw Object.assign(Error('Une opération est en cours sur un serveur de ce contrôle.'), {
          statusCode: 409,
        });
      res
        .status(202)
        .json(await diagnostics.start(id, z.boolean().default(false).parse(req.body.capture)));
    }),
  );
  app.get('/api/diagnostics', (_req, res) => res.json(store.read().runs));
  app.get(
    '/api/diagnostics/:id',
    route(async (req, res) => {
      const r = store.read().runs.find((r) => r.id === req.params.id);
      if (!r) throw Object.assign(Error('Diagnostic expiré ou inconnu.'), { statusCode: 404 });
      res.json(r);
    }),
  );
  app.post(
    '/api/hosts/:hostId/captures',
    route(async (req, res) => {
      if (req.body.targets?.[0]?.hostId !== req.params.hostId)
        throw Error('Hôte source incorrect.');
      if (req.body.runId)
        throw Error('L’association à un diagnostic est créée par le diagnostic lui-même.');
      if (req.body.targets?.some((t) => labBusy(t.hostId)))
        throw Object.assign(Error('Une modification est en cours sur un serveur ciblé.'), {
          statusCode: 409,
        });
      res.status(201).json(await captures.start(req.body));
    }),
  );
  app.get('/api/captures', (_req, res) =>
    res.json(captures.list().map((c) => ({ ...c, packets: undefined }))),
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
      const f = await captures.file(
        req.params.id,
        z.coerce.number().int().min(0).max(1).parse(req.params.index),
      );
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
      res.type('application/vnd.tcpdump.pcap').send(f.buffer);
    }),
  );
  app.post(
    '/api/hosts/:hostId/recover',
    route(async (req, res) => {
      const hostId = req.params.hostId,
        docker = await hosts.client(hostId),
        s = store.read();
      const interrupted = new Set([
        ...s.runs.filter((r) => r.status !== 'running').map((r) => r.id),
        ...s.captures.filter((c) => c.status !== 'running').map((c) => c.id),
      ]);
      const activeSessions = new Set(
        [...s.runs, ...s.captures].filter((r) => r.status === 'running').map((r) => r.id),
      );
      const helpers = await docker.listContainers({
        all: true,
        filters: { label: ['io.dockertracer.workspace=1', `io.dockertracer.host=${hostId}`] },
      });
      let removed = 0;
      for (const h of helpers) {
        const session = h.Labels['io.dockertracer.session'],
          owner = h.Labels['io.dockertracer.instance'];
        if (
          ['observer', 'diagnostic'].includes(h.Labels['io.dockertracer.role']) &&
          !activeSessions.has(session) &&
          (owner === s.instanceId || (!owner && interrupted.has(session)))
        ) {
          await docker.getContainer(h.Id).remove({ force: true });
          removed++;
        }
      }
      hosts.clearInventory(hostId);
      res.json({ removed });
    }),
  );
  return {
    store,
    hosts,
    diagnostics,
    captures,
    hostBusy: (id) =>
      diagnostics.active.has(id) || [...operations].some((key) => key.startsWith(id + ':')),
    localBusy: () =>
      diagnostics.active.has('local') || [...operations].some((key) => key.startsWith('local:')),
    shutdown: async () => {
      await workbench.shutdown();
      await diagnostics.shutdown();
      await captures.shutdown();
    },
  };
}
