import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Cable,
  CheckCircle2,
  Network,
  Plus,
  SlidersHorizontal,
  Unplug,
} from 'lucide-react';
import { WorkspaceModal } from './WorkspacePanels.jsx';
import { BROWSER_MODE } from './browser-mode.js';
import EquipmentIcon from './EquipmentIcon.jsx';
import { composeDocument } from '../shared/compose-project.mjs';
import {
  applyComposeConnection,
  composeConnectionChanges,
  connectionNetworkChoices,
  serviceNetworks,
  suggestedConnectionNetworkName,
} from '../shared/compose-connections.mjs';

export default function ComposeConnectionDialog({ source, target, locked, onClose, onApply }) {
  const model = useMemo(() => composeDocument(source).model, [source]);
  const choices = connectionNetworkChoices(model, target.services);
  const initialNetwork = target.network || choices[0]?.name || '__new__';
  const fieldsFor = (network) =>
    Object.fromEntries(
      target.services.map((service) => {
        const options = serviceNetworks(model.services[service])[network] || {};
        return [
          service,
          {
            aliases: (options.aliases || []).join(', '),
            ipv4_address: options.ipv4_address || '',
            ipv6_address: options.ipv6_address || '',
          },
        ];
      }),
    );
  const [network, setNetwork] = useState(initialNetwork);
  const [newName, setNewName] = useState(() =>
    suggestedConnectionNetworkName(model, target.services),
  );
  const [settings, setSettings] = useState(() => fieldsFor(initialNetwork));
  const [disconnect, setDisconnect] = useState(false);
  const [detachedService, setDetachedService] = useState(target.services[0]);
  const [advanced, setAdvanced] = useState(false);
  const selectedNetwork = network === '__new__' ? newName.trim() : network;
  const connected =
    network !== '__new__' &&
    target.services.every((name) => Object.hasOwn(serviceNetworks(model.services[name]), network));
  const affectedServices = disconnect ? [detachedService] : target.services;
  const isolated = affectedServices.filter(
    (name) =>
      Object.keys(serviceNetworks(model.services[name])).filter((name) => name !== selectedNetwork)
        .length === 0,
  );
  const peers = Object.entries(model.services)
    .filter(([, service]) => Object.hasOwn(serviceNetworks(service), selectedNetwork))
    .map(([name]) => name);
  const selectNetwork = (name) => {
    setNetwork(name);
    setSettings(fieldsFor(name));
    setDisconnect(false);
  };
  let nextSource = '',
    changes = [],
    error = '';
  try {
    nextSource = applyComposeConnection(source, {
      services: affectedServices,
      network: selectedNetwork,
      create: network === '__new__',
      disconnect,
      settings: Object.fromEntries(
        Object.entries(settings).map(([service, fields]) => [
          service,
          {
            aliases: [
              ...new Set(
                fields.aliases
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ],
            ipv4_address: fields.ipv4_address.trim(),
            ipv6_address: fields.ipv6_address.trim(),
          },
        ]),
      ),
    });
    changes = composeConnectionChanges(source, nextSource);
  } catch (e) {
    error = e.message;
  }
  const apply = (deploy) => {
    if (!locked && !error && changes.length) onApply(nextSource, changes, { deploy });
  };
  const endpoint = (name, kind, label) => (
    <div className="compose-connection-endpoint">
      <span aria-hidden="true">
        <EquipmentIcon
          kind={kind === 'network' ? 'network' : 'server'}
          image={kind === 'service' ? model.services[name]?.image : undefined}
        />
      </span>
      <div>
        <small>{label}</small>
        <strong>{name}</strong>
        <span>{kind === 'network' ? 'Réseau Docker' : 'Service du projet'}</span>
      </div>
    </div>
  );
  const optionText = (choice) =>
    choice.common
      ? target.services.length > 1
        ? 'Déjà partagé par ces services'
        : `Déjà utilisé par ${target.services[0]}`
      : choice.usedBy.length
        ? `Utilisé par ${choice.usedBy.join(' et ')}`
        : 'Disponible dans ce projet';
  return (
    <WorkspaceModal title="Connecter les équipements" onClose={onClose}>
      <div className="compose-connection-dialog">
        <div
          className="compose-connection-route"
          aria-label={`Connexion de ${target.services[0]} vers ${target.services[1] || target.network}`}
        >
          {endpoint(target.services[0], 'service', 'Source')}
          <ArrowRight className="compose-connection-direction" size={22} aria-hidden="true" />
          {endpoint(
            target.services[1] || target.network,
            target.services[1] ? 'service' : 'network',
            'Destination',
          )}
        </div>
        <p className="compose-connection-intro">
          Choisis leur réseau commun. Les autres connexions sont conservées.
        </p>
        <fieldset disabled={locked} className="compose-connection-controls">
          <legend>Réseau de la connexion</legend>
          <div className="compose-network-options">
            {(target.network
              ? choices.filter((choice) => choice.name === target.network)
              : choices
            ).map((choice, index) => (
              <label
                key={choice.name}
                className={`compose-network-option ${network === choice.name ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="compose-connection-network"
                  value={choice.name}
                  checked={network === choice.name}
                  onChange={() => selectNetwork(choice.name)}
                  aria-label={`Réseau ${choice.name}, ${optionText(choice)}`}
                />
                <Network size={20} aria-hidden="true" />
                <span>
                  <strong>{choice.name}</strong>
                  <small>{optionText(choice)}</small>
                </span>
                {(choice.common || index === 0) && (
                  <em>
                    {choice.common
                      ? target.services.length > 1
                        ? 'Commun'
                        : 'Connecté'
                      : 'Suggéré'}
                  </em>
                )}
              </label>
            ))}
            {!target.network && (
              <label
                className={`compose-network-option ${network === '__new__' ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="compose-connection-network"
                  value="__new__"
                  checked={network === '__new__'}
                  onChange={() => selectNetwork('__new__')}
                  aria-label="Créer un nouveau réseau pour cette liaison"
                />
                <Plus size={20} aria-hidden="true" />
                <span>
                  <strong>Nouveau réseau</strong>
                  <small>Créer une liaison dédiée</small>
                </span>
              </label>
            )}
          </div>
          {network === '__new__' && (
            <label className="compose-new-network-name">
              Nom de la liaison
              <input
                aria-label="Nom du nouveau réseau"
                value={newName}
                maxLength={63}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
          )}
          {connected && (
            <div className={`compose-connection-existing ${disconnect ? 'is-disconnecting' : ''}`}>
              <p>
                <CheckCircle2 size={16} aria-hidden="true" />
                <strong>Connexion déjà présente dans le projet</strong>
              </p>
              <p>Réseau partagé par {peers.join(', ')}.</p>
              <div className="compose-connection-actions">
                <button
                  type="button"
                  aria-pressed={!disconnect}
                  onClick={() => {
                    setDisconnect(false);
                    setAdvanced(true);
                  }}
                >
                  <SlidersHorizontal size={14} /> Modifier les options
                </button>
                <button type="button" aria-pressed={disconnect} onClick={() => setDisconnect(true)}>
                  <Unplug size={14} />
                  {target.services.length > 1
                    ? 'Retirer un branchement'
                    : `Déconnecter de ${selectedNetwork}`}
                </button>
              </div>
              {disconnect && target.services.length > 1 && (
                <label className="compose-detach-service">
                  Service à retirer de {selectedNetwork}
                  <select
                    aria-label="Service à déconnecter"
                    value={detachedService}
                    onChange={(event) => setDetachedService(event.target.value)}
                  >
                    {target.services.map((service) => (
                      <option key={service} value={service}>
                        {service}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          {!disconnect && (
            <details
              className="compose-connection-advanced"
              open={advanced}
              onToggle={(event) => setAdvanced(event.currentTarget.open)}
            >
              <summary>
                <SlidersHorizontal size={14} aria-hidden="true" /> Réglages avancés{' '}
                <span>IP et alias</span>
              </summary>
              <p className="field-hint">
                Les IP restent automatiques si les champs sont vides. Une IP fixe demande une plage
                adaptée sur ce réseau.
              </p>
              {target.services.map((service) => (
                <section className="compose-field-group" key={service}>
                  <h3>{service}</h3>
                  <div className="compose-connection-fields">
                    {[
                      ['aliases', 'Alias réseau', 'Ex. api, backend'],
                      ['ipv4_address', 'IPv4 fixe', 'Automatique'],
                      ['ipv6_address', 'IPv6 fixe', 'Automatique'],
                    ].map(([key, label, placeholder]) => (
                      <label key={key}>
                        {label}
                        <input
                          aria-label={`${label} de ${service}`}
                          placeholder={placeholder}
                          value={settings[service][key]}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              [service]: { ...settings[service], [key]: event.target.value },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </details>
          )}
          {!disconnect &&
            target.services.some((name) => model.services[name].network_mode === 'none') && (
              <p className="field-hint">
                La connexion réactive le réseau des services actuellement isolés.
              </p>
            )}
          {disconnect && (
            <p className="compose-connection-disconnect-note">
              {detachedService} perdra l’accès à tous les services de {selectedNetwork}.
              {isolated.length > 0 &&
                ` Ce dernier branchement sera retiré : ${detachedService} n’aura plus de réseau.`}{' '}
              Les autres services restent connectés.
            </p>
          )}
          {error ? (
            <p className="compose-error" role="alert">
              {error}
            </p>
          ) : (
            <section className="compose-connection-preview" aria-label="Changements de connexion">
              <strong>
                {changes.length ? 'Ce qui va changer' : 'Aucune modification nécessaire'}
              </strong>
              {changes.length > 0 ? (
                <ul>
                  {changes.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  Tu peux modifier les options, choisir un autre réseau ou retirer un branchement.
                </p>
              )}
            </section>
          )}
          <p className="compose-connection-next">
            {BROWSER_MODE
              ? 'La connexion sera modifiée dans le brouillon Compose de cet onglet.'
              : disconnect
              ? 'Vérifie les effets de la déconnexion avant de l’appliquer à Docker.'
              : 'La prochaine étape vérifie les changements avant leur application à Docker.'}
          </p>
          <div className="compose-connection-submit">
            <button type="button" onClick={onClose}>
              Annuler
            </button>
            {!BROWSER_MODE && <button
              type="button"
              disabled={!!error || !changes.length}
              onClick={() => apply(false)}
            >
              Garder en brouillon
            </button>}
            <button
              type="button"
              className={disconnect ? 'danger-button' : 'deploy-button'}
              disabled={!!error || !changes.length}
              onClick={() => apply(true)}
            >
              {disconnect ? <Unplug size={15} /> : <Cable size={15} />}
              {BROWSER_MODE ? 'Appliquer au fichier' : disconnect ? 'Vérifier et déconnecter' : 'Vérifier et connecter'}
            </button>
          </div>
        </fieldset>
      </div>
    </WorkspaceModal>
  );
}
