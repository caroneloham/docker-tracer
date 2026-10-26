import { randomUUID, createHash } from 'node:crypto';
import { composeSettings, composeAttention, composeDocument } from '../shared/compose-project.mjs';
import { validateAiDeployment, readAiRootCertificate } from './ai-infrastructure.mjs';
import { readAiSettings } from '../shared/ai-infrastructure.mjs';
import { assertFreshAiRedundancy, retiredAiReplicaContainers } from './ai-redundancy-guard.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = 'com.docker.compose.project';
export function createComposeManager({
  record,
  engine,
  runner,
  persist,
  stopCaptures = async () => {},
  notify = () => {},
}) {
  const plans = new Map();
  async function actual() {
    const r = record(),
      docker = await engine(),
      filters = { label: [label + '=' + r.compose.projectName] };
    const [listed, networks, volumeList] = await Promise.all([
      docker.listContainers({ all: true, filters }),
      docker.listNetworks({ filters }),
      docker.listVolumes({ filters }),
    ]);
    const volumes = volumeList.Volumes || [];
    const containers = await Promise.all(listed.map((c) => docker.getContainer(c.Id).inspect()));
    return {
      containers,
      networks,
      volumes,
      signature: hash({
        containers: containers
          .map((c) => ({
            id: c.Id,
            name: c.Name,
            config: c.Config,
            host: c.HostConfig,
            started: c.State.StartedAt,
            running: c.State.Running,
            paused: c.State.Paused,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        networks: networks
          .map((n) => ({ id: n.Id, options: n.Options, ipam: n.IPAM }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        volumes: volumes
          .map((v) => ({
            name: v.Name,
            created: v.CreatedAt,
            driver: v.Driver,
            options: v.Options,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }),
    };
  }
  const upArgs = (s) => ['up', '--detach', '--wait', '--wait-timeout', String(s.waitSeconds)];
  return {
    actual,
    async aiRootCertificate() {
      const r = record();
      if (
        !r.compose.lastApplied ||
        readAiSettings(r.compose.lastApplied.source)?.tls !== 'internal'
      )
        throw Error('Déploie d’abord le profil IA avec l’autorité locale Caddy.');
      const candidates = (await actual()).containers.filter(
        (c) => c.Config.Labels['com.docker.compose.service'] === 'caddy',
      );
      if (candidates.length !== 1) throw Error('Conteneur Caddy introuvable ou ambigu.');
      return readAiRootCertificate((await engine()).getContainer(candidates[0].Id));
    },
    async state() {
      const r = record();
      try {
        const a = await actual(),
          services = Object.create(null);
        for (const c of a.containers) {
          const name = c.Config.Labels['com.docker.compose.service'];
          (services[name] ||= []).push({
            id: c.Id,
            name: c.Name.replace(/^\//, ''),
            state: c.State.Status,
            health: c.State.Health?.Status,
            image: c.Config.Image,
            ports: Object.entries(c.NetworkSettings.Ports || {}).flatMap(([key, bindings]) => {
              const [container, protocol] = key.split('/');
              return (bindings || []).map((b) => ({
                container: Number(container),
                protocol,
                host: Number(b.HostPort),
                hostIp: b.HostIp,
              }));
            }),
            ips: Object.values(c.NetworkSettings.Networks || {})
              .map((n) => n.IPAddress)
              .filter(Boolean),
          });
        }
        return {
          connected: true,
          deployed: !!(a.containers.length || a.networks.length),
          services,
        };
      } catch (e) {
        return { connected: false, deployed: r.everDeployed, services: {}, message: e.message };
      }
    },
    async preview(input) {
      const settings = composeSettings.parse(input),
        r = record();
      if (settings.projectName !== r.compose.projectName || settings.adopt !== r.compose.adopt)
        throw Error(
          'Le projet Compose cible est immuable. Crée une autre infrastructure pour changer de cible.',
        );
      const before = await actual();
      if (
        !r.everDeployed &&
        !settings.adopt &&
        (before.containers.length || before.networks.length || before.volumes.length)
      )
        throw Error(
          'Des ressources Compose existent déjà sous ce nom. Rattache-les explicitement ou choisis un autre nom.',
        );
      const result = await runner.withProject(settings, r.hostId, async ({ run }) => {
        const config = JSON.parse(
          (await run(['config', '--format', 'json'], { json: true, timeout: 30000 })).stdout,
        );
        await assertFreshAiRedundancy({
          record: r,
          settings,
          config,
          actual: before,
          docker: await engine(),
        });
        await validateAiDeployment(settings, await engine(), { resolvedConfig: config });
        if (Object.keys(config.services || {}).length > 200)
          throw Error('Maximum de 200 services, fichiers inclus compris.');
        try {
          const dry = await run(['--dry-run', ...upArgs(settings)], { timeout: 60000 });
          return { config, output: dry.stdout + '\n' + dry.stderr, dryRunSucceeded: true };
        } catch (e) {
          if (e.inconclusive) throw e;
          // Compose dry-run can inspect a stopped dependency's real health instead of
          // the simulated start. Keep this limitation explicit; never call it a plan success.
          return { config, output: e.output || e.message, dryRunSucceeded: false };
        }
      });
      if ((await actual()).signature !== before.signature)
        throw Error('Docker a changé pendant la préparation. Recrée l’aperçu.');
      for (const [key, p] of plans) if (p.expires < Date.now()) plans.delete(key);
      if (plans.size > 20) plans.delete(plans.keys().next().value);
      const token = randomUUID();
      plans.set(token, {
        settings,
        config: result.config,
        signature: before.signature,
        revision: r.revision,
        expires: Date.now() + 120000,
      });
      return {
        token,
        projectName: settings.projectName,
        hostId: r.hostId,
        output: result.output,
        dryRunSucceeded: result.dryRunSucceeded,
        services: Object.keys(result.config.services || {}),
        attention: composeAttention(result.config, settings.projectName),
        existing: before.containers.map((c) => ({ id: c.Id, name: c.Name, state: c.State.Status })),
        config: result.config,
      };
    },
    async apply(token) {
      const p = plans.get(token);
      plans.delete(token);
      const r = record();
      if (!p || p.expires < Date.now() || p.revision !== r.revision)
        throw Error('L’aperçu a expiré ou le projet a changé.');
      if ((await actual()).signature !== p.signature)
        throw Error('Docker a changé depuis l’aperçu.');
      const currentConfig = await runner.withProject(p.settings, r.hostId, async ({ run }) =>
        JSON.parse(
          (await run(['config', '--format', 'json'], { json: true, timeout: 30000 })).stdout,
        ),
      );
      if (hash(currentConfig) !== hash(p.config))
        throw Error(
          'La configuration résolue a changé depuis l’aperçu (variables ou fichiers inclus). Recrée l’aperçu.',
        );
      await assertFreshAiRedundancy({
        record: r,
        settings: p.settings,
        config: currentConfig,
        actual: await actual(),
        docker: await engine(),
      });
      await validateAiDeployment(p.settings, await engine(), { resolvedConfig: currentConfig });
      const beforeApply = await actual();
      const retired = retiredAiReplicaContainers(r, currentConfig, beforeApply);
      await stopCaptures(beforeApply.containers.map((c) => c.Id));
      // Store intended source before execution: failures can leave a partially updated Compose project.
      await persist({ ...r.compose, ...p.settings, resolved: p.config }, true);
      const result = await runner.withProject(p.settings, r.hostId, ({ run }) =>
        run(upArgs(p.settings), {
          notify,
          // The first AI installation downloads several gigabytes before health checks start.
          // Keep the service readiness deadline separate from the image transfer allowance.
          timeout: readAiSettings(p.settings.source) ? 90 * 60 * 1000 : 15 * 60 * 1000,
        }),
      );
      // Remove only previously generated, named secondary interfaces after the
      // surviving services are ready. Generic Compose orphans remain untouched.
      for (const previous of retired) {
        const container = (await engine()).getContainer(previous.Id);
        let info;
        try { info = await container.inspect(); } catch (error) { if (error.statusCode === 404) continue; throw error; }
        if (info.Config.Labels?.['com.docker.compose.project'] !== r.compose.projectName ||
          info.Config.Labels?.['com.docker.compose.service'] !== previous.Config.Labels['com.docker.compose.service'])
          throw Error('Une ancienne interface a changé de cible. Vérifie son état avant retrait.');
        if (info.State.Running) await container.stop({ t: 30 });
        await container.remove();
      }
      await persist(
        {
          ...record().compose,
          previousApplied: r.compose.lastApplied,
          lastApplied: p.settings,
          resolved: p.config,
        },
        true,
      );
      return {
        ok: true,
        output: result.stdout + '\n' + result.stderr,
        warnings: [
          'Compose ne restaure pas automatiquement les anciens conteneurs en cas d’échec. Les volumes sont conservés.',
        ],
      };
    },
    async save(input) {
      const settings = composeSettings.parse(input),
        r = record();
      composeDocument(settings.source);
      if (settings.projectName !== r.compose.projectName || settings.adopt !== r.compose.adopt)
        throw Error('La cible Compose ne peut pas changer.');
      await persist({ ...r.compose, ...settings, resolved: null }, r.everDeployed);
      return { ok: true };
    },
    async action(action) {
      const r = record(),
        settings = r.compose.lastApplied || r.compose;
      if (!['start', 'stop', 'down'].includes(action)) throw Error('Action Compose inconnue.');
      if (!r.everDeployed && !r.compose.adopt) throw Error('Déploie le projet avant cette action.');
      await stopCaptures((await actual()).containers.map((c) => c.Id));
      const output = await runner.withProject(settings, r.hostId, ({ run }) =>
        run([action, ...(action === 'stop' ? ['--timeout', '30'] : [])], { notify }),
      );
      return { ok: true, output: output.stdout + '\n' + output.stderr };
    },
    async nodeAction(containerId, action) {
      if (!['start', 'stop', 'restart'].includes(action)) throw Error('Action inconnue.');
      const docker = await engine(),
        c = docker.getContainer(containerId),
        info = await c.inspect();
      if (info.Config.Labels?.[label] !== record().compose.projectName)
        throw Error('Ce conteneur n’appartient pas au projet Compose.');
      await stopCaptures([info.Id]);
      await c[action](action === 'start' ? {} : { t: 30 });
      return { ok: true };
    },
    async logs(containerId) {
      const docker = await engine(),
        c = docker.getContainer(containerId),
        info = await c.inspect();
      if (info.Config.Labels?.[label] !== record().compose.projectName)
        throw Error('Conteneur extérieur au projet.');
      const { decodeDockerLog } = await import('./streams.mjs');
      return {
        output: decodeDockerLog(
          await c.logs({ stdout: true, stderr: true, tail: 100, timestamps: true }),
        ).slice(-48000),
      };
    },
  };
}
