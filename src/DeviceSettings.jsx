import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import ConfigurationFiles from './ConfigurationFiles.jsx';
import StartupSettings from './StartupSettings.jsx';
import BridgeSettings from './BridgeSettings.jsx';
import { CONFIGURATION_RESTART_MESSAGE } from '../shared/configuration.mjs';

const RowRemove = ({ label, onClick }) => (
  <button type="button" className="icon-btn" aria-label={label} onClick={onClick}>
    <X size={13} />
  </button>
);

export default function DeviceSettings({
  data: d,
  onChange: field,
  disabled = false,
  showName = true,
  topology,
  node,
  onTopologyChange,
  filesAvailable = true,
  startupAvailable = true,
  bridgesAvailable = true,
}) {
  const [tab, setTab] = useState('service'),
    [showValues, setShowValues] = useState(false);
  const env = d.env
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);
  const setEnv = (rows) => field('env', rows.map(([k, v]) => `${k}=${v}`).join('\n'));
  const setPort = (i, patch) =>
    field(
      'ports',
      d.ports.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );
  return (
    <fieldset disabled={disabled} className="device-settings">
      {showName && (
        <label>
          Nom de l’équipement
          <input
            value={d.label}
            maxLength={48}
            onChange={(e) => field('label', e.target.value)}
            spellCheck="false"
          />
        </label>
      )}
      {d.kind === 'network' ? (
        <BridgeSettings data={d} onChange={field} available={bridgesAvailable} />
      ) : (
        <>
          <div className="settings-tabs" role="tablist" aria-label="Réglages de l’équipement">
            {[
              ['service', 'Service'],
              ['env', 'Variables'],
              ['ports', 'Ports & volumes'],
              ['files', 'Fichiers'],
              ['resources', 'Ressources'],
              ['startup', 'Validation'],
            ].map(([id, title]) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === id}
                key={id}
                onClick={() => setTab(id)}
              >
                {title}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="settings-content">
            {tab === 'startup' && (
              <StartupSettings data={d} onChange={field} available={startupAvailable} />
            )}
            {tab === 'files' && !filesAvailable && (
              <p role="status" className="field-hint">
                {CONFIGURATION_RESTART_MESSAGE}
              </p>
            )}
            {tab === 'files' && filesAvailable && (
              <ConfigurationFiles
                data={d}
                onChange={field}
                topology={topology}
                node={node}
                onTopologyChange={onTopologyChange}
              />
            )}
            {tab === 'service' && (
              <>
                <label>
                  Image Docker
                  <input
                    value={d.image}
                    maxLength={200}
                    placeholder="nginx:alpine"
                    onChange={(e) => field('image', e.target.value)}
                    spellCheck="false"
                  />
                </label>
                <label>
                  Apparence
                  <select value={d.icon} onChange={(e) => field('icon', e.target.value)}>
                    <option value="server">Serveur</option>
                    <option value="terminal">PC Linux</option>
                    <option value="globe">Serveur web</option>
                    <option value="database">Base de données</option>
                  </select>
                </label>
                <label>
                  Après un arrêt
                  <select
                    value={d.restart || 'no'}
                    onChange={(e) => field('restart', e.target.value)}
                  >
                    <option value="no">Redémarrage manuel</option>
                    <option value="unless-stopped">Automatique, sauf arrêt volontaire</option>
                    <option value="always">Toujours redémarrer</option>
                    <option value="on-failure">Redémarrer en cas d’erreur</option>
                  </select>
                </label>
                <details className="settings-advanced">
                  <summary>
                    Démarrage avancé {d.command ? '· personnalisé' : '· commande de l’image'}
                  </summary>
                  <p className="field-hint">
                    Pour une image applicative comme Nginx ou Redis, laisse ce champ vide. Une
                    commande personnalisée nécessite /bin/sh dans l’image.
                  </p>
                  <label>
                    Commande au démarrage
                    <textarea
                      rows={2}
                      value={d.command}
                      maxLength={4000}
                      onChange={(e) => field('command', e.target.value)}
                      placeholder="Commande de l’image"
                    />
                  </label>
                  {d.command && (
                    <button
                      type="button"
                      className="outline-btn full"
                      onClick={() => field('command', '')}
                    >
                      Utiliser la commande de l’image
                    </button>
                  )}
                </details>
              </>
            )}
            {tab === 'env' && (
              <>
                <p className="field-hint">
                  Configure l’application avec des noms et des valeurs, sans écrire de fichier. Ces
                  valeurs sont enregistrées avec le labo et incluses dans ses exports.
                </p>
                {env.map(([key, value], i) => (
                  <div className="settings-variable" key={i}>
                    <label>
                      Nom {i + 1}
                      <input
                        value={key}
                        maxLength={100}
                        placeholder="PORT"
                        onChange={(e) =>
                          setEnv(env.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))
                        }
                      />
                    </label>
                    <label>
                      Valeur {i + 1}
                      <input
                        type={showValues ? 'text' : 'password'}
                        autoComplete="off"
                        value={value}
                        maxLength={4000}
                        placeholder="3000"
                        onChange={(e) =>
                          setEnv(env.map((r, j) => (j === i ? [r[0], e.target.value] : r)))
                        }
                      />
                    </label>
                    <RowRemove
                      label={`Retirer la variable ${i + 1}`}
                      onClick={() => setEnv(env.filter((_, j) => j !== i))}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="outline-btn full"
                  disabled={env.length >= 50}
                  onClick={() => setEnv([...env, ['', '']])}
                >
                  <Plus size={13} />
                  Ajouter une variable
                </button>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={showValues}
                    onChange={(e) => setShowValues(e.target.checked)}
                  />
                  Afficher les valeurs
                </label>
              </>
            )}
            {tab === 'ports' && (
              <>
                <p className="field-hint">
                  Un port publié rend le service accessible depuis cet ordinateur. Pour ouvrir
                  l’accès au LAN, choisis « Toutes les interfaces ».
                </p>
                {d.ports.map((p, i) => (
                  <div className="settings-card" key={i}>
                    <div className="settings-variable">
                      <label>
                        Port hôte {i + 1}
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={p.host}
                          onChange={(e) => setPort(i, { host: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        Port conteneur {i + 1}
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={p.container}
                          onChange={(e) => setPort(i, { container: Number(e.target.value) })}
                        />
                      </label>
                      <RowRemove
                        label={`Retirer le port ${i + 1}`}
                        onClick={() =>
                          field(
                            'ports',
                            d.ports.filter((_, j) => j !== i),
                          )
                        }
                      />
                    </div>
                    <div className="settings-pair">
                      <label>
                        Protocole {i + 1}
                        <select
                          value={p.protocol || 'tcp'}
                          onChange={(e) => setPort(i, { protocol: e.target.value })}
                        >
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                        </select>
                      </label>
                      <label>
                        Accès {i + 1}
                        <select
                          value={p.hostIp || '127.0.0.1'}
                          onChange={(e) => setPort(i, { hostIp: e.target.value })}
                        >
                          <option value="127.0.0.1">Cet ordinateur</option>
                          <option value="0.0.0.0">Toutes les interfaces</option>
                        </select>
                      </label>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="outline-btn full"
                  disabled={d.ports.length >= 12}
                  onClick={() =>
                    field('ports', [
                      ...d.ports,
                      {
                        host: 8080 + d.ports.length,
                        container: 80,
                        protocol: 'tcp',
                        hostIp: '127.0.0.1',
                      },
                    ])
                  }
                >
                  <Plus size={13} />
                  Ajouter un port
                </button>
                <label>
                  Volume principal · chemin dans le conteneur
                  <input
                    value={d.volume}
                    maxLength={100}
                    placeholder="/data · vide pour désactiver"
                    onChange={(e) => field('volume', e.target.value)}
                  />
                </label>
                {(d.volumes || []).map((m, i) => (
                  <div className="settings-card" key={m.id}>
                    <div className="settings-variable">
                      <label>
                        Volume {i + 2}
                        <input
                          value={m.target}
                          placeholder="/config"
                          onChange={(e) =>
                            field(
                              'volumes',
                              d.volumes.map((v, j) =>
                                j === i ? { ...v, target: e.target.value } : v,
                              ),
                            )
                          }
                        />
                      </label>
                      <RowRemove
                        label={`Retirer le volume ${i + 2}`}
                        onClick={() =>
                          field(
                            'volumes',
                            d.volumes.filter((_, j) => j !== i),
                          )
                        }
                      />
                    </div>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={m.readOnly}
                        onChange={(e) =>
                          field(
                            'volumes',
                            d.volumes.map((v, j) =>
                              j === i ? { ...v, readOnly: e.target.checked } : v,
                            ),
                          )
                        }
                      />
                      Lecture seule
                    </label>
                  </div>
                ))}
                <button
                  type="button"
                  className="outline-btn full"
                  disabled={(d.volumes || []).length >= 8}
                  onClick={() =>
                    field('volumes', [
                      ...(d.volumes || []),
                      {
                        id: `v-${crypto.randomUUID().slice(0, 8)}`,
                        target: '/config',
                        readOnly: false,
                      },
                    ])
                  }
                >
                  <Plus size={13} />
                  Ajouter un volume
                </button>
                <p className="field-hint">
                  Volumes Docker nommés, conservés après remplacement ou suppression du conteneur.
                  Chaque copie d’un équipement possède ses propres volumes.
                </p>
              </>
            )}
            {tab === 'resources' && (
              <>
                <div className="settings-pair">
                  <label>
                    CPU maximum
                    <input
                      type="number"
                      min="0.1"
                      max="64"
                      step="0.1"
                      value={d.cpus ?? 1}
                      onChange={(e) => field('cpus', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Mémoire (Mio)
                    <input
                      type="number"
                      min="16"
                      max="65536"
                      step="16"
                      value={d.memoryMb ?? 512}
                      onChange={(e) => field('memoryMb', Number(e.target.value))}
                    />
                  </label>
                </div>
                <label>
                  Nombre maximum de processus
                  <input
                    type="number"
                    min="16"
                    max="65536"
                    value={d.pidsLimit ?? 256}
                    onChange={(e) => field('pidsLimit', Number(e.target.value))}
                  />
                </label>
                <p className="field-hint">
                  Ces plafonds limitent la consommation du conteneur. Ils ne réservent pas de
                  ressources sur ton ordinateur.
                </p>
                <label>
                  Serveur DNS IPv4 (facultatif)
                  <input
                    placeholder="DNS Docker par défaut"
                    value={(d.dns || []).join(', ')}
                    onChange={(e) =>
                      field(
                        'dns',
                        e.target.value ? e.target.value.split(',').map((v) => v.trim()) : [],
                      )
                    }
                    onBlur={() => field('dns', (d.dns || []).filter(Boolean))}
                  />
                </label>
                <p className="field-hint">
                  Plusieurs adresses séparées par des virgules. Les noms de services restent résolus
                  par Docker sur les réseaux bridge.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

export function NetworkConnections({ topology, node, onChange, disabled }) {
  const peers = topology.nodes.filter((n) => n.data.kind !== node.data.kind);
  const update = (edge, patch) =>
    onChange((t) => ({
      ...t,
      edges: t.edges.map((e) => (e.id === edge.id ? { ...e, ...patch } : e)),
    }));
  return (
    <fieldset disabled={disabled} className="device-settings connection-settings">
      <legend>Interfaces réseau</legend>
      {!peers.length && (
        <p className="field-hint">
          Ajoute {node.data.kind === 'container' ? 'un réseau bridge' : 'un conteneur'} depuis la
          palette.
        </p>
      )}
      {peers.map((peer) => {
        const edge = topology.edges.find(
          (e) => [e.source, e.target].includes(peer.id) && [e.source, e.target].includes(node.id),
        );
        const net = node.data.kind === 'network' ? node : peer;
        return (
          <div className="settings-card" key={peer.id}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={!!edge}
                onChange={(e) =>
                  onChange((t) => ({
                    ...t,
                    edges: e.target.checked
                      ? [
                          ...t.edges,
                          {
                            id: `e-${crypto.randomUUID().slice(0, 8)}`,
                            source: node.id,
                            target: peer.id,
                            type: 'traffic',
                            ipv4: '',
                            aliases: [],
                          },
                        ]
                      : t.edges.filter((e) => e.id !== edge.id),
                  }))
                }
              />
              {peer.data.label}
              <small>{net.data.subnet || 'IP automatique'}</small>
            </label>
            {edge && (
              <>
                <label>
                  IPv4 sur {peer.data.label}
                  <input
                    value={edge.ipv4 || ''}
                    disabled={!net.data.subnet}
                    placeholder={
                      net.data.subnet ? 'Automatique' : 'Configure d’abord le sous-réseau'
                    }
                    onChange={(e) => update(edge, { ipv4: e.target.value })}
                  />
                </label>
                <label>
                  Alias DNS sur {peer.data.label}
                  <input
                    value={(edge.aliases || []).join(', ')}
                    placeholder="ex. mysql, database"
                    onChange={(e) =>
                      update(edge, {
                        aliases: e.target.value
                          ? e.target.value.split(',').map((a) => a.trim())
                          : [],
                      })
                    }
                    onBlur={() => update(edge, { aliases: (edge.aliases || []).filter(Boolean) })}
                  />
                </label>
              </>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
