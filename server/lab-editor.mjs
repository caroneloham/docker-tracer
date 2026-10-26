import { createHash, randomUUID } from 'node:crypto';
import { LABEL, topologySchema } from '../shared/model.mjs';
import { planLabChanges } from '../shared/lab-changes.mjs';
import { createLabContainer, createLabNetwork, labName } from './lab-config.mjs';
import { prepareStartup, verifyStartup } from './startup.mjs';
import { startupDescription } from '../shared/startup.mjs';
import { bridgeIpam, cidrOverlap } from '../shared/bridge.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const role = `${LABEL}.role`,
  nodeLabel = `${LABEL}.node`;

// Each preview is tied to the saved topology and actual Docker identities/configuration.
export function createLabEditor({
  engine,
  readTopology,
  persist,
  ensureImage,
  stopCapture,
  notify = () => {},
}) {
  const previews = new Map();
  async function inspect(t) {
    const filters = { label: [`${LABEL}.project=${t.id}`] };
    const [cs, ns] = await Promise.all([
      engine.listContainers({ all: true, filters }),
      engine.listNetworks({ filters }),
    ]);
    const containers = await Promise.all(
      cs.filter((c) => c.Labels[role] === 'node').map((c) => engine.getContainer(c.Id).inspect()),
    );
    const networks = await Promise.all(
      ns.filter((n) => n.Labels[role] === 'network').map((n) => engine.getNetwork(n.Id).inspect()),
    );
    for (const n of t.nodes) {
      const list =
        n.data.kind === 'container'
          ? containers.filter((c) => c.Config.Labels[nodeLabel] === n.id)
          : networks.filter((net) => net.Labels[nodeLabel] === n.id);
      if (list.length !== 1)
        throw Error(
          `Déploiement incomplet ou ambigu pour ${n.data.label}. Actualise puis libère le labo si nécessaire.`,
        );
    }
    if (
      containers.length !== t.nodes.filter((n) => n.data.kind === 'container').length ||
      networks.length !== t.nodes.filter((n) => n.data.kind === 'network').length
    )
      throw Error(
        'Des ressources supplémentaires portent les labels du labo. Libère le labo avant de poursuivre.',
      );
    const signature = digest({
      containers: containers
        .map((c) => ({
          id: c.Id,
          name: c.Name,
          config: c.Config,
          host: c.HostConfig,
          running: c.State.Running,
          started: c.State.StartedAt,
          networks: c.NetworkSettings.Networks,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      networks: networks
        .map((n) => ({
          id: n.Id,
          ipam: n.IPAM,
          options: n.Options,
          internal: n.Internal,
          ipv6: n.EnableIPv6,
          containers: n.Containers,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    return { containers, networks, signature };
  }
  return {
    async preview(input) {
      const next = topologySchema.parse(input),
        before = topologySchema.parse(readTopology());
      if (next.id !== before.id)
        throw Error('L’identifiant du laboratoire ne peut pas être changé.');
      const actual = await inspect(before),
        plan = planLabChanges(before, next);
      const removedNetworks = actual.networks.filter((n) =>
        plan.changes.some(
          (c) =>
            ['network-remove', 'network-recreate'].includes(c.kind) && c.id === n.Labels[nodeLabel],
        ),
      );
      for (const change of plan.changes.filter((c) =>
        ['network-remove', 'network-recreate'].includes(c.kind),
      )) {
        const net = actual.networks.find((n) => n.Labels[nodeLabel] === change.id);
        if (
          Object.keys(net.Containers || {}).some(
            (id) => !actual.containers.some((c) => c.Id === id),
          )
        )
          plan.blocked.push(
            `${change.label} contient un équipement extérieur au labo. Déconnecte-le avant de modifier ou retirer le réseau.`,
          );
      }
      const allNetworks = await engine.listNetworks();
      for (const change of plan.changes.filter((c) =>
        ['network-add', 'network-recreate'].includes(c.kind),
      )) {
        const node = next.nodes.find((n) => n.id === change.id);
        for (const other of allNetworks.filter((n) => !removedNetworks.some((r) => r.Id === n.Id)))
          if (
            bridgeIpam(node.data).some((p) =>
              (other.IPAM?.Config || []).some((c) => cidrOverlap(p.subnet, c.Subnet)),
            )
          )
            plan.blocked.push(
              `La plage de ${change.label} recouvre le réseau Docker ${other.Name}. Choisis une autre plage.`,
            );
      }
      const token = randomUUID(),
        expiresAt = Date.now() + 120000;
      const legacy = actual.containers.filter((c) =>
        removedNetworks.some((n) => c.HostConfig.NetworkMode === n.Id),
      );
      let migration;
      if (legacy.length && !plan.blocked.length) {
        const migrationToken = randomUUID(),
          migrationPlan = {
            changes: legacy.map((c) => ({
              id: c.Config.Labels[nodeLabel],
              label: before.nodes.find((n) => n.id === c.Config.Labels[nodeLabel]).data.label,
              kind: 'recreate',
              reason: 'Mise à niveau des connexions réseau',
            })),
            blocked: [],
            unchanged: actual.containers.length - legacy.length,
          };
        previews.set(migrationToken, {
          before,
          next: before,
          signature: actual.signature,
          expiresAt,
          plan: migrationPlan,
        });
        migration = { token: migrationToken, services: migrationPlan.changes.map((c) => c.label) };
        plan.blocked.push(
          'Ces services utilisent une ancienne liaison réseau. Mets-les à niveau avant de remplacer le bridge ; le brouillon sera conservé.',
        );
      }
      previews.set(token, { before, next, signature: actual.signature, expiresAt, plan });
      for (const [key, p] of previews)
        if (p.expiresAt < Date.now() || previews.size > 5) previews.delete(key);
      const startupChecks = plan.changes
        .filter((c) => ['add', 'recreate'].includes(c.kind))
        .map((c) => {
          const node = next.nodes.find((n) => n.id === c.id);
          const old = actual.containers.find((n) => n.Config.Labels[nodeLabel] === c.id);
          return {
            nodeId: c.id,
            label: c.label,
            description: startupDescription(node.data.startup),
            enabled: node.data.startup.mode !== 'none',
            stopped: !!old && !old.State.Running,
          };
        });
      return { ...plan, startupChecks, token, expiresAt, migration };
    },
    async apply(token) {
      const p = previews.get(token);
      previews.delete(token);
      if (!p || p.expiresAt < Date.now())
        throw Error('Cet aperçu a expiré. Vérifie à nouveau les changements.');
      if (p.plan.blocked.length) throw Error(p.plan.blocked.join(' '));
      if (digest(topologySchema.parse(readTopology())) !== digest(p.before))
        throw Error('Le schéma enregistré a changé. Recrée l’aperçu.');
      const actual = await inspect(p.before);
      if (actual.signature !== p.signature)
        throw Error(
          'Docker a changé depuis l’aperçu. Actualise les changements avant de les appliquer.',
        );
      const affected = p.plan.changes.filter((c) => ['recreate', 'remove'].includes(c.kind));
      const prepared = [],
        created = [],
        addedNetworks = [],
        warnings = [],
        started = [],
        changedNetworks = [];
      let startupChecks = [];
      const networks = new Map(actual.networks.map((n) => [n.Labels[nodeLabel], n.Id]));
      // Download before stopping anything; a missing image leaves the deployment intact.
      for (const image of new Set(
        p.plan.changes
          .filter((c) => ['add', 'recreate'].includes(c.kind))
          .map((c) => p.next.nodes.find((n) => n.id === c.id).data.image),
      ))
        await ensureImage(image, notify);
      await prepareStartup(
        engine,
        p.plan.changes
          .filter((c) => ['add', 'recreate'].includes(c.kind))
          .map((c) => p.next.nodes.find((n) => n.id === c.id)),
        notify,
      );
      await stopCapture(
        actual.containers
          .filter((c) => affected.some((a) => a.id === c.Config.Labels[nodeLabel]))
          .map((c) => c.Id),
      );
      if ((await inspect(p.before)).signature !== p.signature)
        throw Error('Docker a changé pendant la préparation. Recrée l’aperçu avant de continuer.');
      try {
        for (const change of affected) {
          const info = actual.containers.find((c) => c.Config.Labels[nodeLabel] === change.id),
            container = engine.getContainer(info.Id);
          const item = { container, info, disconnected: [], renamed: false, stopped: false };
          prepared.push(item);
          notify(`Préparation de ${change.label}…`);
          if (info.State.Running) {
            await container.stop({ t: 5 });
            item.stopped = true;
          }
          await container.rename({
            name: `${info.Name.replace(/^\//, '')}-backup-${token.slice(0, 8)}`,
          });
          item.renamed = true;
          for (const [name, endpoint] of Object.entries(info.NetworkSettings.Networks)) {
            if (['none', 'host'].includes(name)) continue;
            await engine.getNetwork(endpoint.NetworkID).disconnect({ Container: info.Id });
            item.disconnected.push(endpoint);
          }
        }
        for (const change of p.plan.changes.filter((c) =>
          ['network-remove', 'network-recreate'].includes(c.kind),
        )) {
          const info = actual.networks.find((n) => n.Labels[nodeLabel] === change.id);
          const item = { info, removed: false };
          changedNetworks.push(item);
          await engine.getNetwork(info.Id).remove();
          item.removed = true;
        }
        for (const change of p.plan.changes.filter((c) =>
          ['network-add', 'network-recreate'].includes(c.kind),
        )) {
          const n = p.next.nodes.find((n) => n.id === change.id);
          const net = await createLabNetwork(engine, p.next, n);
          addedNetworks.push(net);
          networks.set(n.id, net.id);
        }
        for (const change of p.plan.changes.filter((c) => ['add', 'recreate'].includes(c.kind))) {
          const n = p.next.nodes.find((n) => n.id === change.id);
          const c = await createLabContainer(engine, p.next, n, networks, (c) => created.push(c));
          const old = prepared.find((x) => x.info.Config.Labels[nodeLabel] === n.id);
          if (!old || old.info.State.Running) {
            await c.start();
            started.push({ node: n, container: c });
          }
        }
        startupChecks = await verifyStartup(engine, p.next, started, notify);
        await persist(p.next);
      } catch (error) {
        const failures = [];
        const attempt = async (fn) => {
          try {
            await fn();
          } catch (e) {
            failures.push(e.message);
          }
        };
        for (const c of created.reverse()) await attempt(() => c.remove({ force: true, v: false }));
        for (const net of addedNetworks.reverse()) await attempt(() => net.remove());
        const restoredNetworks = new Map();
        for (const item of changedNetworks.filter((n) => n.removed))
          await attempt(async () => {
            const n = item.info;
            const restored = await engine.createNetwork({
              Name: n.Name,
              Driver: n.Driver,
              Internal: n.Internal,
              EnableIPv6: n.EnableIPv6,
              ...(typeof n.EnableIPv4 === 'boolean' ? { EnableIPv4: n.EnableIPv4 } : {}),
              Attachable: n.Attachable,
              IPAM: n.IPAM,
              Options: n.Options,
              Labels: n.Labels,
            });
            restoredNetworks.set(n.Id, restored.id);
          });
        for (const item of prepared.reverse()) {
          if (item.renamed)
            await attempt(() => item.container.rename({ name: item.info.Name.replace(/^\//, '') }));
          for (const endpoint of item.disconnected)
            await attempt(() =>
              engine
                .getNetwork(restoredNetworks.get(endpoint.NetworkID) || endpoint.NetworkID)
                .connect({
                  Container: item.info.Id,
                  EndpointConfig: {
                    Aliases: endpoint.Aliases || [],
                    IPAMConfig: {
                      ...endpoint.IPAMConfig,
                      ...(endpoint.IPAddress ? { IPv4Address: endpoint.IPAddress } : {}),
                      ...(endpoint.GlobalIPv6Address
                        ? { IPv6Address: endpoint.GlobalIPv6Address }
                        : {}),
                    },
                  },
                }),
            );
          if (item.stopped) await attempt(() => item.container.start());
        }
        throw Object.assign(
          Error(
            `${error.message.replace(/\.+$/, '')}. ${failures.length ? `Restauration partielle : ${failures.join('; ')}` : 'Les anciens conteneurs ont été conservés et restaurés.'}`,
          ),
          {
            startupChecks: error.startupChecks || startupChecks,
            rollback: failures.length ? 'partial' : 'restored',
          },
        );
      }
      // Commit succeeded. Only now discard the old writable layers; named volumes remain.
      for (const item of prepared)
        try {
          await item.container.remove({ force: true, v: false });
        } catch (e) {
          warnings.push(`Ancien conteneur ${item.info.Name} à nettoyer : ${e.message}`);
        }
      notify('Changements appliqués au laboratoire.');
      return { topology: p.next, warnings, changes: p.plan.changes, startupChecks };
    },
  };
}
