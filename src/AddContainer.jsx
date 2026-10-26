import React, { useEffect, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { WorkspaceModal, workspaceApi } from './WorkspacePanels.jsx';
import DockerImagePicker from './DockerImagePicker.jsx';
import { addContainerToCompose, suggestedServiceName } from '../shared/add-container.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import './add-container.css';

export default function AddContainer({
  hostId: initialHost = 'local',
  projectId,
  onClose,
  onOpen,
}) {
  const [hosts, setHosts] = useState([]),
    [projects, setProjects] = useState([]),
    [networks, setNetworks] = useState([]);
  const [projectNetworks, setProjectNetworks] = useState([]),
    [projectNetworkError, setProjectNetworkError] = useState('');
  const [hostId, setHost] = useState(initialHost),
    [destination, setDestination] = useState(projectId || 'standalone');
  const [settings, setSettings] = useState({
    name: '',
    image: '',
    containerPort: '',
    hostPort: '',
    bind: '127.0.0.1',
    protocol: 'tcp',
    network: '',
    networkKey: '',
    environment: '',
  });
  const [picker, setPicker] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [networkError, setNetworkError] = useState('');
  const [saved, setSaved] = useState(null),
    working = useRef(false),
    savedResult = useRef(null);
  useEffect(() => {
    let active = true;
    Promise.all([workspaceApi('/api/hosts'), workspaceApi('/api/projects')])
      .then(([h, p]) => {
        if (active) {
          setHosts(h);
          setProjects(p.projects);
          if (!h.some((host) => host.id === initialHost)) {
            setHost('');
            setDestination('standalone');
            setError('Le serveur initial n’est plus disponible. Choisis le serveur cible.');
          }
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setNetworks([]);
    setNetworkError('');
    if (hostId)
      workspaceApi(`/api/hosts/${encodeURIComponent(hostId)}/inventory`)
        .then((inv) => {
          if (active)
            setNetworks(
              inv.networks.filter(
                (n) => n.driver !== 'host' && n.driver !== 'null' && n.name !== 'bridge',
              ),
            );
        })
        .catch((e) => active && setNetworkError(e.message));
    return () => {
      active = false;
    };
  }, [hostId]);
  useEffect(() => {
    let active = true;
    setProjectNetworks([]);
    setProjectNetworkError('');
    if (destination !== 'standalone')
      workspaceApi(`/api/projects/${encodeURIComponent(destination)}/state`)
        .then((current) => {
          if (!active) return;
          if (current.project.hostId !== hostId || !current.compose || current.project.archivedAt)
            throw Error('Ce projet n’est plus disponible sur ce serveur.');
          const { model } = composeDocument(current.compose.source);
          setProjectNetworks(Object.keys(model.networks || {}));
        })
        .catch((e) => active && setProjectNetworkError(e.message));
    return () => {
      active = false;
    };
  }, [destination, hostId]);
  const selectDestination = (value) => {
    setDestination(value);
    setSettings((s) => ({ ...s, network: '', networkKey: '' }));
  };
  const field = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      if (savedResult.current) {
        await onOpen(savedResult.current.project, savedResult.current.nodeId);
        onClose();
        return;
      }
      if (!hosts.some((host) => host.id === hostId)) throw Error('Choisis un serveur disponible.');
      if (settings.network && !networks.some((network) => network.name === settings.network))
        throw Error('Ce réseau n’est plus disponible sur le serveur sélectionné.');
      let project;
      if (destination === 'standalone') {
        const source = addContainerToCompose('services: {}\n', settings);
        const result = await workspaceApi('/api/projects', {
          name: settings.name,
          hostId,
          compose: {
            source,
            projectName: `dtr-${settings.name
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, '-')
              .slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`,
          },
        });
        project = result.project;
      } else {
        const current = await workspaceApi(
          `/api/projects/${encodeURIComponent(destination)}/state`,
        );
        if (current.project.hostId !== hostId || !current.compose || current.project.archivedAt)
          throw Error('Le projet cible a changé. Actualise la sélection.');
        if (Object.hasOwn(current.compose.resolved?.services || {}, settings.name))
          throw Error('Ce nom de service existe déjà dans le projet ou un fichier inclus.');
        const source = addContainerToCompose(current.compose.source, settings);
        const response = await fetch(
          `/api/projects/${encodeURIComponent(destination)}/compose/source`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Docker-Tracer': '1',
              'If-Match': String(current.project.revision),
            },
            body: JSON.stringify({ ...current.compose, source, resolved: null }),
          },
        );
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'Enregistrement impossible.');
        project = result.project || current.project;
      }
      const completed = { project, nodeId: `service:${settings.name}` };
      savedResult.current = completed;
      setSaved(completed);
      await onOpen(completed.project, completed.nodeId);
      onClose();
    } catch (e) {
      setError(
        savedResult.current
          ? `La machine est enregistrée. Impossible d’ouvrir sa carte : ${e.message}`
          : e.message,
      );
    } finally {
      setBusy(false);
      working.current = false;
    }
  };
  return (
    <WorkspaceModal
      title="Ajouter un conteneur"
      wide
      onClose={() => {
        if (!working.current) onClose();
      }}
    >
      {picker ? (
        <>
          {error && (
            <p role="alert" className="pdu-error">
              {error}
            </p>
          )}
          {settings.image && (
            <button type="button" onClick={() => setPicker(false)}>
              Revenir à la configuration
            </button>
          )}
          <DockerImagePicker
            embedded
            hostId={hostId}
            onClose={() => setPicker(false)}
            onSelect={(item) => {
              setSettings((s) => ({
                ...s,
                image: item.image,
                name: s.name || suggestedServiceName(item.image),
              }));
              setPicker(false);
            }}
          />
        </>
      ) : (
        <form className="add-container-form" onSubmit={submit}>
          <p>
            Ajoute une machine à un projet existant ou directement à un serveur. Ses ports, fichiers
            et ressources restent modifiables depuis la carte.
          </p>
          {error && (
            <p role="alert" className="pdu-error">
              {error}
            </p>
          )}
          <fieldset disabled={busy || !!saved}>
            <div className="add-container-grid">
              <label>
                Serveur
                <select
                  value={hostId}
                  onChange={(e) => {
                    setHost(e.target.value);
                    selectDestination('standalone');
                  }}
                >
                  {!hostId && <option value="">Choisir un serveur</option>}
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ajouter dans
                <select value={destination} onChange={(e) => selectDestination(e.target.value)}>
                  <option value="standalone">Ce serveur · conteneur indépendant</option>
                  {projects
                    .filter((p) => p.hostId === hostId && p.kind === 'compose' && !p.archivedAt)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Nom de la machine
                <input
                  required
                  maxLength={63}
                  pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*"
                  value={settings.name}
                  onChange={(e) => field('name', e.target.value)}
                  placeholder="cache, web, worker…"
                />
              </label>
              <label>
                Image Docker
                <div className="add-container-image">
                  <input
                    required
                    value={settings.image}
                    onChange={(e) => field('image', e.target.value)}
                    placeholder="nginx:alpine"
                  />
                  <button
                    type="button"
                    aria-label="Chercher une image Docker"
                    onClick={() => setPicker(true)}
                  >
                    <Search size={16} />
                  </button>
                </div>
              </label>
            </div>
            <details open>
              <summary>Réseau et accès</summary>
              <div className="add-container-grid">
                <label>
                  Réseau
                  <select
                    value={
                      settings.networkKey
                        ? `project:${settings.networkKey}`
                        : settings.network
                          ? `server:${settings.network}`
                          : ''
                    }
                    onChange={(e) => {
                      const value = e.target.value;
                      setSettings((s) => ({
                        ...s,
                        networkKey: value.startsWith('project:') ? value.slice(8) : '',
                        network: value.startsWith('server:') ? value.slice(7) : '',
                      }));
                    }}
                  >
                    <option value="">Réseau par défaut du projet</option>
                    {!!projectNetworks.length && (
                      <optgroup label="Réseaux du projet">
                        {projectNetworks.map((name) => (
                          <option key={name} value={`project:${name}`}>
                            {name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {!!networks.length && (
                      <optgroup label="Réseaux existants du serveur">
                        {networks.map((n) => (
                          <option key={n.id} value={`server:${n.name}`}>
                            {n.name} · {n.driver}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                <label>
                  Accessible depuis
                  <select value={settings.bind} onChange={(e) => field('bind', e.target.value)}>
                    <option value="127.0.0.1">Ce serveur uniquement</option>
                    <option value="0.0.0.0">Le réseau du serveur</option>
                  </select>
                </label>
                <label>
                  Port interne de l’application
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={settings.containerPort}
                    onChange={(e) => field('containerPort', e.target.value)}
                    placeholder="Ex. 80 · vide = aucun port publié"
                  />
                </label>
                <label>
                  Port sur le serveur
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={settings.hostPort}
                    onChange={(e) => field('hostPort', e.target.value)}
                    placeholder="Automatique"
                  />
                </label>
                <label>
                  Protocole
                  <select
                    value={settings.protocol}
                    onChange={(e) => field('protocol', e.target.value)}
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </label>
              </div>
              {networkError && (
                <p className="field-hint">Réseaux existants indisponibles : {networkError}</p>
              )}
              {projectNetworkError && (
                <p className="field-hint">
                  Réseaux du projet indisponibles : {projectNetworkError}
                </p>
              )}
            </details>
            <details>
              <summary>Variables d’environnement</summary>
              <label>
                Une variable par ligne
                <textarea
                  rows={5}
                  value={settings.environment}
                  onChange={(e) => field('environment', e.target.value)}
                  placeholder={'TZ=Europe/Paris\nAPP_MODE=production'}
                  spellCheck={false}
                />
              </label>
            </details>
          </fieldset>
          <p className="field-hint">
            Le bouton prépare le conteneur dans la carte, sans téléchargement. Vérifie ensuite les
            modifications pour l’installer. Une image peut demander des volumes, variables ou
            commandes spécifiques.
          </p>
          <button
            className="deploy-button"
            type="submit"
            disabled={
              busy || (!saved && (!hostId || !hosts.length || !settings.image || !settings.name))
            }
          >
            <Plus size={16} />
            {busy
              ? 'Enregistrement…'
              : saved
                ? 'Ouvrir la machine enregistrée'
                : 'Ajouter et configurer'}
          </button>
        </form>
      )}
    </WorkspaceModal>
  );
}
