import React, { useEffect, useState } from 'react';
import { HardDrive, Plus } from 'lucide-react';
import EquipmentIcon from './EquipmentIcon.jsx';
import { WorkspaceModal } from './WorkspacePanels.jsx';
import { ROUTER_IMAGE, routerNetworks } from '../shared/compose-equipment.mjs';
import './compose-equipment.css';
import { BROWSER_MODE } from './browser-mode.js';

const titles = {
  service: 'Ajouter un service',
  switch: 'Ajouter un switch',
  router: 'Ajouter un routeur',
  volume: 'Ajouter un volume',
};

export default function ComposeEquipmentPalette({
  model,
  disabled,
  onService,
  onAdd,
  onSelectVolume,
  dropRequest,
}) {
  const [kind, setKind] = useState(null);
  const [name, setName] = useState('');
  const [subnet, setSubnet] = useState('');
  const [internal, setInternal] = useState(false);
  const [connections, setConnections] = useState({});
  const [error, setError] = useState('');
  const [placement, setPlacement] = useState(null);
  const available = routerNetworks(model);
  const open = (next, position = null) => {
    setKind(next);
    setPlacement(position);
    setName('');
    setSubnet('');
    setInternal(false);
    setConnections({});
    setError('');
  };
  useEffect(() => {
    if (dropRequest) open(dropRequest.kind, dropRequest.position);
  }, [dropRequest?.id]);
  const startDrag = (event, item) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData('application/x-docker-tracer-equipment', item);
    event.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <>
      <footer className="compose-palette compose-equipment-palette">
        <fieldset disabled={disabled} aria-label="Ajouter à la carte">
          <div className="compose-equipment-actions">
            {[
              ['service', 'server', 'Image Docker'],
              ['switch', 'network', 'Bridge Docker virtuel'],
              ['router', 'router', 'Conteneur Linux'],
            ].map(([item, icon, detail]) => (
              <button key={item} type="button" draggable={!disabled}
                onDragStart={(event) => startDrag(event, item)} onClick={() => open(item)}>
                <EquipmentIcon kind={icon} />
                <span>
                  <strong>{titles[item]}</strong>
                  <small>{detail}</small>
                </span>
                <Plus size={16} />
              </button>
            ))}
          </div>
        </fieldset>
        <div className="compose-volume-list">
          <button type="button" disabled={disabled} draggable={!disabled}
            onDragStart={(event) => startDrag(event, 'volume')} onClick={() => open('volume')}>
            <HardDrive size={14} /> Ajouter un volume
          </button>
          {Object.keys(model.volumes || {}).map((volume) => (
            <button key={volume} type="button" onClick={() => onSelectVolume(volume)}>
              Volume · {volume}
            </button>
          ))}
        </div>
        <small className="compose-palette-drag-hint">Glisse un équipement sur la carte, ou clique pour l’ajouter.</small>
      </footer>
      {kind && (
        <WorkspaceModal title={titles[kind]} onClose={() => setKind(null)}>
          <form
            className="compose-equipment-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              try {
                if (kind === 'service') onService(name.trim(), placement);
                else onAdd(kind, { name, subnet, internal, networks: connections }, placement);
                setKind(null);
              } catch (failure) {
                setError(failure.message);
              }
            }}
          >
            <fieldset disabled={disabled}>
              <label>
                {kind === 'service' ? 'Nom du service (facultatif)' : 'Nom'}
                <input
                  autoFocus
                  required={kind !== 'service'}
                  pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}"
                  maxLength={63}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    kind === 'switch'
                      ? 'frontend'
                      : kind === 'router'
                        ? 'routeur'
                        : kind === 'volume'
                          ? 'donnees'
                          : 'Nom proposé depuis l’image'
                  }
                />
              </label>
              {kind === 'switch' && (
                <>
                  <p>
                    {BROWSER_MODE
                      ? 'Un switch représente un réseau bridge déclaré dans le Compose. Relie ses connecteurs aux services de la carte.'
                      : 'Un switch représente un réseau bridge Docker sur ce serveur. Relie ensuite ses connecteurs aux services de la carte.'}
                  </p>
                  <label>
                    Sous-réseau IPv4 (facultatif)
                    <input
                      value={subnet}
                      onChange={(event) => setSubnet(event.target.value)}
                      placeholder="172.30.10.0/24"
                    />
                  </label>
                  <p className="field-hint">
                    Laisse vide pour l’attribution automatique. Définis un sous-réseau pour pouvoir
                    fixer les IP du routeur et des services.
                  </p>
                  <label className="compose-check">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(event) => setInternal(event.target.checked)}
                    />
                    Isoler ce réseau des sorties extérieures
                  </label>
                  <p className="field-hint">
                    Les autres réglages du bridge sont accessibles après l’ajout, dans la
                    configuration du switch.
                  </p>
                </>
              )}
              {kind === 'router' && (
                <>
                  <p>
                    {BROWSER_MODE
                      ? 'Choisis au moins deux switches. Le fichier Compose déclarera une interface du routeur sur chaque réseau sélectionné.'
                      : 'Choisis au moins deux switches. Docker créera une interface du routeur sur chacun des réseaux sélectionnés.'}
                  </p>
                  <div className="compose-router-networks">
                    {available.map((network) => {
                      const checked = Object.hasOwn(connections, network.name);
                      return (
                        <div key={network.name} className="compose-router-interface">
                          <label className="compose-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) =>
                                setConnections((current) => {
                                  const next = { ...current };
                                  if (event.target.checked) next[network.name] = '';
                                  else delete next[network.name];
                                  return next;
                                })
                              }
                            />
                            {network.name} · bridge Docker
                          </label>
                          {checked &&
                            (network.pools.length ? (
                              <label>
                                IPv4 du routeur sur {network.name} (facultative)
                                <input
                                  value={connections[network.name]}
                                  onChange={(event) =>
                                    setConnections({
                                      ...connections,
                                      [network.name]: event.target.value,
                                    })
                                  }
                                  placeholder="Automatique si vide"
                                />
                                <small>
                                  {network.pools.map((pool) => pool.subnet).join(' · ')}
                                </small>
                              </label>
                            ) : (
                              <p className="field-hint">
                                IP automatique. Configure un sous-réseau dans ce switch pour
                                utiliser une IP fixe.
                              </p>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                  {available.length < 2 && (
                    <p role="status">
                      Ajoute d’abord deux switches ou complète ceux déjà présents. Ce formulaire
                      utilise les bridges déclarés dans le Compose ; les réseaux externes se
                      configurent dans le YAML.
                    </p>
                  )}
                  <div className="compose-router-details">
                    <strong>Configuration du conteneur</strong>
                    <p>
                      <code>{ROUTER_IMAGE}</code> · droit <code>NET_ADMIN</code> · transfert IPv4{' '}
                      <code>net.ipv4.ip_forward=1</code> dans le conteneur.
                    </p>
                    <p>
                      Les routes aller et retour des clients restent à configurer vers les IP du
                      routeur. Aucune route de l’hôte, du LAN ou d’un autre serveur n’est créée. Le
                      démarrage du conteneur ne vérifie pas les échanges.
                    </p>
                  </div>
                </>
              )}
              {error && (
                <p role="alert" className="compose-error">
                  {error}
                </p>
              )}
              <p className="field-hint">
                {BROWSER_MODE
                  ? 'Ajout au brouillon YAML uniquement. Exporte le fichier pour conserver ce projet.'
                  : 'Ajout au brouillon uniquement. Vérifie les modifications avant de déployer sur Docker.'}
              </p>
              <div className="compose-buttons">
                <button type="button" onClick={() => setKind(null)}>
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={kind === 'router' && Object.keys(connections).length < 2}
                >
                  <Plus size={15} />{' '}
                  {kind === 'service' ? 'Choisir une image Docker' : 'Ajouter au brouillon'}
                </button>
              </div>
            </fieldset>
          </form>
        </WorkspaceModal>
      )}
    </>
  );
}
