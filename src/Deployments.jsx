import React from 'react';
import { visibleComposeProgress } from '../shared/compose-progress.mjs';
const outcome = {
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échoué',
  inconclusive: 'Non concluant',
};
const verdict = {
  passed: 'Réussi',
  failed: 'Échoué',
  inconclusive: 'Non concluant',
  skipped: 'Sans contrôle',
};
const rollback = {
  restored: 'Anciens conteneurs restaurés.',
  partial: 'Restauration ou nettoyage incomplet : vérifier Docker.',
  cleaned: 'Ressources du déploiement manqué nettoyées.',
};
export function DeploymentHistory({ runs, onSelect }) {
  return (
    <div className="packet-table-wrap">
      <table className="packet-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Opération</th>
            <th>Résultat</th>
            <th>Contrôles</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.startedAt).toLocaleString('fr-FR')}</td>
              <td>
                {r.kind === 'compose'
                  ? 'Compose'
                  : r.kind === 'restore'
                    ? 'Restauration de volume'
                    : r.kind === 'apply'
                      ? 'Modification'
                      : 'Déploiement'}
              </td>
              <td>{outcome[r.status]}</td>
              <td>{r.checks.filter((c) => c.status !== 'skipped').length}</td>
              <td>
                <button onClick={() => onSelect(r)}>Voir le résultat</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!runs.length && (
        <div className="empty-state">
          <strong>Aucun déploiement enregistré</strong>
          <p>
            Les créations et modifications conserveront ici leurs contrôles et le résultat d’une
            éventuelle restauration.
          </p>
        </div>
      )}
    </div>
  );
}
export function DeploymentResult({ run }) {
  return (
    <>
      <span className="eyebrow">DÉPLOIEMENT · {outcome[run.status]}</span>
      <h2>{run.kind === 'apply' ? 'Résultat de la modification' : 'Résultat du déploiement'}</h2>
      <p>
        {new Date(run.startedAt).toLocaleString('fr-FR')} · {run.hostId}
      </p>
      <p role="status">{run.message}</p>
      {run.output && (
        <details open>
          <summary>Sortie de Compose</summary>
          <pre className="proxy-preview">
            {run.kind === 'compose' ? visibleComposeProgress(run.output) : run.output}
          </pre>
        </details>
      )}
      {run.rollback && <p className="lab-change-warning">{rollback[run.rollback]}</p>}
      <div className="lab-change-list">
        {run.checks.map((c) => (
          <section key={c.nodeId} className="startup-result">
            <h3>
              {c.label} · {verdict[c.status]}
            </h3>
            <p>{c.description}</p>
            <p>{c.summary}</p>
            {c.mode !== 'none' && (
              <small>
                {c.attempts} observation(s) · {((c.finishedAt - c.startedAt) / 1000).toFixed(1)} s ·
                conteneur {c.containerId?.slice(0, 12)}
              </small>
            )}
            {!!c.observations.length && (
              <details>
                <summary>Voir les preuves</summary>
                <pre className="proxy-preview">{JSON.stringify(c.observations, null, 2)}</pre>
              </details>
            )}
            {c.applicationLog && (
              <details>
                <summary>Logs au moment de l’échec</summary>
                <pre className="proxy-preview">{c.applicationLog}</pre>
              </details>
            )}
            {c.cleanupWarning && <p className="pdu-error">{c.cleanupWarning}</p>}
          </section>
        ))}
      </div>
      {run.warnings?.map((w, i) => (
        <p key={i} className="pdu-error">
          {w}
        </p>
      ))}
      <p className="field-hint">
        Un contrôle réussi décrit ce qui a été observé pendant le démarrage. Il ne garantit pas la
        disponibilité future ni la cohérence des données. Les écritures dans les volumes ne sont pas
        annulées par une restauration.
      </p>
    </>
  );
}
