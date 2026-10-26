import React, { useState, useRef } from 'react';
import { Plus, Upload, Trash2, Route } from 'lucide-react';
import {
  FILE_LIMIT,
  textBytes,
  appFileSchema,
  isNginx,
  configurationFiles,
} from '../shared/configuration.mjs';
import { configureProxy, detachProxy } from '../shared/proxy.mjs';
import './configuration.css';
const message = (e) =>
  e.issues ? [...new Set(e.issues.map((i) => i.message))].join(' ') : e.message;
export default function ConfigurationFiles({ data, onChange, topology, node, onTopologyChange }) {
  const files = data.files || [],
    [index, setIndex] = useState(0),
    [error, setError] = useState(''),
    input = useRef(null);
  const current = Math.min(index, Math.max(0, files.length - 1)),
    file = files[current];
  const update = (patch) =>
    onChange(
      'files',
      files.map((f, i) => (i === current ? { ...f, ...patch } : f)),
    );
  const add = (f) => {
    if (files.length >= 16) {
      setError('Maximum de 16 fichiers par service.');
      return;
    }
    onChange('files', [...files, f]);
    setIndex(files.length);
    setError('');
  };
  const importFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > FILE_LIMIT) throw Error('Le fichier dépasse 64 Kio.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const path = '/etc/docker-tracer/' + file.name;
      add(appFileSchema.parse({ path, content }));
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      {topology && isNginx(data.image) && (
        <ProxySettings topology={topology} node={node} onChange={onTopologyChange} />
      )}
      {!topology && data.proxy && (
        <p className="field-hint">
          Le modèle conserve les fichiers personnalisés. Choisis à nouveau la cible du reverse proxy
          après avoir placé un équipement.
        </p>
      )}
      <p className="field-hint">
        Ajoute une configuration ou une page texte à l’image. Ces fichiers sont envoyés avant le
        démarrage et conservés dans le projet et ses exports. Ils ne sont pas un coffre de secrets.
      </p>
      <div className="config-file-actions">
        <button
          type="button"
          className="outline-btn"
          disabled={files.length >= 16}
          onClick={() =>
            add({ path: '/etc/docker-tracer/config-' + (files.length + 1) + '.txt', content: '' })
          }
        >
          <Plus size={13} />
          Ajouter un fichier
        </button>
        <button
          type="button"
          className="outline-btn"
          disabled={files.length >= 16}
          onClick={() => input.current.click()}
        >
          <Upload size={13} />
          Importer un texte
        </button>
        <input hidden ref={input} type="file" onChange={importFile} />
      </div>
      {error && (
        <p role="alert" className="pdu-error">
          {error}
        </p>
      )}
      {file && (
        <div className="config-file-editor">
          <label>
            Fichier à modifier
            <select value={current} onChange={(e) => setIndex(Number(e.target.value))}>
              {files.map((f, i) => (
                <option value={i} key={i}>
                  {f.path || 'Nouveau fichier ' + (i + 1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Chemin dans le conteneur
            <input
              value={file.path}
              maxLength={240}
              spellCheck={false}
              onChange={(e) => update({ path: e.target.value })}
              placeholder="/etc/nginx/conf.d/default.conf"
            />
          </label>
          <label>
            Contenu du fichier
            <textarea
              rows={12}
              value={file.content}
              spellCheck={false}
              maxLength={FILE_LIMIT}
              onChange={(e) => update({ content: e.target.value })}
            />
          </label>
          <div className="config-file-footer">
            <small>{textBytes(file.content).toLocaleString('fr-FR')} / 65 536 octets · UTF-8</small>
            <button
              type="button"
              className="danger-text"
              onClick={() =>
                onChange(
                  'files',
                  files.filter((_, i) => i !== current),
                )
              }
            >
              <Trash2 size={13} />
              Retirer ce fichier
            </button>
          </div>
        </div>
      )}
      {!files.length && !data.proxy && (
        <p className="field-hint">
          Aucun fichier personnalisé. L’image conserve ses fichiers par défaut.
        </p>
      )}
      <p className="field-hint">
        Les chemins dans un volume de données ou à travers un lien symbolique sont refusés. Modifier
        ou retirer un fichier remplace seulement son service après vérification des changements.
      </p>
    </>
  );
}
function ProxySettings({ topology, node, onChange }) {
  const generated = (() => {
    try {
      return configurationFiles(topology, node).at(-1)?.content;
    } catch {
      return 'La cible est introuvable. Choisis un autre service ou retire le proxy.';
    }
  })();
  const existing = node.data.proxy,
    targets = topology.nodes.filter((n) => n.data.kind === 'container' && n.id !== node.id);
  const [targetId, setTarget] = useState(existing?.targetId || targets[0]?.id || ''),
    [networkId, setNetwork] = useState(existing?.networkId || ''),
    [port, setPort] = useState(existing?.port || 80),
    [listenPort, setListenPort] = useState(existing?.listenPort || 80),
    [websocket, setWebsocket] = useState(existing?.websocket ?? true),
    [error, setError] = useState('');
  const networks = topology.nodes.filter(
    (n) =>
      n.data.kind === 'network' &&
      topology.edges.some(
        (e) => [e.source, e.target].includes(targetId) && [e.source, e.target].includes(n.id),
      ),
  );
  const selectedNet = networks.some((n) => n.id === networkId) ? networkId : networks[0]?.id || '';
  const apply = () => {
    try {
      const next = configureProxy(topology, node.id, {
        targetId,
        networkId: selectedNet,
        port,
        listenPort,
        websocket,
      });
      onChange(() => next);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  };
  const detach = (keep) => {
    try {
      const next = detachProxy(topology, node.id, keep);
      onChange(() => next);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <details className="proxy-settings" open={!!existing || undefined}>
      <summary>
        <Route size={14} /> Reverse proxy Nginx {existing ? '· configuré' : ''}
      </summary>
      <p className="field-hint">
        Redirige les requêtes HTTP vers un service de cette carte. L’assistant crée le fichier Nginx
        et relie le proxy au réseau choisi.
      </p>
      <label>
        Service de destination
        <select
          value={targetId}
          onChange={(e) => {
            setTarget(e.target.value);
            setNetwork('');
          }}
        >
          {!targets.length && <option value="">Ajoute un service à la carte</option>}
          {targets.map((n) => (
            <option value={n.id} key={n.id}>
              {n.data.label} · {n.data.image}
            </option>
          ))}
        </select>
      </label>
      <label>
        Réseau vers la destination
        <select value={selectedNet} onChange={(e) => setNetwork(e.target.value)}>
          {!networks.length && <option value="">Relie d’abord la destination à un réseau</option>}
          {networks.map((n) => (
            <option value={n.id} key={n.id}>
              {n.data.label}
            </option>
          ))}
        </select>
      </label>
      <div className="settings-pair">
        <label>
          Port de destination
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </label>
        <label>
          Port d’écoute du proxy
          <input
            type="number"
            min={1}
            max={65535}
            value={listenPort}
            onChange={(e) => setListenPort(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={websocket}
          onChange={(e) => setWebsocket(e.target.checked)}
        />
        Prendre en charge WebSocket
      </label>
      <button
        type="button"
        className="outline-btn full"
        disabled={!targetId || !selectedNet}
        onClick={apply}
      >
        {existing ? 'Mettre à jour le proxy' : 'Configurer le proxy'}
      </button>
      {error && (
        <p role="alert" className="pdu-error">
          {error}
        </p>
      )}
      {existing && (
        <>
          <p className="field-hint">
            Fichier généré : /etc/nginx/conf.d/default.conf. Le nom suit les modifications de la
            cible sur la carte.
          </p>
          <details>
            <summary>Voir la configuration générée</summary>
            <pre className="proxy-preview">{generated}</pre>
          </details>
          <div className="config-file-actions">
            <button type="button" onClick={() => detach(true)}>
              Modifier le fichier librement
            </button>
            <button type="button" className="danger-text" onClick={() => detach(false)}>
              Retirer le proxy
            </button>
          </div>
        </>
      )}
      <p className="field-hint">
        Pour y accéder depuis le navigateur, publie le port d’écoute dans « Ports & volumes ». HTTP
        uniquement ; les certificats HTTPS restent à configurer.
      </p>
    </details>
  );
}
