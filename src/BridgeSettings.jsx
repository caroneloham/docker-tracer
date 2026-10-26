import React from 'react';
import { bridgeSchema, BRIDGE_RESTART_MESSAGE } from '../shared/bridge.mjs';
export default function BridgeSettings({ data, onChange, available = true }) {
  const b = { ...bridgeSchema.parse(undefined), ...data.bridge },
    set = (key, value) => onChange('bridge', { ...b, [key]: value });
  return (
    <>
      <p className="field-hint">
        Ce bridge relie les services du même serveur. Configure ici ses adresses et les
        communications autorisées ; relie ensuite les équipements sur la carte.
      </p>
      <label>
        Sous-réseau IPv4
        <input
          placeholder="Automatique · ex. 172.28.0.0/24"
          value={data.subnet}
          onChange={(e) => onChange('subnet', e.target.value)}
        />
      </label>
      <label>
        Accès vers l’extérieur
        <select
          value={data.internal ? 'internal' : 'standard'}
          onChange={(e) => onChange('internal', e.target.value === 'internal')}
        >
          <option value="standard">Standard · sorties autorisées par ce réseau</option>
          <option value="internal">Isolé · aucune sortie par ce réseau</option>
        </select>
      </label>
      <p className="field-hint">
        Un service relié à un autre réseau peut garder une sortie extérieure. Les ports publiés et
        le pare-feu se règlent séparément.
      </p>
      {!available && (
        <p className="field-hint" role="status">
          {BRIDGE_RESTART_MESSAGE}
        </p>
      )}
      <fieldset className="bridge-settings" disabled={!available}>
        <details open>
          <summary>Nom et couleur sur la carte</summary>
          <label>
            Nom affiché
            <input
              maxLength={60}
              placeholder={data.label}
              value={b.label}
              onChange={(e) => set('label', e.target.value)}
            />
          </label>
          <label>
            Usage / notes
            <input
              maxLength={140}
              placeholder="Ex. accès privé à la base de données"
              value={b.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
          <label>
            Couleur du réseau
            <select value={b.color} onChange={(e) => set('color', e.target.value)}>
              <option value="">Classique</option>
              <option value="#2475a7">Bleu</option>
              <option value="#398357">Vert</option>
              <option value="#c0782b">Orange</option>
              <option value="#9a568c">Violet</option>
              <option value="#ab4d4d">Rouge</option>
            </select>
          </label>
        </details>
        <details>
          <summary>Adresses et passerelle</summary>
          <p className="field-hint">
            Sans sous-réseau imposé, Docker choisit les adresses. Pour une IP fixe, définis une
            plage puis règle l’interface du service.
          </p>
          <label>
            Passerelle IPv4
            <input
              value={b.gateway}
              placeholder="Première adresse par défaut"
              onChange={(e) => set('gateway', e.target.value)}
            />
          </label>
          <label>
            Plage d’attribution IPv4
            <input
              value={b.ipRange}
              placeholder="Facultatif · ex. 172.28.0.128/25"
              onChange={(e) => set('ipRange', e.target.value)}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={b.ipv6}
              onChange={(e) =>
                onChange('bridge', {
                  ...b,
                  ipv6: e.target.checked,
                  ...(e.target.checked ? {} : { ipv6Subnet: '' }),
                })
              }
            />
            Activer IPv6
          </label>
          {b.ipv6 && (
            <label>
              Sous-réseau IPv6
              <input
                value={b.ipv6Subnet}
                placeholder="Automatique · ex. fd42:1234::/64"
                onChange={(e) => set('ipv6Subnet', e.target.value)}
              />
            </label>
          )}
        </details>
        <details>
          <summary>Réglages avancés du bridge</summary>
          <label>
            Taille maximale des paquets (MTU)
            <input
              type="number"
              min={b.ipv6 ? 1280 : 576}
              max="65535"
              value={b.mtu ?? ''}
              placeholder="Automatique"
              onChange={(e) => set('mtu', e.target.value ? Number(e.target.value) : null)}
            />
          </label>
          {[
            ['icc', 'Communication directe entre conteneurs'],
            ['masquerade', 'Traduction des adresses en sortie (NAT)'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <select
                value={b[key] === null ? '' : String(b[key])}
                onChange={(e) => set(key, e.target.value === '' ? null : e.target.value === 'true')}
              >
                <option value="">Valeur Docker par défaut</option>
                <option value="true">Autorisée</option>
                <option value="false">Désactivée</option>
              </select>
            </label>
          ))}
          <p className="field-hint">
            Désactiver la communication directe peut couper les échanges entre services. Désactiver
            le NAT demande un routage adapté.
          </p>
        </details>
      </fieldset>
      <p className="field-hint">
        Le nom affiché et la couleur modifient le dessin. Les autres réglages remplacent le bridge
        après aperçu, avec interruption des services concernés et conservation des volumes.
      </p>
    </>
  );
}
