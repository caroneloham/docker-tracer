import React, { useEffect, useState } from 'react';
import { backupStates } from '../shared/backups.mjs';
import LabPreview from './LabPreview.jsx';
const size = (n) => {
  const unit = n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0;
  return `${(n / 1024 ** unit).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['octets', 'Kio', 'Mio', 'Gio'][unit]}`;
};
export default function Volumes({ api, project, available, dirty, onRestored, onRefreshState }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(null),
    [name, setName] = useState(''),
    [selected, setSelected] = useState('');
  const refresh = async () => {
    const result = await api('/volumes');
    setData(result);
    setSelected((old) =>
      result.volumes.some((v) => v.name === old)
        ? old
        : result.volumes.find((v) => v.configured)?.name || '',
    );
  };
  useEffect(() => {
    if (available) refresh().catch((e) => setError(e.message));
  }, [available]);
  const action = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      if (pending?.kind === 'backup') setPending(null);
    } finally {
      try {
        await refresh();
      } catch (e) {
        setError((old) => old || e.message);
      }
      await onRefreshState();
      setBusy(false);
    }
  };
  const current = data?.volumes.find((v) => v.name === selected);
  return (
    <div className="volume-manager">
      <span className="eyebrow">DONNÉES PERSISTANTES</span>
      <h2>Volumes et sauvegardes</h2>
      <p>
        {project.name} · {project.host?.name || project.hostId}
      </p>
      {!available ? (
        <p role="status">Redémarre Docker Tracer pour activer la gestion des sauvegardes.</p>
      ) : (
        <>
          {dirty && (
            <p className="lab-change-warning">
              Enregistre ou annule le brouillon avant de sauvegarder ou restaurer. Les actions
              concernent le projet enregistré.
            </p>
          )}
          {data?.warning && (
            <p className="lab-change-warning" role="status">
              {data.warning}
            </p>
          )}
          {error && (
            <p className="pdu-error" role="alert">
              {error}
            </p>
          )}
          {busy && (
            <p role="status">
              Opération en cours. Le journal du projet indique la progression. Les services seront
              repris selon leur état initial.
            </p>
          )}
          {pending?.kind === 'backup' ? (
            <section>
              <h3>Sauvegarder « {pending.name} »</h3>
              <p>
                <b>{pending.service}</b> · {pending.target}
              </p>
              <code>{pending.volume}</code>
              <p className="lab-change-warning">
                {pending.interrupted.length
                  ? `Interruption temporaire : ${pending.interrupted.map((c) => c.name).join(', ')}. Ces services seront redémarrés après la copie.`
                  : 'Aucun service actif à interrompre.'}
              </p>
              <p>
                Archive conservée sur ce PC, jusqu’à {size(pending.capacity.available)}. Prévois une
                interruption pendant toute la copie. Les autres conteneurs restent démarrés ; leurs
                applications peuvent subir l’indisponibilité temporaire du service sauvegardé.
              </p>
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setPending(null)}>
                  Annuler
                </button>
                <button
                  disabled={busy || dirty}
                  onClick={() =>
                    action(async () => {
                      await api('/backups/create', { token: pending.token });
                      setPending(null);
                    })
                  }
                >
                  Confirmer la sauvegarde
                </button>
              </div>
            </section>
          ) : pending?.kind === 'restore' ? (
            <section>
              <h3>Restaurer « {pending.backup.name} »</h3>
              <p>
                Une nouvelle copie des données sera reliée au service. Le volume actuellement
                utilisé sera conservé. Ses modifications récentes ne seront plus visibles par ce
                service.
              </p>
              <p className="field-hint">Destination : {pending.destination}</p>
              <LabPreview
                plan={pending}
                busy={busy || dirty}
                onRefresh={() =>
                  action(async () =>
                    setPending({
                      ...(await api('/backups/' + pending.backup.id + '/restore-preview', {})),
                      kind: 'restore',
                    }),
                  )
                }
                onApply={() =>
                  action(async () => {
                    const result = await api('/backups/restore', { token: pending.token });
                    onRestored(result.topology);
                    setSelected(result.restoredVolume);
                    if (result.warnings?.length) setError(result.warnings.join(' '));
                    setPending(null);
                  })
                }
              />
              <button disabled={busy} onClick={() => setPending(null)}>
                Retour aux sauvegardes
              </button>
            </section>
          ) : pending?.kind === 'delete' ? (
            <section>
              <h3>Supprimer la sauvegarde « {pending.backup.name} » ?</h3>
              <p>
                Son archive locale de {size(pending.backup.bytes)} sera supprimée. Les volumes
                Docker restent présents.
              </p>
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setPending(null)}>
                  Annuler
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api('/backups/' + pending.backup.id, {}, 'DELETE');
                      setPending(null);
                    })
                  }
                >
                  Supprimer cette archive
                </button>
              </div>
            </section>
          ) : pending?.kind === 'recover' ? (
            <section>
              <h3>Reprendre l’opération interrompue</h3>
              <p>
                La sonde de cette sauvegarde sera nettoyée. Ces services seront démarrés s’ils sont
                encore arrêtés :
              </p>
              <ul>
                {pending.backup.resume.map((c) => (
                  <li key={c.id}>
                    {c.name} · {c.id.slice(0, 12)}
                  </li>
                ))}
              </ul>
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setPending(null)}>
                  Annuler
                </button>
                <button
                  disabled={busy || dirty}
                  onClick={() =>
                    action(async () => {
                      await api('/backups/' + pending.backup.id + '/recover', {});
                      setPending(null);
                    })
                  }
                >
                  Reprendre les services et nettoyer
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="volume-form">
                <label>
                  Volume à sauvegarder
                  <select
                    value={selected}
                    disabled={busy}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">Choisir un volume</option>
                    {data?.volumes.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.service} · {v.target || 'chemin inconnu'}
                        {v.configured ? '' : ' · conservé'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nom de la sauvegarde
                  <input
                    value={name}
                    maxLength={80}
                    placeholder="Avant mise à jour"
                    disabled={busy}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <button
                  disabled={
                    busy || dirty || !current?.target || !current?.supported || !name.trim()
                  }
                  onClick={() =>
                    action(async () =>
                      setPending({
                        ...(await api('/backups/preview', { volume: selected, name })),
                        kind: 'backup',
                      }),
                    )
                  }
                >
                  Préparer la sauvegarde
                </button>
              </div>
              {!data?.volumes.length && (
                <p>
                  Les volumes apparaîtront après déploiement. Ajoute un volume dans les réglages
                  Ports & volumes d’un service.
                </p>
              )}
              {current && (
                <p className="field-hint">
                  {current.name}
                  {!current.supported && ' · pilote non pris en charge'}
                </p>
              )}
              {data && (
                <p className="field-hint">
                  Archives locales : {size(data.capacity.used)} / {size(data.capacity.totalBytes)} ·
                  maximum {size(data.capacity.maxBytes)} par sauvegarde. Aucun effacement
                  automatique.
                </p>
              )}
              <h3>Mes sauvegardes</h3>
              <div className="volume-backups">
                {data?.backups.map((b) => (
                  <article key={b.id}>
                    <div>
                      <strong>{b.name}</strong>
                      <span>
                        {backupStates[b.status]} · {new Date(b.createdAt).toLocaleString('fr-FR')} ·{' '}
                        {size(b.bytes)}
                      </span>
                      <span>
                        {b.target} · {b.entries} entrées
                      </span>
                    </div>
                    <p>{b.message}</p>
                    <div className="volume-actions">
                      {b.status === 'ready' && (
                        <>
                          <a
                            href={'/api/projects/' + project.id + '/backups/' + b.id + '/download'}
                            download
                          >
                            Télécharger TAR
                          </a>
                          <button
                            disabled={busy || dirty || !!b.helperId || !!b.resume.length}
                            onClick={() =>
                              action(async () =>
                                setPending({
                                  ...(await api('/backups/' + b.id + '/restore-preview', {})),
                                  kind: 'restore',
                                }),
                              )
                            }
                          >
                            Préparer la restauration
                          </button>
                        </>
                      )}
                      {(b.resume.length > 0 || b.helperId) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => setPending({ kind: 'recover', backup: b })}
                        >
                          Reprendre / nettoyer
                        </button>
                      )}
                      <button
                        disabled={
                          busy || b.status === 'running' || !!b.helperId || !!b.resume.length
                        }
                        onClick={() => setPending({ kind: 'delete', backup: b })}
                      >
                        Supprimer l’archive
                      </button>
                    </div>
                    {b.sha256 && (
                      <details>
                        <summary>Empreinte SHA256</summary>
                        <code>{b.sha256}</code>
                      </details>
                    )}
                  </article>
                ))}
              </div>
              {!data?.backups.length && <p>Aucune sauvegarde enregistrée pour ce projet.</p>}
              <button disabled={busy} onClick={() => action(async () => {})}>
                Actualiser les volumes
              </button>
              <p className="field-hint">
                L’archive contient les données du volume, sans chiffrement. Les services sont
                arrêtés pendant la copie ; pour une base répartie sur plusieurs volumes, prépare
                également une sauvegarde applicative cohérente. Conserve une copie hors de ce PC.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
