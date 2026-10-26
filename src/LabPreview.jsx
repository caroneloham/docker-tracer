import React from 'react';
const titles = {
  add: 'Créer',
  recreate: 'Remplacer',
  remove: 'Supprimer',
  'network-add': 'Créer le réseau',
  'network-remove': 'Retirer le réseau',
  'network-recreate': 'Remplacer le bridge',
};
export default function LabPreview({ plan, busy, onApply, onRefresh, onMigrate }) {
  const interrupted = plan.changes.filter((c) => ['recreate', 'remove'].includes(c.kind));
  return (
    <>
      <span className="eyebrow">MODIFICATIONS DU LABORATOIRE</span>
      <h2>Vérifier avant d’appliquer</h2>
      <p>
        {plan.unchanged} service{plan.unchanged > 1 ? 's' : ''} conservé
        {plan.unchanged > 1 ? 's' : ''} sans remplacement. {interrupted.length} service
        {interrupted.length > 1 ? 's' : ''} concerné{interrupted.length > 1 ? 's' : ''} par un
        arrêt.
      </p>
      <div className="lab-change-list">
        {plan.changes.length ? (
          plan.changes.map((c) => (
            <div key={c.id} className={`lab-change ${c.kind}`}>
              <strong>{titles[c.kind]}</strong>
              <div>
                <b>{c.label}</b>
                <span>{c.reason}</span>
              </div>
            </div>
          ))
        ) : (
          <p>Seuls le dessin ou les noms visuels ont changé.</p>
        )}
      </div>
      {interrupted.length > 0 && (
        <p className="lab-change-warning">
          Les services remplacés s’arrêtent pendant l’opération. Leurs volumes nommés sont conservés
          ; les fichiers stockés uniquement dans leur conteneur sont perdus après validation. Un
          service déjà arrêté reste arrêté.
        </p>
      )}
      {!!plan.startupChecks?.length && (
        <div className="startup-plan">
          <h3>Contrôles avant validation</h3>
          {plan.startupChecks.map((c) => (
            <p key={c.nodeId}>
              <b>{c.label}</b> :{' '}
              {c.stopped ? 'Conservé arrêté · pas de contrôle exécuté' : c.description}
            </p>
          ))}
          <p className="field-hint">
            Les anciennes versions sont conservées jusqu’au résultat des contrôles demandés. Leurs
            données dans les volumes ne sont pas restaurées en cas d’écriture.
          </p>
        </div>
      )}
      {plan.blocked.map((message, i) => (
        <p className="pdu-error" role="alert" key={i}>
          {message}
        </p>
      ))}
      {plan.migration && (
        <div className="lab-change-warning">
          <strong>Mise à niveau des connexions réseau</strong>
          <p>
            Services concernés : {plan.migration.services.join(', ')}. Cette étape les recrée avec
            les réglages actuels et préserve leurs volumes. Les données stockées uniquement dans le
            conteneur seront remplacées. Les services déjà arrêtés resteront arrêtés ; ton brouillon
            sera conservé.
          </p>
          <button className="outline-btn" disabled={busy} onClick={onMigrate}>
            Mettre à niveau ces services
          </button>
        </div>
      )}
      <p className="field-hint">
        En cas d’échec avant l’enregistrement, Docker Tracer tente de restaurer les anciens
        conteneurs et réseaux. Un réseau restauré retrouve ses réglages avec un nouvel identifiant
        Docker. Cet aperçu expire après deux minutes.
      </p>
      <div className="modal-actions">
        <button className="outline-btn" disabled={busy} onClick={onRefresh}>
          Actualiser l’aperçu
        </button>
        <button
          className="deploy-button"
          disabled={busy || !!plan.blocked.length}
          onClick={onApply}
        >
          {busy ? 'Application…' : 'Appliquer ces changements'}
        </button>
      </div>
    </>
  );
}
