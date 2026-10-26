import React, { useMemo, useState } from 'react';
import { BROWSER_MODE } from './browser-mode.js';
import { WorkspaceModal } from './WorkspacePanels.jsx';
import { analyzeRedundancyData } from '../shared/redundancy-data.mjs';
import { analyzeRedundancyNetwork, planLocalRedundancy } from '../shared/redundancy-network.mjs';
import {
  readLocalRedundancy,
  updateLocalRedundancyReplicas,
} from '../shared/redundancy-network.mjs';
import { planAutomaticRedundancy } from '../shared/redundancy-automatic.mjs';
import { prepareFreshAiRedundancy, AI_REDUNDANCY_EXTENSION } from '../shared/ai-redundancy-profile.mjs';
import { AI_EXTENSION } from '../shared/ai-infrastructure.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import EquipmentIcon from './EquipmentIcon.jsx';
import { Copy, RefreshCw, ShieldCheck } from 'lucide-react';

const endpointKey = (endpoint) =>
  [
    endpoint.service,
    endpoint.targetPort,
    endpoint.publishedPort || '',
    endpoint.hostIp || '',
    endpoint.transportProtocol || 'tcp',
  ].join('|');
const classificationLabels = {
  stateless: 'Sans état persistant détecté',
  stateful: 'État persistant détecté',
  inference: 'Moteur d’inférence',
  unknown: 'État à confirmer',
};

function Diagnostics({ title, items, blocking = false }) {
  if (!items?.length) return null;
  return (
    <section
      className={blocking ? 'redundancy-diagnostics blocking' : 'redundancy-diagnostics'}
      aria-label={title}
    >
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.code}-${item.service || ''}-${index}`}>
            {item.service && <strong>{item.service} : </strong>}
            {item.message}
            {item.action && <small>{item.action}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ManualRedundancyDialog({
  source,
  serviceNames,
  hostName,
  locked,
  dirty,
  onClose,
  onApply,
}) {
  const initialData = useMemo(
    () => analyzeRedundancyData(source, serviceNames),
    [source, serviceNames],
  );
  const [selected, setSelected] = useState(() =>
    serviceNames.filter(
      (name) =>
        !initialData.blockers.some(
          (item) => item.service === name && item.code !== 'STATE_UNCLASSIFIED',
        ),
    ),
  );
  const [replicas, setReplicas] = useState(2);
  const [confirmed, setConfirmed] = useState([]);
  const [endpointSettings, setEndpointSettings] = useState({});
  const [applyError, setApplyError] = useState('');
  const network = useMemo(() => analyzeRedundancyNetwork(source, selected), [source, selected]);
  const endpoints = network.endpoints || [];
  const hasPublicEntrypoint = endpoints.length > 0;
  const confirmations = { statelessServices: confirmed.filter((name) => selected.includes(name)) };
  const data = useMemo(() => analyzeRedundancyData(source, selected), [source, selected]);
  const confirmationServices = selected.filter((name) =>
    data.blockers.some((item) => item.service === name && item.code === 'STATE_UNCLASSIFIED'),
  );
  const settingsFor = (endpoint) =>
    endpointSettings[endpointKey(endpoint)] || { protocol: '', healthPath: '/', healthHost: '' };
  const updateEndpoint = (endpoint, fields) =>
    setEndpointSettings((previous) => ({
      ...previous,
      [endpointKey(endpoint)]: { ...settingsFor(endpoint), ...fields },
    }));
  const planOptions = {
    serviceNames: selected,
    replicas,
    confirmations,
    endpoints: endpoints.map((endpoint) => ({
      service: endpoint.service,
      targetPort: endpoint.targetPort,
      publishedPort: endpoint.publishedPort,
      hostIp: endpoint.hostIp,
      transportProtocol: endpoint.transportProtocol || 'tcp',
      protocol: settingsFor(endpoint).protocol,
      ...(settingsFor(endpoint).protocol === 'http'
        ? {
            healthPath: settingsFor(endpoint).healthPath,
            ...(settingsFor(endpoint).healthHost?.trim()
              ? { healthHost: settingsFor(endpoint).healthHost.trim() }
              : {}),
          }
        : {}),
    })),
  };
  let plan;
  try {
    plan = planLocalRedundancy(source, planOptions);
  } catch {
    plan = {
      blockers: [
        {
          code: 'INVALID_PLAN',
          message: 'Le plan ne peut pas être préparé avec cette configuration.',
          action: 'Vérifie les services, leurs ports et leurs réseaux dans le brouillon.',
        },
      ],
      warnings: [],
    };
  }
  const missingProtocols = endpoints.some((endpoint) => !settingsFor(endpoint).protocol);
  const ready =
    plan.summary?.applicable === true &&
    !!plan.source &&
    !plan.blockers?.length &&
    !missingProtocols &&
    selected.length > 0;
  const preserved = serviceNames.filter((name) => !selected.includes(name));
  const publicationLabel = (endpoint) =>
    endpoint.publishedPort
      ? `${endpoint.hostIp ? `${endpoint.hostIp}:` : ''}${endpoint.publishedPort} → ${endpoint.targetPort}`
      : `Interne : ${endpoint.service}:${endpoint.targetPort}`;

  return (
    <WorkspaceModal title="Redonder sur cette machine" wide onClose={onClose}>
      <div className="redundancy-dialog">
        <p className="redundancy-intro">
          Plusieurs conteneurs sur <strong>{hostName}</strong>.
          {hasPublicEntrypoint
            ? ' Un proxy commun répartit les connexions publiques. Les autres instances peuvent répondre si l’une s’arrête.'
            : ' Les instances restantes continuent de tourner si l’une s’arrête. Les services internes gardent leurs réseaux et leur nom de service.'}
        </p>
        {dirty && (
          <p className="field-hint">
            Le plan utilise ton brouillon actuel, avec ses modifications non enregistrées.
          </p>
        )}
        <fieldset disabled={locked}>
          <legend>Services à multiplier</legend>
          <p className="field-hint">
            Coche les applications à redonder. Les services décochés restent en instance unique,
            notamment les bases de données.
          </p>
          <div className="redundancy-services">
            {initialData.services.map((service) => {
              const checked = selected.includes(service.name);
              return (
                <label className="redundancy-service" key={service.name}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, service.name]
                          : previous.filter((name) => name !== service.name),
                      );
                      setApplyError('');
                    }}
                  />
                  <span>
                    <strong>{service.name}</strong>
                    <small>
                      {checked ? `${replicas} instances prévues` : 'Conservé en instance unique'} ·{' '}
                      {classificationLabels[service.classification] || service.classification}
                    </small>
                    {!checked && service.reasons[0] && <small>{service.reasons[0]}</small>}
                  </span>
                </label>
              );
            })}
          </div>
          <label className="redundancy-replicas">
            Nombre total d’instances par service
            <select value={replicas} onChange={(event) => setReplicas(Number(event.target.value))}>
              {[2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count} instances
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        {!!endpoints.length && (
          <fieldset disabled={locked}>
            <legend>Points d’entrée</legend>
            <p className="field-hint">
              Choisis le protocole réel pour chaque port. Les ports publiés et leurs adresses
              d’écoute sont conservés sur le proxy.
            </p>
            {endpoints.map((endpoint) => {
              const settings = settingsFor(endpoint);
              return (
                <div className="redundancy-endpoint" key={endpointKey(endpoint)}>
                  <div>
                    <strong>{endpoint.service}</strong>
                    <small>
                      {publicationLabel(endpoint)} ·{' '}
                      {String(endpoint.transportProtocol || 'tcp').toUpperCase()}
                    </small>
                  </div>
                  <label>
                    Protocole de {endpoint.service}:{endpoint.targetPort}
                    <select
                      value={settings.protocol}
                      onChange={(event) =>
                        updateEndpoint(endpoint, { protocol: event.target.value })
                      }
                    >
                      <option value="">Choisir le protocole</option>
                      <option value="http">HTTP</option>
                      <option value="tcp">TCP / TLS transmis au conteneur</option>
                    </select>
                  </label>
                  {settings.protocol === 'http' && (
                    <label>
                      Chemin du contrôle HTTP
                      <input
                        value={settings.healthPath}
                        placeholder="/health"
                        onChange={(event) =>
                          updateEndpoint(endpoint, { healthPath: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {settings.protocol === 'http' && (
                    <label>
                      Domaine de la sonde (facultatif)
                      <input
                        value={settings.healthHost || ''}
                        placeholder="app.client.local"
                        onChange={(event) =>
                          updateEndpoint(endpoint, { healthHost: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {settings.protocol === 'http' && (
                    <p className="field-hint">
                      Ce chemin doit répondre avec un statut HTTP de 200 à 299 sans
                      authentification. Renseigne le domaine si ton application vérifie le nom du
                      site.
                    </p>
                  )}
                  {settings.protocol === 'tcp' && (
                    <p className="field-hint">
                      Contrôle de connexion TCP. Le conteneur conserve la gestion de TLS ; le proxy
                      ne vérifie pas la réponse applicative.
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        {!!confirmationServices.length && (
          <fieldset disabled={locked}>
            <legend>Vérifier l’état de chaque application</legend>
            <p className="field-hint">
              L’image seule ne permet pas de vérifier les sessions, les fichiers locaux ou les
              tâches en arrière-plan.
            </p>
            {confirmationServices.map((name) => (
              <label className="redundancy-confirmation" key={name}>
                <input
                  type="checkbox"
                  checked={confirmed.includes(name)}
                  onChange={(event) =>
                    setConfirmed((previous) =>
                      event.target.checked
                        ? [...previous, name]
                        : previous.filter((value) => value !== name),
                    )
                  }
                />
                <span>
                  Je confirme que <strong>{name}</strong> peut fonctionner en plusieurs instances
                  simultanées sans état local indispensable, sans conflit d’écriture et sans
                  exécuter deux fois ses tâches.
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <section className="redundancy-recap" aria-label="Récapitulatif de la redondance">
          <h3>Configuration prévue</h3>
          <p>
            <strong>
              {selected.length} service(s) × {replicas} instances
            </strong>
            {hasPublicEntrypoint ? ', plus un proxy commun.' : ', sans nouveau port public.'}{' '}
            Prévois jusqu’à {replicas} fois les ressources CPU et mémoire des services multipliés
            {hasPublicEntrypoint ? ', plus celles du proxy.' : '.'}
          </p>
          {!!preserved.length && (
            <p>
              Instance unique conservée : <strong>{preserved.join(', ')}</strong>.
            </p>
          )}
          <p>
            {hasPublicEntrypoint
              ? 'Les ports publiés restent identiques. Le proxy et la machine restent des points de panne uniques ; cette configuration ne protège pas contre l’arrêt de la machine.'
              : 'La machine reste un point de panne unique. Pour les services internes, la reprise dépend de la capacité de leurs clients à retrouver une instance disponible et à se reconnecter.'}
          </p>
          <p>
            Docker relance un processus qui s’arrête avec la politique de redémarrage. Un conteneur
            marqué « unhealthy » n’est pas redémarré par ce seul statut.
            {hasPublicEntrypoint &&
              ' Le proxy retire des connexions nouvelles les instances qui échouent à ses contrôles ; une connexion en cours peut être coupée.'}
          </p>
          <p className="field-hint">
            La reprise n’a pas été testée sur cette machine. Aucun délai de rétablissement n’est
            garanti par ce brouillon.
          </p>
        </section>
        <Diagnostics title="À résoudre avant l’ajout" items={plan.blockers} blocking />
        {!!plan.warnings?.length && (
          <details className="redundancy-details">
            <summary>Détails et limites ({plan.warnings.length})</summary>
            <Diagnostics title="À prendre en compte" items={plan.warnings} />
          </details>
        )}
        {applyError && (
          <p className="compose-error" role="alert">
            {applyError}
          </p>
        )}
        {!selected.length && (
          <p role="status">Sélectionne au moins une application à multiplier.</p>
        )}
        <div className="redundancy-actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="deploy-button"
            type="button"
            disabled={locked || !ready}
            onClick={() => {
              if (locked || !ready) return;
              try {
                const checked = planLocalRedundancy(source, planOptions);
                if (
                  checked.summary?.applicable !== true ||
                  !checked.source ||
                  checked.blockers?.length
                ) {
                  setApplyError(
                    'Le plan a changé. Vérifie les points signalés avant de réessayer.',
                  );
                  return;
                }
                onApply(checked.source);
              } catch {
                setApplyError(
                  'Le brouillon n’a pas été modifié. Vérifie les points signalés avant de réessayer.',
                );
              }
            }}
          >
            {BROWSER_MODE ? 'Appliquer au fichier' : 'Ajouter au brouillon'}
          </button>
        </div>
        <p className="field-hint">
          {BROWSER_MODE
            ? 'Le fichier est modifié dans cet onglet. Aucun conteneur n’est créé.'
            : 'Docker ne change qu’après « Préparer le déploiement », puis confirmation dans l’aperçu.'}
        </p>
      </div>
    </WorkspaceModal>
  );
}

export default function RedundancyDialog(props) {
  const { source, serviceNames, hostName, locked, onClose, onApply, fresh = false } = props;
  const existing = useMemo(() => readLocalRedundancy(source), [source]);
  const model = useMemo(() => composeDocument(source).model, [source]);
  const aiProfile = !!model[AI_REDUNDANCY_EXTENSION] || (!!model[AI_EXTENSION] && fresh);
  const [replicas, setReplicas] = useState(existing?.replicas || model[AI_REDUNDANCY_EXTENSION]?.replicas || 2);
  const [advanced, setAdvanced] = useState(false);
  const plan = useMemo(() => {
    try {
      if (aiProfile) {
        const result = prepareFreshAiRedundancy(source, { replicas });
        return { ...result, summary: { ...result.summary, changed: result.source !== source } };
      }
      if (!existing) return planAutomaticRedundancy(source, { serviceNames, replicas });
      const updated = updateLocalRedundancyReplicas(source, {
        replicas,
        confirmations: { statelessServices: existing.serviceNames },
      });
      return {
        ...updated,
        summary: {
          ...updated.summary,
          changed: updated.source !== source,
          replicatedServices: existing.serviceNames,
          restartServices: [],
          services: existing.serviceNames.map((name) => ({
            name,
            strategy: 'replicas',
            instances: replicas,
            reason: 'Entrée commune et sondes conservées',
          })),
        },
      };
    } catch (error) {
      return { blockers: [{ message: error.message }], summary: { services: [] } };
    }
  }, [source, serviceNames, replicas, existing, aiProfile]);
  const previewModel = useMemo(() => {
    try { return plan.source ? composeDocument(plan.source).model : model; } catch { return model; }
  }, [plan.source, model]);
  if (advanced)
    return (
      <ManualRedundancyDialog {...props} onApply={(next) => onApply(next, { deploy: true })} />
    );
  const rows = plan.summary?.services || [];
  const copies = plan.summary?.replicatedServices?.length || 0;
  const ready = plan.summary?.applicable && plan.summary?.changed && !plan.blockers?.length;
  const apply = (deploy) => {
    if (!locked && ready) onApply(plan.source, { deploy, summary: plan.summary });
  };
  return (
    <WorkspaceModal title="Protection automatique" wide onClose={onClose}>
      <div className="redundancy-auto">
        <div className="redundancy-auto-heading">
          <ShieldCheck size={28} />
          <div>
            <h2>Protéger les services</h2>
            <p>{hostName} · Réseaux, données et protocoles analysés.</p>
          </div>
        </div>
        <label className="redundancy-auto-count">
          Instances pour les services compatibles
          <select
            value={replicas}
            disabled={locked}
            onChange={(event) => setReplicas(Number(event.target.value))}
          >
            {[2, 3, 4].map((count) => (
              <option key={count} value={count}>
                {count} instances
              </option>
            ))}
          </select>
        </label>
        <div className={'redundancy-auto-services' + (rows.length > 3 ? ' compact' : '')}>
          {rows.map((row) => (
            <article key={row.name} className="redundancy-auto-service">
              <EquipmentIcon kind="server" image={previewModel.services[row.name]?.image} />
              <div>
                <strong>{row.name}</strong>
                <small>{row.reason}</small>
                {(!!row.endpoints?.length || (aiProfile && row.name === 'webui')) && (
                  <small>
                    {aiProfile && row.name === 'webui' ? 'HTTP détecté · sonde /health · connexions préparées' : row.endpoints
                      .map(
                        (endpoint) =>
                          `${endpoint.hostIp ? endpoint.hostIp + ':' : ''}${endpoint.publishedPort} · ${endpoint.protocol === 'http' ? 'HTTP détecté · sonde ' + endpoint.healthPath : 'TCP / HTTPS'}`,
                      )
                      .join(' · ')}
                  </small>
                )}
              </div>
              <span className={'redundancy-auto-badge ' + row.strategy}>
                {row.strategy === 'replicas' ? (
                  <>
                    <Copy size={14} />
                    {row.instances} instances
                  </>
                ) : row.strategy === 'restart' ? (
                  <>
                    <RefreshCw size={14} />
                    Relance automatique
                  </>
                ) : (
                  'Conservé'
                )}
              </span>
            </article>
          ))}
        </div>
        <p className="redundancy-auto-result" role="status">
          {copies
            ? `${copies} service(s) multiplié(s). Les clients conservent la même adresse.`
            : 'Aucun service multiplié. Cette configuration prévoit uniquement la relance automatique.'}
        </p>
        <p className="field-hint">
          {aiProfile ? 'Les bases et le moteur GPU restent en une instance. Les fichiers WebUI sont partagés.' : 'Les données et le GPU restent attachés à une seule instance.'} Une panne du serveur coupe toutes les instances.
        </p>
        {aiProfile && !model[AI_REDUNDANCY_EXTENSION] && <p className="field-hint">Installation neuve : Redis et Qdrant seront ajoutés. L’absence de données sera vérifiée avant application.</p>}
        {!ready && !plan.blockers?.length && (
          <p role="status">Cette protection est déjà configurée.</p>
        )}
        {!!plan.blockers?.length && (
          <p className="compose-error" role="alert">
            {plan.blockers[0].message}
          </p>
        )}
        <details className="redundancy-details">
          <summary>Détails et réglages avancés</summary>
          <p>
            La relance intervient après l'arrêt du processus. Un arrêt manuel et un conteneur
            seulement « unhealthy » ne déclenchent pas de recréation.
          </p>
          <p>
            {BROWSER_MODE
              ? 'Ces réglages modifient le fichier Compose dans cet onglet. Leur fonctionnement réel reste à vérifier avec Docker Tracer local.'
              : 'Le récapitulatif suivant vérifie Compose avant toute application. Un changement de ports ou de réseaux peut recréer un conteneur.'}
          </p>
          {!existing && !aiProfile && (
            <button type="button" onClick={() => setAdvanced(true)}>
              Choisir les services et les sondes manuellement
            </button>
          )}
        </details>
        <div className="redundancy-actions">
          <button type="button" disabled={locked} onClick={onClose}>
            Annuler
          </button>
          {!BROWSER_MODE && <button type="button" disabled={locked || !ready} onClick={() => apply(false)}>
            Garder en brouillon
          </button>}
          <button
            type="button"
            className="deploy-button"
            disabled={locked || !ready}
            onClick={() => apply(true)}
          >
            {BROWSER_MODE ? 'Appliquer au fichier' : 'Vérifier et activer'}
          </button>
        </div>
      </div>
    </WorkspaceModal>
  );
}
