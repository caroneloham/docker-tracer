import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { checkSchema, resolveResource, resourceRef } from '../shared/workspace.mjs';
import {
  TOOL_IMAGE,
  ensureToolImage,
  execTool,
  archiveFile,
  resolverContext,
  observerLabels,
  removeHelper,
} from './engine-tools.mjs';

export function conclude(steps) {
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'inconclusive')) return 'inconclusive';
  return 'passed';
}
export function explain(steps) {
  const dns = steps.find((s) => s.kind === 'dns'),
    tcp = steps.find((s) => s.kind === 'tcp');
  if (dns?.status === 'failed' && tcp?.status === 'passed')
    return 'Le nom ne se résout pas, mais la connexion par adresse réussit. Vérifie le nom et les alias DNS utilisés.';
  if (steps.some((s) => s.kind === 'state' && s.status === 'failed'))
    return 'Un conteneur requis est arrêté. Consulte son état et ses logs avant de le démarrer.';
  const issue =
    steps.find((s) => s.status === 'failed') || steps.find((s) => s.status === 'inconclusive');
  return issue ? issue.message : 'Les vérifications demandées réussissent depuis la sonde réseau.';
}
export class Diagnostics {
  constructor(store, hosts, captures, emit) {
    this.store = store;
    this.hosts = hosts;
    this.captures = captures;
    this.emit = emit;
    this.active = new Map();
    this.tasks = new Set();
    this.closing = false;
  }
  async save(input) {
    const c = checkSchema.parse({ ...input, id: input.id || `check-${randomUUID()}` });
    for (const side of ['source', 'target']) {
      const inv = await this.hosts.inventory(c[side].hostId);
      const target = resolveResource(c[side], inv);
      if (target.isProbe) throw Error('Sélectionne un conteneur applicatif, pas une sonde.');
      c[side] = resourceRef(c[side].hostId, target);
    }
    await this.store.mutate((s) => {
      if (s.checks.length >= 200 && !s.checks.some((x) => x.id === c.id))
        throw Error('Maximum de 200 contrôles.');
      s.checks = [...s.checks.filter((x) => x.id !== c.id), c];
    });
    return c;
  }
  async start(checkId, capture = false) {
    if (this.closing) throw Error('Le serveur est en cours d’arrêt.');
    const check = this.store.read().checks.find((c) => c.id === checkId);
    if (!check) throw Object.assign(Error('Contrôle inconnu.'), { statusCode: 404 });
    if (this.active.has(check.source.hostId) || this.active.has(check.target.hostId))
      throw Object.assign(Error('Un diagnostic utilise déjà cet hôte.'), { statusCode: 409 });
    const run = {
      id: `run-${randomUUID()}`,
      checkId,
      check,
      hostId: check.source.hostId,
      status: 'running',
      startedAt: Date.now(),
      steps: [],
      summary: 'Diagnostic en cours…',
      previousRunId:
        this.store.read().runs.find((r) => r.checkId === checkId && r.status !== 'running')?.id ||
        null,
    };
    this.active.set(check.source.hostId, run.id);
    this.active.set(check.target.hostId, run.id);
    try {
      await this.store.mutate((s) => {
        s.runs.unshift(run);
      });
    } catch (e) {
      this.active.delete(check.source.hostId);
      this.active.delete(check.target.hostId);
      throw e;
    }
    const task = this.execute(run, capture).catch((e) =>
      this.emit({ type: 'workspace-error', message: e.message, hostId: run.hostId, runId: run.id }),
    );
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
    return run;
  }
  async update(run) {
    await this.store.mutate((s) => {
      const i = s.runs.findIndex((r) => r.id === run.id);
      if (i >= 0) s.runs[i] = structuredClone(run);
    });
    this.emit({ type: 'diagnostic', hostId: run.hostId, runId: run.id, run: structuredClone(run) });
  }
  async execute(run, withCapture) {
    const c = run.check;
    let helper, captureId;
    const step = async (kind, status, message, evidence = {}) => {
      run.steps.push({ kind, status, message, evidence, observedAt: Date.now() });
      await this.update(run);
    };
    try {
      this.hosts.clearInventory(c.source.hostId);
      this.hosts.clearInventory(c.target.hostId);
      const sourceInv = await this.hosts.inventory(c.source.hostId),
        targetInv =
          c.source.hostId === c.target.hostId
            ? sourceInv
            : await this.hosts.inventory(c.target.hostId);
      const source = resolveResource(c.source, sourceInv),
        target = resolveResource(c.target, targetInv);
      run.source = resourceRef(c.source.hostId, source);
      run.target = resourceRef(c.target.hostId, target);
      const docker = await this.hosts.client(c.source.hostId),
        targetDocker = await this.hosts.client(c.target.hostId);
      const sourceInfo = await docker.getContainer(source.id).inspect(),
        targetInfo = await targetDocker.getContainer(target.id).inspect();
      await step(
        'state',
        sourceInfo.State.Running && targetInfo.State.Running ? 'passed' : 'failed',
        sourceInfo.State.Running && targetInfo.State.Running
          ? 'Les deux conteneurs sont démarrés.'
          : 'La source ou la destination est arrêtée.',
        {
          source: source.name,
          target: target.name,
          sourceState: sourceInfo.State.Status,
          targetState: targetInfo.State.Status,
          sourceHealth: sourceInfo.State.Health?.Status,
          targetHealth: targetInfo.State.Health?.Status,
        },
      );
      if (!sourceInfo.State.Running || !targetInfo.State.Running) return;
      const common =
        c.source.hostId === c.target.hostId
          ? target.attachments.filter((a) =>
              source.attachments.some((b) => b.networkId === a.networkId),
            )
          : [];
      await step(
        'network',
        'info',
        common.length
          ? 'Un réseau Docker commun est configuré ; son existence ne prouve pas la communication.'
          : 'Aucun réseau Docker commun identifié. Une adresse routée ou un port publié peut fournir un autre chemin.',
        {
          networks: common.map((a) => sourceInv.networks.find((n) => n.id === a.networkId)?.name),
          sourceAddresses: source.attachments.map((a) => a.ip || a.ipv6),
          targetAddresses: target.attachments.map((a) => a.ip || a.ipv6),
        },
      );
      if (withCapture) {
        try {
          const cap = await this.captures.start({
            targets: [run.source, run.target],
            duration: 30,
            ...(c.protocol !== 'ICMP' ? { port: c.port } : {}),
            runId: run.id,
          });
          captureId = cap.id;
          run.captureId = cap.id;
        } catch (e) {
          await step('capture', 'info', `Capture indisponible : ${e.message}`);
        }
      }
      await ensureToolImage(docker);
      helper = await docker.createContainer({
        name: `dtr-diag-${run.id.slice(4)}`,
        Image: TOOL_IMAGE,
        Entrypoint: ['sleep'],
        Cmd: ['90'],
        Labels: observerLabels(
          'diagnostic',
          run.id,
          c.source.hostId,
          this.store.read((s) => s.instanceId),
        ),
        HostConfig: {
          NetworkMode: `container:${source.id}`,
          CapDrop: ['ALL'],
          CapAdd: ['NET_RAW'],
          Memory: 192 * 1048576,
          NanoCpus: 500000000,
          PidsLimit: 64,
        },
      });
      await helper.start();
      let resolver, resolverError;
      try {
        resolver = resolverContext(
          (await archiveFile(docker.getContainer(source.id), '/etc/resolv.conf')).toString(),
          (await archiveFile(docker.getContainer(source.id), '/etc/hosts')).toString(),
        );
      } catch (e) {
        resolverError = e.message;
        resolver = { servers: [], search: [], hosts: [] };
      }
      const name = c.hostname;
      let resolved = '';
      if (name) {
        const local = resolver.hosts.find((h) => h.names.includes(name));
        const evidence = { name, servers: resolver.servers, search: resolver.search, attempts: [] };
        if (local) resolved = local.ip;
        else if (!resolver.servers.length)
          await step('dns', 'inconclusive', 'La configuration DNS de la source est indisponible.', {
            error: resolverError,
          });
        else {
          const names = [name, ...resolver.search.map((s) => `${name}.${s}`)].slice(0, 4);
          for (const candidate of names) {
            for (const server of resolver.servers) {
              for (const type of ['A', 'AAAA']) {
                const result = await execTool(docker, helper, [
                  'dig',
                  `@${server}`,
                  '+time=1',
                  '+tries=1',
                  '+short',
                  candidate,
                  type,
                ]);
                evidence.attempts.push({ name: candidate, type, ...result });
                resolved = result.stdout.split(/\s+/).find((v) => isIP(v)) || '';
                if (resolved) break;
              }
              if (resolved) break;
            }
            if (resolved) break;
          }
        }
        if (local || resolver.servers.length)
          await step(
            'dns',
            resolved ? 'passed' : 'failed',
            resolved
              ? `${name} est résolu en ${resolved}.`
              : `${name} ne fournit aucune adresse depuis le résolveur de la source.`,
            { ...evidence, address: resolved, hostsFile: !!local },
          );
      }
      const address =
        c.address ||
        resolved ||
        common[0]?.ip ||
        common[0]?.ipv6 ||
        (c.source.hostId === c.target.hostId
          ? target.attachments[0]?.ip || target.attachments[0]?.ipv6
          : '');
      if (!address) {
        await step(
          'target',
          'inconclusive',
          'Aucune adresse testable. Renseigne une adresse accessible depuis la source.',
        );
        return;
      }
      if (c.protocol === 'ICMP') {
        const result = await execTool(docker, helper, [
          'ping',
          '-c',
          '2',
          '-W',
          '2',
          '-w',
          '5',
          address,
        ]);
        await step(
          'icmp',
          result.exitCode === 0 ? 'passed' : 'failed',
          result.exitCode === 0
            ? 'Réponse ICMP reçue.'
            : 'Aucune réponse ICMP satisfaisante. Un filtrage ICMP reste possible.',
          { address, ...result },
        );
      } else {
        const result = await execTool(docker, helper, [
          'nc',
          '-z',
          '-v',
          '-w',
          '3',
          address,
          String(c.port),
        ]);
        await step(
          'tcp',
          result.exitCode === 0 ? 'passed' : 'failed',
          result.exitCode === 0
            ? `Connexion TCP réussie sur ${address}:${c.port}. L’authentification applicative n’est pas testée.`
            : `Connexion TCP en échec sur ${address}:${c.port}.`,
          { address, port: c.port, fallbackByIp: !!name && !resolved, ...result },
        );
        if (result.exitCode === 0 && ['HTTP', 'HTTPS'].includes(c.protocol)) {
          const urlHost = name || (isIP(address) === 6 ? `[${address}]` : address);
          const url = `${c.protocol.toLowerCase()}://${urlHost}:${c.port}${c.path}`;
          const response = await execTool(docker, helper, [
            'curl',
            '--noproxy',
            '*',
            '--connect-timeout',
            '3',
            '--max-time',
            '8',
            '-sS',
            '-o',
            '/dev/null',
            '-w',
            '%{http_code}\n%{time_total}',
            ...(name
              ? ['--resolve', `${name}:${c.port}:${isIP(address) === 6 ? `[${address}]` : address}`]
              : []),
            url,
          ]);
          const code = Number(response.stdout.split('\n')[0]);
          await step(
            c.protocol === 'HTTPS' && response.exitCode === 60 ? 'tls' : 'http',
            response.exitCode === 0 && code === c.expectedStatus ? 'passed' : 'failed',
            response.exitCode === 60
              ? 'Le certificat TLS ne peut pas être validé par la sonde.'
              : response.exitCode
                ? 'La requête HTTP n’a pas abouti.'
                : `Réponse HTTP ${code} ; statut attendu ${c.expectedStatus}.`,
            { url, code, ...response },
          );
        }
      }
      run.context =
        'Sonde temporaire dans l’espace réseau de la source. DNS issu de ses fichiers hosts/resolv.conf ; bibliothèque de résolution, proxy, certificats et identifiants propres à l’application non reproduits.';
      if (
        !common.length &&
        c.source.hostId === c.target.hostId &&
        source.projectKey.startsWith('compose:') &&
        target.projectKey === source.projectKey
      ) {
        run.suggestion = {
          title: 'Vérifier les réseaux du projet Compose',
          text: `Dans le fichier Compose du projet ${source.project}, vérifie que les services ${source.service || source.name} et ${target.service || target.name} rejoignent le réseau prévu et que l’alias ${name || target.service || target.name} est déclaré. Fusionne cette modification avec les réseaux existants. Aucune modification n’a été appliquée.`,
          services: [source.service, target.service],
        };
      }
    } catch (e) {
      await step(
        'observer',
        'inconclusive',
        'Le diagnostic n’a pas pu terminer ses observations.',
        { error: e.message },
      );
    } finally {
      try {
        if (helper) {
          const error = await removeHelper(helper);
          if (error)
            await step(
              'cleanup',
              'inconclusive',
              'La sonde doit être nettoyée après reconnexion.',
              { error },
            );
        }
        if (captureId)
          try {
            await this.captures.stop(captureId);
          } catch (e) {
            run.captureError = e.message;
          }
        run.status = conclude(run.steps);
        run.finishedAt = Date.now();
        run.summary = explain(run.steps);
        await this.update(run);
      } finally {
        this.active.delete(c.source.hostId);
        this.active.delete(c.target.hostId);
      }
    }
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.tasks]);
  }
}
