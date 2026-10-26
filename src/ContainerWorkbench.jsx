import React, { useEffect, useRef, useState } from 'react';
import {
  Terminal,
  FolderOpen,
  FileText,
  Settings,
  X,
  Play,
  Square,
  RefreshCw,
  Save,
  ChevronUp,
  Cpu,
} from 'lucide-react';
import { workspaceApi } from './WorkspacePanels.jsx';
import DockerTerminal from './DockerTerminal.jsx';
import ContainerFileUpload from './ContainerFileUpload.jsx';
import ContainerResources from './ContainerResources.jsx';
import './container-workbench.css';

const labels = {
  terminal: 'Terminal',
  files: 'Fichiers',
  resources: 'Matériel',
  logs: 'Logs',
  manage: 'Gestion',
};
const icons = {
  terminal: Terminal,
  files: FolderOpen,
  resources: Cpu,
  logs: FileText,
  manage: Settings,
};
export default function ContainerWorkbench(props) {
  return (
    <ContainerWorkbenchPanel
      key={`${props.container.hostId || 'local'}:${props.container.dockerId || props.container.id}`}
      {...props}
    />
  );
}

function ContainerWorkbenchPanel({
  container,
  initialTab = 'terminal',
  onClose,
  onChanged = () => {},
  onEditConfiguration,
}) {
  const hostId = container.hostId || 'local';
  const id = container.dockerId || container.id;
  const base = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(id)}`;
  const api = base + '/workbench';
  const [tab, setTab] = useState(labels[initialTab] ? initialTab : 'terminal');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState(null),
    [location, setLocation] = useState('/'),
    [file, setFile] = useState(null),
    [content, setContent] = useState('');
  const [logs, setLogs] = useState(''),
    [followLogs, setFollowLogs] = useState(true);
  const [action, setAction] = useState(null),
    [discard, setDiscard] = useState(null);
  const [state, setState] = useState(container.stale ? 'unknown' : container.state);
  const terminalControl = useRef(null),
    panelRef = useRef(null),
    alive = useRef(true);
  const [terminalMounted, setTerminalMounted] = useState(initialTab === 'terminal');
  const dirty = !!file && file.content !== content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    setState(container.stale ? 'unknown' : container.state);
  }, [container.state, container.stale]);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    panelRef.current?.focus();
    const keydown = (event) => {
      if (event.target.closest?.('.xterm') && ['Escape', 'Tab'].includes(event.key)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (busyRef.current) return;
        if (dirtyRef.current) setDiscard({ type: 'close' });
        else closeRef.current();
      }
      if (event.key === 'Tab') {
        const focusable = [
          ...(panelRef.current?.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || []),
        ].filter((node) => node.offsetParent !== null);
        const first = focusable[0],
          last = focusable.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === panelRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      alive.current = false;
      document.removeEventListener('keydown', keydown, true);
      previous?.focus?.();
    };
  }, [api]);

  useEffect(() => {
    if (tab !== 'logs') return;
    let cancelled = false,
      timer;
    const load = async () => {
      try {
        const result = await workspaceApi(base + '/logs');
        if (!cancelled) setLogs(result.output || 'Aucune sortie pour le moment.');
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
      if (!cancelled && followLogs) timer = setTimeout(load, 3000);
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, tab, followLogs]);

  const perform = async (fn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const browse = (value = location) =>
    perform(async () => {
      const next = await workspaceApi(`${api}/files?path=${encodeURIComponent(value)}`);
      setDirectory(next);
      setLocation(value);
    });
  const openFile = (value, force = false) => {
    if (dirty && !force) {
      setDiscard({ type: 'file', path: value });
      return;
    }
    return perform(async () => {
      const next = await workspaceApi(`${api}/file?path=${encodeURIComponent(value)}`);
      setFile(next);
      setContent(next.content);
      setLocation(value);
    });
  };
  useEffect(() => {
    if (tab !== 'files' || directory) return;
    let active = true;
    workspaceApi(`${api}/files?path=%2F`)
      .then((next) => {
        if (active) setDirectory(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [tab, api]);
  const save = () =>
    perform(async () => {
      const next = await workspaceApi(
        api + '/file',
        { expectedName: container.name, path: file.path, hash: file.hash, content },
        'PUT',
      );
      setFile(next);
      setContent(next.content);
      setNotice('Fichier enregistré.');
      onChanged();
    });
  const applyAction = () =>
    perform(async () => {
      if (action !== 'start') await terminalControl.current?.close();
      await workspaceApi(base + '/action', { action, expectedName: container.name });
      setState(action === 'stop' ? 'exited' : 'running');
      setAction(null);
      onChanged();
      setNotice('Action effectuée.');
    });

  return (
    <div
      className="cw-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy)
          dirty ? setDiscard({ type: 'close' }) : onClose();
      }}
    >
      <section
        className="cw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cw-title"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="cw-header">
          <div>
            <small>{container.hostName || hostId}</small>
            <h2 id="cw-title">{container.name}</h2>
            <span title={container.image}>{container.image || id.slice(0, 12)}</span>
          </div>
          <button
            aria-label="Fermer la gestion du conteneur"
            disabled={busy}
            onClick={() => (dirty ? setDiscard({ type: 'close' }) : onClose())}
          >
            <X size={20} />
          </button>
        </header>
        <nav className="cw-tabs" aria-label="Gestion du conteneur">
          {Object.keys(labels).map((key) => {
            const Icon = icons[key];
            return (
              <button
                key={key}
                disabled={busy}
                aria-current={tab === key ? 'page' : undefined}
                className={tab === key ? 'active' : ''}
                onClick={() => {
                  setTab(key);
                  if (key === 'terminal') setTerminalMounted(true);
                  setError('');
                  setNotice('');
                }}
              >
                <Icon size={17} />
                {labels[key]}
              </button>
            );
          })}
        </nav>
        <div className="cw-body">
          {error && (
            <div className="cw-message cw-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="cw-message" role="status">
              {notice}
            </div>
          )}
          {discard && (
            <div className="cw-message cw-confirm" role="alert">
              <strong>Ce fichier contient des modifications non enregistrées.</strong>
              <div>
                <button onClick={() => setDiscard(null)}>Continuer à modifier</button>
                <button
                  onClick={() => {
                    const next = discard;
                    setDiscard(null);
                    if (next.type === 'close') onClose();
                    else openFile(next.path, true);
                  }}
                >
                  Abandonner les modifications
                </button>
              </div>
            </div>
          )}
          {terminalMounted && (
            <DockerTerminal
              ref={terminalControl}
              container={{ ...container, state }}
              active={tab === 'terminal'}
            />
          )}
          {tab === 'files' && (
            <div className="cw-files">
              <div className="cw-path">
                <input
                  aria-label="Chemin dans le conteneur"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy) browse();
                  }}
                  spellCheck={false}
                  placeholder="/etc/nginx/nginx.conf"
                />
                <button disabled={busy} onClick={() => browse()}>
                  Ouvrir le dossier
                </button>
                <button disabled={busy} onClick={() => openFile(location)}>
                  Ouvrir le fichier
                </button>
              </div>
              <ContainerFileUpload
                api={api}
                containerName={container.name}
                directory={directory?.path || '/'}
                disabled={busy}
                onBusyChange={setBusy}
                onUploaded={async () => {
                  const current = directory?.path || '/';
                  try {
                    setDirectory(
                      await workspaceApi(`${api}/files?path=${encodeURIComponent(current)}`),
                    );
                  } catch {
                    setNotice('Fichier envoyé. Actualise le dossier pour le retrouver.');
                  }
                  onChanged();
                }}
              />
              <details className="cw-file-help">
                <summary>À savoir</summary>
                <p>
                  Les fichiers hors volume peuvent disparaître à la recréation du conteneur.
                  L’éditeur accepte le texte UTF-8 jusqu’à 256 Kio.
                </p>
              </details>
              <div className="cw-file-layout">
                <aside className="cw-file-list" aria-label="Fichiers du dossier">
                  {directory ? (
                    <>
                      <div className="cw-folder-title">
                        <button
                          disabled={busy || directory.path === '/'}
                          aria-label="Dossier parent"
                          onClick={() =>
                            browse(directory.path.slice(0, directory.path.lastIndexOf('/')) || '/')
                          }
                        >
                          <ChevronUp size={16} />
                        </button>
                        <strong>{directory.path}</strong>
                      </div>
                      {!directory.entries.length && <p>Dossier vide.</p>}
                      {directory.entries.map((entry) => (
                        <button
                          className={file?.path === entry.path ? 'active' : ''}
                          key={entry.path}
                          disabled={busy || !entry.accessible}
                          title={
                            !entry.accessible
                              ? 'Lien ou fichier spécial : utilise un chemin réel.'
                              : entry.path
                          }
                          onClick={() =>
                            entry.type === 'directory' ? browse(entry.path) : openFile(entry.path)
                          }
                        >
                          {entry.type === 'directory' ? (
                            <FolderOpen size={15} />
                          ) : (
                            <FileText size={15} />
                          )}
                          <span>{entry.name}</span>
                          {!entry.accessible && (
                            <small>{entry.type === 'link' ? 'lien' : 'spécial'}</small>
                          )}
                        </button>
                      ))}
                    </>
                  ) : (
                    <div className="cw-file-empty">
                      <FolderOpen size={26} />
                      <p>Choisis un dossier.</p>
                      <button disabled={busy} onClick={() => browse('/')}>
                        Parcourir /
                      </button>
                    </div>
                  )}
                </aside>
                <div className="cw-editor">
                  {file ? (
                    <>
                      <div className="cw-toolbar">
                        <strong title={file.path}>
                          {file.path}
                          {dirty ? ' · modifié' : ''}
                        </strong>
                        <button disabled={busy} onClick={() => openFile(file.path)}>
                          <RefreshCw size={15} />
                          Recharger
                        </button>
                        <button className="cw-primary" disabled={busy || !dirty} onClick={save}>
                          <Save size={15} />
                          Enregistrer
                        </button>
                      </div>
                      <textarea
                        aria-label={`Contenu de ${file.path}`}
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        disabled={busy}
                        spellCheck={false}
                      />
                      <small>
                        {new TextEncoder().encode(content).length.toLocaleString('fr-FR')} octets ·
                        UTF-8
                      </small>
                    </>
                  ) : (
                    <div className="cw-file-empty">
                      <FileText size={32} />
                      <p>Choisis un fichier pour le modifier.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {tab === 'resources' && (
            <ContainerResources
              container={{ ...container, state }}
              onChanged={onChanged}
              onEditConfiguration={
                onEditConfiguration
                  ? (section = 'resources') => {
                      if (dirty) {
                        setError('Enregistre le fichier ouvert avant de quitter.');
                        return;
                      }
                      onEditConfiguration(container, section);
                    }
                  : undefined
              }
            />
          )}
          {tab === 'logs' && (
            <div className="cw-logs">
              <div className="cw-toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={followLogs}
                    onChange={(event) => setFollowLogs(event.target.checked)}
                  />
                  Suivre les logs
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => setLogs((await workspaceApi(base + '/logs')).output))
                  }
                >
                  <RefreshCw size={15} />
                  Actualiser
                </button>
              </div>
              <small className="cw-hint">150 dernières lignes</small>
              <pre className="cw-terminal-output" tabIndex={0} aria-label="Logs du conteneur">
                {logs || 'Chargement des logs…'}
              </pre>
            </div>
          )}
          {tab === 'manage' && (
            <div className="cw-management">
              <h3>Agir sur {container.name}</h3>
              <p>
                État :{' '}
                {state === 'running'
                  ? 'en marche'
                  : state === 'exited'
                    ? 'arrêté'
                    : state === 'unknown'
                      ? 'à vérifier'
                      : state || 'à vérifier'}
                .
              </p>
              <div className="cw-toolbar">
                {['start', 'restart', 'stop'].map((value) => (
                  <button
                    key={value}
                    disabled={
                      busy ||
                      container.stale ||
                      (value === 'start' ? state === 'running' : state !== 'running')
                    }
                    onClick={() => setAction(value)}
                  >
                    {{ start: 'Démarrer', restart: 'Redémarrer', stop: 'Arrêter' }[value]}
                  </button>
                ))}
              </div>
              {action && (
                <div className="cw-message cw-confirm">
                  <strong>
                    {{ start: 'Démarrer', restart: 'Redémarrer', stop: 'Arrêter' }[action]}{' '}
                    {container.name} sur {container.hostName || hostId} ?
                  </strong>
                  <p>
                    {action === 'start'
                      ? 'Le conteneur existant sera démarré.'
                      : 'Les connexions de ce conteneur seront interrompues.'}
                  </p>
                  <div>
                    <button disabled={busy} onClick={() => setAction(null)}>
                      Annuler
                    </button>
                    <button className="cw-primary" disabled={busy} onClick={applyAction}>
                      Confirmer
                    </button>
                  </div>
                </div>
              )}
              <div className="cw-config-card">
                <Settings size={24} />
                <div>
                  <h3>Configuration</h3>
                  {onEditConfiguration ? (
                    <button
                      className="cw-primary"
                      onClick={() => {
                        if (dirty) {
                          setError(
                            'Enregistre ou recharge le fichier ouvert avant de changer de configuration.',
                          );
                          return;
                        }
                        onEditConfiguration(container);
                      }}
                    >
                      Modifier la configuration
                    </button>
                  ) : (
                    <p className="cw-hint">
                      Associe ce conteneur à son projet Compose pour conserver ses changements de
                      configuration lors des prochains déploiements.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
