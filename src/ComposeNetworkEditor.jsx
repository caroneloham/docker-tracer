import React from 'react';
import { Network, Plus, X } from 'lucide-react';
import { composeServiceNetworks } from '../shared/compose-project.mjs';

export default function ComposeNetworkEditor({ name, value, model, runtime, set }) {
  const visual = value['x-docker-tracer'] || {},
    bridge = !value.driver || value.driver === 'bridge';
  const members = Object.entries(model.services || {}).filter(
    ([, s]) => Object.hasOwn(composeServiceNetworks(s), name),
  );
  const pools = value.ipam?.config || [];
  const updatePools = (next) =>
    set('ipam', { ...value.ipam, config: next.length ? next : undefined });
  const option = (key, v) => {
    const next = { ...value.driver_opts };
    if (v === '') delete next[key];
    else next[key] = String(v);
    set('driver_opts', Object.keys(next).length ? next : undefined);
  };
  return (
    <>
      <h2>
        <Network size={17} /> Réseau · {visual.label || name}
      </h2>
      <p className="compose-network-help">
        Un réseau relie les services d’un même serveur Docker. Les noms et alias permettent de les
        joindre sans connaître leur IP.
      </p>
      <section className="compose-field-group">
        <h3>Reconnaître ce réseau</h3>
        <label>
          Nom sur la carte
          <input
            maxLength={60}
            placeholder={name}
            value={visual.label || ''}
            onChange={(e) => set('x-docker-tracer', { ...visual, label: e.target.value })}
          />
        </label>
        <label>
          Usage / notes
          <input
            maxLength={140}
            placeholder="Ex. liaison privée entre le site et sa base"
            value={visual.description || ''}
            onChange={(e) => set('x-docker-tracer', { ...visual, description: e.target.value })}
          />
        </label>
        <label>
          Couleur du réseau
          <select
            value={visual.color || ''}
            onChange={(e) => set('x-docker-tracer', { ...visual, color: e.target.value })}
          >
            <option value="">Classique</option>
            <option value="#2475a7">Bleu</option>
            <option value="#398357">Vert</option>
            <option value="#c0782b">Orange</option>
            <option value="#9a568c">Violet</option>
            <option value="#ab4d4d">Rouge</option>
          </select>
        </label>
        <p className="compose-network-help">
          Identifiant Compose : <code>{name}</code>. Le nom affiché et la couleur ne changent pas
          ses connexions.
        </p>
      </section>
      <section className="compose-field-group">
        <h3>{members.length} service(s) connecté(s)</h3>
        {members.map(([service]) => (
          <div className="compose-network-member" key={service}>
            <strong>{service}</strong>
            <span>
              {(runtime[service] || []).filter((i) => i.state === 'running').length} en marche
            </span>
          </div>
        ))}
        {!members.length && (
          <p className="compose-network-help">
            Relie un service à ce réseau sur la carte, ou sélectionne-le dans les réglages du
            service.
          </p>
        )}
      </section>
      <label className="compose-check">
        <input
          type="checkbox"
          checked={!!value.external}
          onChange={(e) => set('external', e.target.checked || undefined)}
        />
        Utiliser un réseau Docker déjà existant
      </label>
      <label>
        Nom Docker{value.external ? ' du réseau existant' : ' (facultatif)'}
        <input
          value={value.name || ''}
          placeholder={value.external ? name : 'Généré avec le nom du projet'}
          onChange={(e) => set('name', e.target.value || undefined)}
        />
      </label>
      {value.external && (
        <p className="compose-network-help">
          Docker Tracer réutilisera ce réseau. Sa configuration appartient au serveur ; retire les
          éventuelles options de création du fichier Compose avant l’aperçu.
        </p>
      )}
      <fieldset disabled={!!value.external} className="compose-network-fields">
        <label>
          Type de réseau
          <select value={value.driver || 'bridge'} onChange={(e) => set('driver', e.target.value)}>
            <option value="bridge">Bridge · réseau entre conteneurs du serveur</option>
            {value.driver && value.driver !== 'bridge' && (
              <option value={value.driver}>{value.driver} · pilote du fichier importé</option>
            )}
          </select>
        </label>
        <label>
          Accès vers l’extérieur
          <select
            value={value.internal ? 'internal' : 'standard'}
            onChange={(e) => set('internal', e.target.value === 'internal' || undefined)}
          >
            <option value="standard">Standard · sorties autorisées par ce réseau</option>
            <option value="internal">Isolé · aucune sortie par ce réseau</option>
          </select>
        </label>
        <p className="compose-network-help">
          Un service connecté à un autre réseau peut conserver un accès extérieur. Les ports publiés
          et le pare-feu se règlent séparément.
        </p>
        <section className="compose-field-group">
          <h3>Adresses des conteneurs</h3>
          <p className="compose-network-help">
            Sans plage imposée, Docker attribue les adresses automatiquement. Les IP fixes se
            règlent dans chaque service.
          </p>
          {pools.map((pool, i) => (
            <div className="compose-network-pool" key={i}>
              <strong>Plage {i + 1}</strong>
              <button
                aria-label={`Retirer la plage ${i + 1}`}
                type="button"
                onClick={() => updatePools(pools.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
              {[
                ['subnet', 'Sous-réseau CIDR', '172.30.10.0/24'],
                ['gateway', 'Passerelle (facultative)', '172.30.10.1'],
                ['ip_range', 'Plage d’attribution (facultative)', '172.30.10.128/25'],
              ].map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <input
                    value={pool[key] || ''}
                    placeholder={placeholder}
                    onChange={(e) =>
                      updatePools(
                        pools.map((p, j) =>
                          j === i ? { ...p, [key]: e.target.value || undefined } : p,
                        ),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ))}
          <button type="button" onClick={() => updatePools([...pools, {}])}>
            <Plus size={13} />
            Définir une plage d’adresses
          </button>
          <label className="compose-check">
            <input
              type="checkbox"
              checked={!!value.enable_ipv6}
              onChange={(e) => set('enable_ipv6', e.target.checked || undefined)}
            />
            Activer les adresses IPv6
          </label>
        </section>
        {bridge && (
          <details className="compose-field-group">
            <summary>Réglages avancés du bridge</summary>
            <label>
              Taille maximale des paquets (MTU)
              <input
                type="number"
                min="0"
                max="65535"
                placeholder="Automatique"
                value={value.driver_opts?.['com.docker.network.driver.mtu'] || ''}
                onChange={(e) => option('com.docker.network.driver.mtu', e.target.value)}
              />
            </label>
            {[
              [
                'com.docker.network.bridge.enable_icc',
                'Communication directe entre les conteneurs',
              ],
              [
                'com.docker.network.bridge.enable_ip_masquerade',
                'Traduction des adresses pour les sorties (NAT)',
              ],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <select
                  value={
                    value.driver_opts?.[key] === undefined ? '' : String(value.driver_opts[key])
                  }
                  onChange={(e) => option(key, e.target.value)}
                >
                  <option value="">Valeur Docker par défaut</option>
                  <option value="true">Autorisée</option>
                  <option value="false">Désactivée</option>
                </select>
              </label>
            ))}
            <p className="compose-network-help">
              Désactiver la communication directe peut casser les échanges entre services. Sans NAT,
              les sorties nécessitent un routage adapté.
            </p>
          </details>
        )}
      </fieldset>
      <p className="compose-network-help">
        Les changements sont enregistrés dans le brouillon. Modifier un réseau déjà utilisé peut
        nécessiter de recréer le réseau et les conteneurs concernés ; vérifie l’aperçu avant
        application.
      </p>
    </>
  );
}
