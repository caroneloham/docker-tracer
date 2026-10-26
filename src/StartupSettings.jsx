import React from 'react';
import { startupSchema, startupLabels } from '../shared/startup.mjs';
export default function StartupSettings({ data, onChange, available = true }) {
  const s = { ...startupSchema.parse(undefined), ...data.startup };
  const field = (key, value) => onChange('startup', { ...s, [key]: value });
  if (!available)
    return (
      <p role="status" className="field-hint">
        Redémarre Docker Tracer pour activer les contrôles de démarrage. Le serveur ouvert ne les
        prend pas encore en charge.
      </p>
    );
  return (
    <>
      <p className="field-hint">
        Vérifie le service après sa création ou son remplacement, avant de supprimer son ancienne
        version. En cas d’échec, Docker Tracer tente de la restaurer.
      </p>
      <label>
        Contrôle de démarrage
        <select
          value={s.mode}
          onChange={(e) =>
            onChange('startup', {
              ...s,
              mode: e.target.value,
              timeoutSeconds:
                e.target.value === 'health' ? Math.max(60, s.timeoutSeconds) : s.timeoutSeconds,
            })
          }
        >
          {Object.entries(startupLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {s.mode !== 'none' && (
        <label>
          Délai maximal (secondes)
          <input
            type="number"
            min={5}
            max={120}
            value={s.timeoutSeconds}
            onChange={(e) => field('timeoutSeconds', Number(e.target.value))}
          />
        </label>
      )}
      {['tcp', 'http'].includes(s.mode) && (
        <label>
          Port à vérifier dans le conteneur
          <input
            type="number"
            min={1}
            max={65535}
            value={s.port}
            onChange={(e) => field('port', Number(e.target.value))}
          />
        </label>
      )}
      {s.mode === 'http' && (
        <>
          <label>
            Chemin HTTP
            <input
              maxLength={1024}
              value={s.path}
              onChange={(e) => field('path', e.target.value)}
              placeholder="/health"
            />
          </label>
          <label>
            Statut HTTP attendu
            <input
              type="number"
              min={100}
              max={599}
              value={s.expectedStatus}
              onChange={(e) => field('expectedStatus', Number(e.target.value))}
            />
          </label>
        </>
      )}
      <p className="field-hint">
        {
          {
            none: 'Aucun test supplémentaire. Convient aussi aux tâches ponctuelles qui se terminent normalement.',
            running:
              'Le processus doit rester en marche pendant au moins deux secondes. Cela ne prouve pas que l’application répond.',
            health:
              'Utilise le HEALTHCHECK fourni par l’image. Sans contrôle actif dans l’image, le résultat est non concluant.',
            tcp: 'Une sonde temporaire vérifie 127.0.0.1 dans le même espace réseau. Un port ouvert ne valide pas les identifiants de l’application.',
            http: 'Une sonde temporaire envoie un GET HTTP à 127.0.0.1 dans le même espace réseau. Aucun shell n’est nécessaire dans ton image ; les redirections ne sont pas suivies.',
          }[s.mode]
        }
      </p>
      <p className="field-hint">
        Les services sont tous démarrés avant les tests. Un service déjà arrêté reste arrêté et ne
        subit pas ce contrôle. Le résultat est conservé dans « Déploiements ». Il ne s’agit pas
        d’une surveillance permanente.
      </p>
    </>
  );
}
