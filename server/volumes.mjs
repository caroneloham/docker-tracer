import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { LABEL, volumeMounts } from '../shared/model.mjs';
import { backupInput, restoreTopology } from '../shared/backups.mjs';
import { labLabels, labName } from './lab-config.mjs';
import { ensureImage } from './docker.mjs';
import { saveArchive, verifyArchive } from './backup-archive.mjs';

const image = 'alpine:3.23';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nameOf = (c) => c.Name.replace(/^\//, '');
export function createVolumeManager({
  record,
  getEngine,
  editor,
  backups,
  stopCaptures,
  notify = () => {},
}) {
  const previews = new Map();
  const keep = (data) => {
    for (const [k, v] of previews) if (v.expires < Date.now()) previews.delete(k);
    if (previews.size >= 30) previews.delete(previews.keys().next().value);
    const token = randomUUID();
    previews.set(token, { ...data, expires: Date.now() + 300000 });
    return token;
  };
  const take = (token, kind) => {
    const p = previews.get(token);
    previews.delete(token);
    if (!p || p.kind !== kind || p.expires < Date.now() || p.revision !== record().revision)
      throw Error('L’aperçu a expiré ou le projet a changé. Recrée l’aperçu.');
    return p;
  };
  async function volume(engine, name) {
    const v = await engine.getVolume(name).inspect();
    if (v.Labels?.[LABEL + '.project'] !== record().id || v.Labels?.[LABEL + '.role'] !== 'volume')
      throw Error('Ce volume n’appartient pas à ce projet.');
    if (v.Driver !== 'local' || Object.keys(v.Options || {}).length)
      throw Error('Seuls les volumes locaux Docker sans options de montage sont pris en charge.');
    return v;
  }
  async function consumers(engine, name) {
    const all = await engine.listContainers({ all: true, filters: { volume: [name] } });
    return (await Promise.all(all.map((c) => engine.getContainer(c.Id).inspect()))).filter((c) =>
      c.Mounts.some((m) => m.Type === 'volume' && m.Name === name),
    );
  }
  async function snapshot(engine, name) {
    const v = await volume(engine, name),
      users = await consumers(engine, name);
    for (const c of users) {
      if (
        c.Config.Labels?.[LABEL + '.project'] !== record().id ||
        c.Config.Labels?.[LABEL + '.role'] !== 'node'
      )
        throw Error(
          'Ce volume est utilisé par un conteneur extérieur au projet ou une sonde. Aucune interruption ne sera effectuée.',
        );
      if (c.State.Paused || c.State.Restarting || c.State.Dead)
        throw Error(
          'Un utilisateur de ce volume est suspendu ou instable. Stabilise-le avant la sauvegarde.',
        );
    }
    return {
      v,
      users,
      signature: digest({
        name,
        created: v.CreatedAt,
        labels: v.Labels,
        users: users
          .map((c) => ({
            id: c.Id,
            state: {
              status: c.State.Status,
              running: c.State.Running,
              startedAt: c.State.StartedAt,
              restartCount: c.RestartCount,
              paused: c.State.Paused,
            },
            mounts: c.Mounts,
            restart: c.HostConfig.RestartPolicy,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    };
  }
  async function helper(engine, name, readOnly, id, nodeId) {
    const c = await engine.createContainer({
      Image: image,
      Cmd: ['true'],
      Labels: { ...labLabels(record().topology, nodeId, 'backup'), [LABEL + '.backup']: id },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 64 * 1024 ** 2,
        NanoCpus: 250000000,
        PidsLimit: 16,
        Mounts: [
          {
            Type: 'volume',
            Source: name,
            Target: '/volume',
            ReadOnly: readOnly,
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
    });
    try {
      await backups.update(id, { helperId: c.id });
    } catch (e) {
      await c.remove({ force: true }).catch(() => {});
      throw e;
    }
    return c;
  }
  async function cleanup(engine, id) {
    const r = backups.get(id, record().id),
      errors = [];
    if (r.helperId) {
      try {
        const c = engine.getContainer(r.helperId),
          info = await c.inspect();
        if (
          info.Config.Labels?.[LABEL + '.backup'] !== id ||
          info.Config.Labels?.[LABEL + '.project'] !== record().id ||
          info.Config.Labels?.[LABEL + '.role'] !== 'backup'
        )
          throw Error('La sonde ne correspond plus à la sauvegarde.');
        await c.remove({ force: true });
        await backups.update(id, { helperId: null });
      } catch (e) {
        if (e.statusCode === 404) await backups.update(id, { helperId: null });
        else errors.push('Nettoyage de la sonde : ' + e.message);
      }
    }
    const pending = [];
    for (const item of r.resume) {
      try {
        const c = engine.getContainer(item.id),
          info = await c.inspect();
        if (
          info.Config.Labels?.[LABEL + '.project'] !== record().id ||
          info.Config.Labels?.[LABEL + '.role'] !== 'node'
        )
          throw Error('Identité du service différente.');
        if (info.State.Paused || info.State.Dead || info.State.Restarting)
          throw Error('État instable.');
        if (!info.State.Running) await c.start();
      } catch (e) {
        pending.push(item);
        errors.push(`Reprise de ${item.name} : ${e.message}`);
      }
    }
    await backups.update(id, { resume: pending });
    return errors;
  }
  return {
    async list() {
      const t = record().topology;
      let all = { Volumes: [] },
        warning;
      try {
        all = await (
          await getEngine()
        ).listVolumes({ filters: { label: [LABEL + '.project=' + t.id, LABEL + '.role=volume'] } });
      } catch (e) {
        warning =
          'Volumes indisponibles sur ce serveur : ' +
          e.message +
          ' Les archives locales restent accessibles.';
      }
      return {
        warning,
        volumes: (all.Volumes || []).map((v) => {
          const nodeId = v.Labels?.[LABEL + '.node'],
            node = t.nodes.find((n) => n.id === nodeId),
            mount =
              node && volumeMounts(node).find((m) => `${labName(t, node)}-${m.id}` === v.Name),
            previous = backups.knownVolume(t.id, v.Name);
          return {
            name: v.Name,
            nodeId,
            service: node?.data.label || nodeId,
            target: mount?.target || previous?.target || v.Labels?.[LABEL + '.mount-target'] || '',
            configured: !!mount,
            supported: v.Driver === 'local' && !Object.keys(v.Options || {}).length,
            createdAt: v.CreatedAt,
          };
        }),
        backups: backups.list(t.id),
        capacity: await backups.capacity(),
      };
    },
    async previewBackup(input) {
      const data = backupInput.parse(input),
        engine = await getEngine(),
        state = await snapshot(engine, data.volume),
        t = record().topology;
      const nodeId = state.v.Labels[LABEL + '.node'],
        node = t.nodes.find((n) => n.id === nodeId),
        mount =
          node && volumeMounts(node).find((m) => `${labName(t, node)}-${m.id}` === data.volume),
        previous = backups.knownVolume(t.id, data.volume);
      const target = mount?.target || previous?.target || state.v.Labels?.[LABEL + '.mount-target'];
      if (!target) throw Error('Le chemin de ce volume conservé est inconnu.');
      const interrupted = state.users
        .filter((c) => c.State.Running)
        .map((c) => ({ id: c.Id, name: nameOf(c) }));
      const capacity = await backups.capacity();
      if (!capacity.available) throw Error('Plus assez de place pour une sauvegarde.');
      const token = keep({
        kind: 'backup',
        revision: record().revision,
        signature: state.signature,
        data,
        target,
        nodeId,
      });
      return {
        token,
        volume: data.volume,
        name: data.name,
        service: node?.data.label || nodeId,
        target,
        interrupted,
        capacity,
      };
    },
    async backup(token) {
      return backups.exclusive(async () => {
        const p = take(token, 'backup'),
          engine = await getEngine();
        await ensureImage(image, notify, engine);
        const state = await snapshot(engine, p.data.volume);
        if (state.signature !== p.signature)
          throw Error('Le volume ou ses services ont changé. Recrée l’aperçu.');
        const capacity = await backups.capacity();
        if (!capacity.available) throw Error('Plus assez de place pour une sauvegarde.');
        const id = randomUUID(),
          r = {
            id,
            projectId: record().id,
            hostId: record().hostId,
            nodeId: p.nodeId,
            target: p.target,
            volume: p.data.volume,
            name: p.data.name,
            createdAt: Date.now(),
            status: 'running',
            resume: state.users
              .filter((c) => c.State.Running)
              .map((c) => ({ id: c.Id, name: nameOf(c) })),
          };
        await backups.update(id, r);
        let error;
        try {
          await stopCaptures(state.users.map((c) => c.Id));
          for (const c of state.users.filter((c) => c.State.Running)) {
            notify(`Arrêt de ${nameOf(c)} pour la sauvegarde…`);
            await engine.getContainer(c.Id).stop({ t: 30 });
            const stopped = await engine.getContainer(c.Id).inspect();
            if (stopped.State.Running || stopped.State.ExitCode === 137)
              throw Error(`${nameOf(c)} n’a pas confirmé un arrêt propre. Sauvegarde annulée.`);
          }
          if ((await snapshot(engine, p.data.volume)).users.some((c) => c.State.Running))
            throw Error('Un service utilise encore le volume.');
          const c = await helper(engine, p.data.volume, true, id, p.nodeId);
          notify('Copie du volume vers ce PC…');
          const result = await saveArchive(
            await c.getArchive({ path: '/volume/.' }),
            backups.archive(id, true),
            capacity.available,
            { progress: (bytes) => notify(`${Math.round(bytes / 1024 ** 2)} Mio sauvegardés…`) },
          );
          const usersAfter = (await consumers(engine, p.data.volume)).filter((x) => x.Id !== c.id);
          if (
            usersAfter.some((x) => x.State.Running) ||
            usersAfter.some((x) => !state.users.some((y) => y.Id === x.Id))
          )
            throw Error(
              'Les utilisateurs du volume ont changé pendant la copie. Sauvegarde annulée.',
            );
          const verified = await verifyArchive(backups.archive(id, true), result);
          await rename(backups.archive(id, true), backups.archive(id));
          await backups.update(id, {
            ...result,
            ...verified,
            status: 'ready',
            message: 'Archive vérifiée. Reprise des services en cours.',
          });
        } catch (e) {
          error = e;
          await backups.update(id, { status: 'failed', message: e.message });
          await rm(backups.archive(id, true), { force: true });
        } finally {
          const warnings = await cleanup(engine, id);
          if (warnings.length) {
            await backups.update(id, {
              message: [error?.message, ...warnings].filter(Boolean).join(' '),
            });
            error = Error(warnings.join(' '));
          } else if (!error)
            await backups.update(id, {
              message: r.resume.length
                ? 'Archive vérifiée. Redémarrage demandé pour les services initialement actifs.'
                : 'Archive vérifiée. Les services arrêtés le sont restés.',
            });
        }
        if (error) throw error;
        return { backup: backups.get(id, record().id) };
      });
    },
    async previewRestore(id) {
      const b = backups.get(id, record().id);
      if (b.status !== 'ready' || b.hostId !== record().hostId || b.helperId || b.resume.length)
        throw Error('Cette sauvegarde n’est pas prête. Termine sa reprise éventuelle.');
      await getEngine();
      const mountId = 'restored-' + randomUUID().slice(0, 8),
        next = restoreTopology(record().topology, b, mountId),
        node = next.nodes.find((n) => n.id === b.nodeId),
        destination = `${labName(next, node)}-${mountId}`;
      const plan = await editor().preview(next);
      return {
        ...plan,
        token: keep({
          kind: 'restore',
          revision: record().revision,
          backupId: id,
          editorToken: plan.token,
          destination,
          nodeId: b.nodeId,
        }),
        backup: b,
        destination,
      };
    },
    async restore(token) {
      return backups.exclusive(async () => {
        const p = take(token, 'restore'),
          b = backups.get(p.backupId, record().id),
          engine = await getEngine();
        if (b.status !== 'ready' || b.hostId !== record().hostId || b.helperId || b.resume.length)
          throw Error('Sauvegarde indisponible.');
        notify('Vérification de l’archive avant restauration…');
        await verifyArchive(backups.archive(b.id), b);
        await ensureImage(image, notify, engine);
        try {
          await engine.getVolume(p.destination).inspect();
          throw Error('Le volume de destination existe déjà. Recrée l’aperçu.');
        } catch (e) {
          if (e.statusCode !== 404) throw e;
        }
        let created = false,
          input;
        try {
          await engine.createVolume({
            Name: p.destination,
            Labels: {
              ...labLabels(record().topology, p.nodeId, 'volume'),
              [LABEL + '.mount-target']: b.target,
            },
          });
          created = true;
          const c = await helper(engine, p.destination, false, b.id, p.nodeId);
          input = createReadStream(backups.archive(b.id));
          await c.putArchive(input, {
            path: '/volume',
            noOverwriteDirNonDir: true,
            copyUIDGID: true,
            abortSignal: AbortSignal.timeout(30 * 60 * 1000),
          });
          const warnings = await cleanup(engine, b.id);
          if (warnings.length) throw Error(warnings.join(' '));
          notify('Données restaurées. Application du remplacement prévu…');
          const result = await editor().apply(p.editorToken);
          return { ...result, restoredVolume: p.destination };
        } catch (e) {
          input?.destroy();
          const warnings = await cleanup(engine, b.id);
          if (created)
            try {
              if (!(await consumers(engine, p.destination)).length)
                await engine.getVolume(p.destination).remove();
              else warnings.push('Le nouveau volume reste utilisé ; il a été conservé.');
            } catch (cleanupError) {
              warnings.push('Le nouveau volume est conservé : ' + cleanupError.message);
            }
          e.message += warnings.length ? ' ' + warnings.join(' ') : '';
          throw e;
        }
      });
    },
    async recover(id) {
      return backups.exclusive(async () => {
        const b = backups.get(id, record().id);
        if (b.hostId !== record().hostId) throw Error('Serveur différent.');
        const errors = await cleanup(await getEngine(), id);
        if (errors.length) throw Error(errors.join(' '));
        await backups.update(id, {
          ...(b.status === 'running' ? { status: 'interrupted' } : {}),
          message: 'Sonde nettoyée et reprise demandée. Vérifie l’état des services sur la carte.',
        });
        return { ok: true };
      });
    },
    async remove(id) {
      return backups.exclusive(async () => {
        const b = backups.get(id, record().id);
        if (b.status === 'running' || b.resume.length || b.helperId)
          throw Error('Termine la reprise avant de supprimer cette sauvegarde.');
        await rm(backups.archive(id), { force: true });
        await rm(backups.archive(id, true), { force: true });
        await backups.update(id, null);
        return { ok: true };
      });
    },
  };
}
