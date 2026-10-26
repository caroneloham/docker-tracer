import { Router } from 'express';
import { z } from 'zod';
import YAML from 'yaml';
import { randomUUID } from 'node:crypto';
import {
  topologySchema,
  deploymentSignature,
  composeObject,
  attachedNetworks,
} from '../shared/model.mjs';
import { probeSchema, probeCommand } from '../shared/probes.mjs';
import { openProjectStore, createProjectSchema } from './project-store.mjs';
import { createLabEditor } from './lab-editor.mjs';
import { openDeploymentStore } from './deployments.mjs';
import { openBackupStore } from './backup-store.mjs';
import { createVolumeManager } from './volumes.mjs';
import { backupId } from '../shared/backups.mjs';
import { createComposeRunner } from './compose-runner.mjs';
import { createComposeManager } from './compose-manager.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import {
  deploy,
  runtime,
  resources,
  ownedContainer,
  ensureImage,
  execute,
  decodeDockerLog,
  labAction,
  CaptureManager,
  friendlyError,
} from './docker.mjs';

const fail = (message, statusCode = 409) => Object.assign(Error(message), { statusCode });
const disconnected = () => ({
  connected: false,
  nodes: {},
  networks: [],
  deployed: false,
  message: 'Lecture du serveur Docker…',
});

export async function createProjectService({ dataDir, workspace, emit }) {
  const store = await openProjectStore(dataDir),
    deployments = await openDeploymentStore(dataDir),
    backups = await openBackupStore(dataDir),
    composeRunner = createComposeRunner({ dataDir, hosts: workspace.hosts }),
    controllers = new Map(),
    locks = new Set();
  const metadata = (record) => {
    let host;
    try {
      const h = workspace.hosts.profile(record.hostId);
      host = { id: h.id, name: h.name, kind: h.kind, address: h.address, username: h.username };
    } catch {
      host = { id: record.hostId, name: 'Serveur introuvable', kind: 'unknown' };
    }
    const controller = controllers.get(record.id);
    const composeModel = record.compose
      ? record.compose.resolved || composeDocument(record.compose.source).model
      : null;
    return {
      kind: record.compose ? 'compose' : 'graph',
      composeProjectName: record.compose?.projectName || null,
      id: record.id,
      name: record.topology.name,
      hostId: record.hostId,
      host,
      revision: record.revision,
      archivedAt: record.archivedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      containers: composeModel
        ? Object.keys(composeModel.services || {}).length
        : record.topology.nodes.filter((n) => n.data.kind === 'container').length,
      networks: composeModel
        ? Object.keys(composeModel.networks || {}).length
        : record.topology.nodes.filter((n) => n.data.kind === 'network').length,
      legacy: record.id === store.defaultId,
      everDeployed: record.everDeployed,
      busy: locks.has(record.hostId),
      capture: controller?.capture?.active || false,
      state: controller?.status.connected
        ? controller.status.deployed
          ? 'deployed'
          : 'draft'
        : controller?.checkedAt
          ? 'offline'
          : 'unknown',
    };
  };
  function controller(id) {
    const hostId = store.get(id).hostId;
    if (controllers.has(id)) return controllers.get(id);
    const c = {
      status: disconnected(),
      checkedAt: 0,
      pending: null,
      capture: null,
      engine: null,
      editor: null,
      journal: [],
    };
    const record = () => store.get(id);
    c.emit = (event) => {
      const full = { ...event, projectId: id, hostId };
      if (event.type !== 'packet') {
        c.journal.push({ ...full, time: Date.now() });
        c.journal = c.journal.slice(-100);
      }
      emit(full);
    };
    c.getEngine = async () => {
      const engine = await workspace.hosts.client(record().hostId);
      if (engine !== c.engine) {
        if (c.capture?.active)
          throw fail('Arrête la capture de ce projet avant de rétablir sa connexion.');
        c.engine = engine;
        c.capture = new CaptureManager(c.emit, engine);
        c.editor = createLabEditor({
          engine,
          readTopology: () => record().topology,
          persist: async (topology) =>
            store.update(id, undefined, (r) => {
              r.topology = topology;
            }),
          ensureImage: (image, notify) => ensureImage(image, notify, engine),
          stopCapture: async (ids) => c.stopCaptures(ids),
          notify: (message) => c.emit({ type: 'notice', message }),
        });
      }
      return engine;
    };
    c.stopCaptures = async (ids) => {
      await c.capture?.stop(record().topology);
      const hostId = record().hostId;
      for (const session of workspace.captures
        .list()
        .filter(
          (s) =>
            s.status === 'running' &&
            s.targets.some((t) => t.hostId === hostId && ids.includes(t.containerId)),
        ))
        await workspace.captures.stop(session.id);
    };
    c.refresh = async (force = false) => {
      if (c.pending) return c.pending;
      if (!force && (locks.has(record().hostId) || Date.now() - c.checkedAt < 3000)) return;
      c.pending = (async () => {
        try {
          if (record().compose) {
            c.status = await c.compose.state();
            return;
          }
          const engine = await c.getEngine(),
            next = await runtime(record().topology, engine);
          c.capture.addressMap = next.addressMap;
          delete next.addressMap;
          c.status = next;
        } catch (e) {
          c.status = { ...c.status, connected: false, message: friendlyError(e) };
        } finally {
          c.checkedAt = Date.now();
          c.pending = null;
        }
      })();
      return c.pending;
    };
    c.state = async () => {
      await c.refresh();
      return {
        project: metadata(record()),
        compose: record().compose,
        capabilities: {
          applicationFiles: true,
          startupChecks: true,
          advancedBridges: true,
          volumeBackups: true,
          composeProjects: true,
        },
        deployments: deployments.list(id),
        topology: record().topology,
        runtime: c.status,
        capture: c.capture?.active || false,
        busy: locks.has(record().hostId),
        journal: c.journal,
        tests: record().tests,
      };
    };
    c.run = async (expectedRevision, fn) => {
      const r = record();
      if (r.archivedAt) throw fail('Ce projet est archivé. Restaure-le avant de le modifier.');
      if (expectedRevision !== undefined && expectedRevision !== r.revision)
        throw fail('Ce projet a changé dans une autre fenêtre. Recharge-le avant de continuer.');
      if (locks.has(r.hostId) || workspace.hostBusy(r.hostId))
        throw fail('Une opération est déjà en cours sur ce serveur.');
      locks.add(r.hostId);
      c.emit({ type: 'busy', busy: true });
      try {
        return await fn(r);
      } finally {
        await c.refresh(true);
        locks.delete(r.hostId);
        c.emit({ type: 'busy', busy: false });
      }
    };
    c.compose = createComposeManager({
      record,
      engine: c.getEngine,
      runner: composeRunner,
      stopCaptures: c.stopCaptures,
      persist: async (compose, everDeployed) =>
        store.update(id, undefined, (r) => {
          r.compose = compose;
          r.everDeployed = everDeployed;
        }),
      notify: (message) => c.emit({ type: 'notice', message }),
    });
    c.volumes = createVolumeManager({
      record,
      getEngine: c.getEngine,
      editor: () => c.editor,
      backups,
      stopCaptures: c.stopCaptures,
      notify: (message) => c.emit({ type: 'notice', message }),
    });
    controllers.set(id, c);
    return c;
  }
  const service = {
    store,
    deployments,
    backups,
    metadata,
    controller,
    profile: (id) => workspace.hosts.profile(id),
    list: () => store.list().map(metadata),
    hostBusy: (id) => locks.has(id),
    guardHost: (id, next) => {
      if (!store.list().some((r) => r.hostId === id)) return;
      if (!next)
        throw fail(
          'Ce serveur est utilisé par des projets, archives comprises. Garde ce profil pour pouvoir les retrouver.',
        );
      const old = workspace.hosts.profile(id);
      if (
        ['kind', 'address', 'port', 'username', 'auth', 'identityFile'].some(
          (key) => next[key] !== undefined && next[key] !== old[key],
        )
      )
        throw fail(
          'Ce profil est lié à des projets. Crée un autre profil puis duplique le projet pour choisir un autre serveur.',
        );
    },
    shutdown: async () => {
      await composeRunner.shutdown();
      await Promise.allSettled(
        [...controllers].map(([id, c]) => c.capture?.stop(store.get(id).topology)),
      );
    },
  };
  return service;
}

export function mountProjectApi(app, service) {
  const { store, deployments, backups, controller, metadata } = service;
  app.get('/api/projects', (_req, res) =>
    res.json({
      projects: service.list(),
      defaultId: store.defaultId,
      capabilities: {
        composeProjects: true,
        aiInfrastructure: true,
        aiInfrastructureVersion: 2,
        aiStoragePreview: true,
        containerWorkbench: true,
        interactiveTerminal: true,
        terminalShellDiscovery: true,
        containerFileUpload: true,
        containerResources: true,
        imageCatalog: true,
      },
    }),
  );
  app.post('/api/projects', async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    // Creating a drawing does not authenticate or mutate the selected Docker engine.
    service.profile(input.hostId);
    const project = await store.create(input);
    res.status(201).json({ project: metadata(project) });
  });
  app.post('/api/projects/:projectId/archive', async (req, res) => {
    const c = controller(req.params.projectId),
      revision = z.number().int().parse(req.body.revision);
    const result = await c.run(revision, async (r) => {
      if (r.id === store.defaultId) throw fail('Le laboratoire historique reste disponible.');
      if (r.everDeployed) {
        const actual = r.compose
          ? await c.compose.actual()
          : await resources(r.topology, await c.getEngine());
        if (actual.containers.length || actual.networks.length)
          throw fail(
            'Libère le déploiement avant d’archiver ce projet. Ses volumes seront conservés.',
          );
      }
      return store.update(r.id, revision, (next) => {
        next.archivedAt = Date.now();
      });
    });
    res.json({ project: metadata(result) });
  });
  app.post('/api/projects/:projectId/restore', async (req, res) => {
    const r = store.get(req.params.projectId),
      revision = z.number().int().parse(req.body.revision);
    if (service.hostBusy(r.hostId)) throw fail('Attends la fin de l’opération sur ce serveur.');
    res.json({
      project: metadata(
        await store.update(r.id, revision, (next) => {
          next.archivedAt = null;
        }),
      ),
    });
  });
  function routes(prefix, legacy = false) {
    const router = Router({ mergeParams: true });
    router.use((req, _res, next) => {
      req.projectController = controller(legacy ? store.defaultId : req.params.projectId);
      next();
    });
    const mutation = (fn) => async (req, res) => {
      const match = req.get('If-Match');
      if (!legacy && !match)
        throw fail('Recharge le projet avant de le modifier (révision manquante).', 428);
      const revision =
        match === undefined
          ? undefined
          : z.coerce.number().int().min(1).parse(match.replaceAll('"', ''));
      const c = req.projectController;
      const result = await c.run(revision, (r) => fn(c, r, req));
      res.json({
        ...result,
        project: metadata(store.get(legacy ? store.defaultId : req.params.projectId)),
      });
    };
    router.get('/state', async (req, res) => res.json(await req.projectController.state()));
    const composeOnly = (fn) =>
      mutation((c, r, req) => {
        if (!r.compose) throw fail('Ce projet utilise l’éditeur graphique.');
        return fn(c, r, req);
      });
    router.post(
      '/compose/preview',
      composeOnly((c, _r, req) => c.compose.preview(req.body)),
    );
    router.post(
      '/compose/apply',
      composeOnly((c, r, req) =>
        deployments.record(r, 'compose', () => c.compose.apply(backupId.parse(req.body.token))),
      ),
    );
    router.put(
      '/compose/source',
      composeOnly((c, _r, req) => c.compose.save(req.body)),
    );
    router.post(
      '/compose/action',
      composeOnly((c, r, req) =>
        deployments.record(r, 'compose', () =>
          c.compose.action(z.enum(['start', 'stop', 'down']).parse(req.body.action)),
        ),
      ),
    );
    router.post(
      '/compose/nodes/:id/action',
      composeOnly((c, _r, req) =>
        c.compose.nodeAction(
          req.params.id,
          z.enum(['start', 'stop', 'restart']).parse(req.body.action),
        ),
      ),
    );
    router.get('/compose/nodes/:id/logs', async (req, res) => {
      const c = req.projectController,
        s = await c.state();
      if (!s.compose) throw fail('Projet Compose requis.');
      res.json(await c.compose.logs(req.params.id));
    });
    router.get('/compose/ai/root-certificate', async (req, res) => {
      const c = req.projectController,
        s = await c.state();
      if (!s.compose) throw fail('Projet Compose requis.');
      const pem = await c.compose.aiRootCertificate();
      res.setHeader('Content-Disposition', 'attachment; filename="docker-tracer-caddy-root.crt"');
      res.type('application/x-pem-file').send(pem);
    });
    router.get('/compose/source', async (req, res) => {
      const s = await req.projectController.state();
      if (!s.compose) throw fail('Projet Compose requis.');
      res.type('text/yaml').send(s.compose.source);
    });
    router.use(async (req, _res, next) => {
      const r = store.get(legacy ? store.defaultId : req.params.projectId);
      if (r.compose && req.method !== 'GET' && req.path !== '/refresh')
        return next(
          fail(
            'Cette action appartient à l’éditeur graphique. Utilise les actions Compose de ce projet.',
          ),
        );
      next();
    });
    router.get('/volumes', async (req, res) =>
      res.json(await req.projectController.volumes.list()),
    );
    router.get('/backups', (req, res) =>
      res.json(backups.list(legacy ? store.defaultId : req.params.projectId)),
    );
    router.get('/backups/:id/download', (req, res, next) => {
      const b = backups.get(req.params.id, legacy ? store.defaultId : req.params.projectId);
      if (b.status !== 'ready') throw fail('Cette archive n’est pas disponible.');
      res.download(backups.archive(b.id), `docker-tracer-${b.id}.tar`, (error) => {
        if (error) next(error);
      });
    });
    router.post(
      '/backups/preview',
      mutation((c, _r, req) => c.volumes.previewBackup(req.body)),
    );
    router.post(
      '/backups/create',
      mutation((c, _r, req) => c.volumes.backup(backupId.parse(req.body.token))),
    );
    router.post(
      '/backups/:id/restore-preview',
      mutation((c, _r, req) => c.volumes.previewRestore(backupId.parse(req.params.id))),
    );
    router.post(
      '/backups/restore',
      mutation((c, r, req) =>
        deployments.record(r, 'restore', () => c.volumes.restore(backupId.parse(req.body.token))),
      ),
    );
    router.post(
      '/backups/:id/recover',
      mutation((c, _r, req) => c.volumes.recover(backupId.parse(req.params.id))),
    );
    router.delete(
      '/backups/:id',
      mutation((c, _r, req) => c.volumes.remove(backupId.parse(req.params.id))),
    );
    router.post('/refresh', async (req, res) => {
      await req.projectController.refresh(true);
      res.json(req.projectController.status);
    });
    router.put(
      '/topology',
      mutation(async (c, r, req) => {
        const next = topologySchema.parse(req.body);
        if (next.id !== r.id)
          throw fail('L’identifiant du laboratoire ne peut pas être changé.', 400);
        let deployed = r.everDeployed;
        try {
          const actual = await resources(r.topology, await c.getEngine());
          deployed = !!(actual.containers.length || actual.networks.length);
        } catch (e) {
          if (deployed && deploymentSignature(r.topology) !== deploymentSignature(next))
            throw fail('Reconnecte le serveur avant de modifier ce déploiement.');
        }
        if (deployed && deploymentSignature(r.topology) !== deploymentSignature(next))
          throw fail('Vérifie puis applique les changements pour modifier ce déploiement.');
        await store.update(r.id, r.revision, (record) => {
          record.topology = next;
        });
        return { topology: next };
      }),
    );
    router.get('/compose', (req, res) =>
      res
        .type('text/yaml')
        .send(
          YAML.stringify(
            composeObject(store.get(legacy ? store.defaultId : req.params.projectId).topology),
          ),
        ),
    );
    router.post(
      '/deploy',
      mutation(async (c, r) => {
        const engine = await c.getEngine();
        // Persist the possibility of live resources before any Docker mutation.
        await store.update(r.id, r.revision, (next) => {
          next.everDeployed = true;
        });
        const result = await deployments.record(r, 'deploy', () =>
          deploy(r.topology, (message) => c.emit({ type: 'notice', message }), engine),
        );
        return { ok: true, ...result };
      }),
    );
    router.post(
      '/lab/preview',
      mutation(async (c, _r, req) => {
        await c.getEngine();
        return c.editor.preview(req.body);
      }),
    );
    router.post(
      '/lab/apply',
      mutation(async (c, r, req) => {
        await c.getEngine();
        const token = z.string().uuid().parse(req.body.token);
        return deployments.record(r, 'apply', () => c.editor.apply(token));
      }),
    );
    router.post(
      '/lab/action',
      mutation(async (c, r, req) => {
        const action = z.enum(['start', 'stop', 'remove']).parse(req.body.action),
          engine = await c.getEngine();
        const actual = await resources(r.topology, engine);
        await c.stopCaptures(actual.containers.map((c) => c.Id));
        await labAction(r.topology, action, engine);
        if (action === 'remove')
          await store.update(r.id, r.revision, (next) => {
            next.everDeployed = false;
          });
        return { ok: true };
      }),
    );
    router.post(
      '/nodes/:id/action',
      mutation(async (c, r, req) => {
        const action = z.enum(['start', 'stop', 'restart']).parse(req.body.action),
          engine = await c.getEngine(),
          container = await ownedContainer(r.topology, req.params.id, engine);
        await c.stopCaptures([container.id]);
        await container[action](action === 'start' ? {} : { t: 3 });
        return { ok: true };
      }),
    );
    router.get('/nodes/:id/logs', async (req, res) => {
      const c = req.projectController,
        state = await c.state(),
        container = await ownedContainer(state.topology, req.params.id, await c.getEngine());
      const info = await container.inspect(),
        log = await container.logs({ stdout: true, stderr: true, tail: 150, timestamps: true });
      res.json({ output: (info.Config.Tty ? log.toString() : decodeDockerLog(log)).slice(-48000) });
    });
    router.post(
      '/nodes/:id/exec',
      mutation(async (c, r, req) =>
        execute(
          r.topology,
          req.params.id,
          ['/bin/sh', '-lc', z.string().min(1).max(2000).parse(req.body.command)],
          await c.getEngine(),
        ),
      ),
    );
    router.post(
      '/capture',
      mutation(async (c, r, req) => {
        const enabled = z.boolean().parse(req.body.enabled),
          engine = await c.getEngine();
        if (enabled) {
          const state = await runtime(r.topology, engine);
          await c.capture.start(r.topology, state.addressMap);
        } else await c.capture.stop(r.topology);
        return { active: c.capture.active };
      }),
    );
    router.post(
      '/probe',
      mutation(async (c, r, req) => {
        const options = probeSchema.parse(req.body),
          { source, target, protocol } = options,
          t = r.topology,
          engine = await c.getEngine();
        const targetNode = t.nodes.find((n) => n.id === target && n.data.kind === 'container');
        if (!targetNode || source === target)
          throw fail('Choisis deux conteneurs différents.', 400);
        const shared = attachedNetworks(t, source).find((n) =>
          attachedNetworks(t, target).some((other) => other.id === n.id),
        );
        if (!shared) throw fail('Ces conteneurs ne partagent aucun réseau.', 400);
        const info = await (await ownedContainer(t, target, engine)).inspect();
        const ip = info.NetworkSettings.Networks[`dtr-${t.id}-${shared.id}`]?.IPAddress;
        if (!info.State.Running || !ip) throw fail('Le conteneur cible doit être démarré.', 400);
        const startedAt = Date.now(),
          result = await execute(
            t,
            source,
            probeCommand(options, ip, targetNode.data.label),
            engine,
          );
        const record = {
          ...result,
          id: randomUUID(),
          protocol,
          source,
          target,
          ip,
          networkId: shared.id,
          options,
          startedAt,
          finishedAt: Date.now(),
          sourceLabel: t.nodes.find((n) => n.id === source)?.data.label,
          targetLabel: targetNode.data.label,
          summary:
            protocol === 'UDP' && result.exitCode === 0
              ? 'Envoi UDP terminé ; réception non vérifiée.'
              : result.exitCode === 0
                ? 'Test réussi.'
                : 'Test en échec. Consulte la sortie pour le détail.',
        };
        await store.update(r.id, r.revision, (next) => {
          next.tests = [record, ...next.tests].slice(0, 30);
        });
        c.emit({
          type: 'notice',
          message: `${protocol} · ${record.sourceLabel} → ${record.targetLabel} : ${record.summary}`,
        });
        return record;
      }),
    );
    app.use(prefix, router);
  }
  routes('/api/projects/:projectId');
  routes('/api', true);
}
