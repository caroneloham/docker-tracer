import React, { useEffect, useState, useRef } from 'react';
import { ComposeImport } from './ComposeImport.jsx';
import './projects.css';
import { FolderOpen, Plus, X, Copy, Archive, RotateCcw, Server } from 'lucide-react';
import { BROWSER_MODE } from './browser-mode.js';
export const composeExample =
  'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n';
export async function projectRequest(path, body, method = 'POST') {
  const response = await fetch(
    '/api' + path,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'La requête a échoué.');
  return result;
}
export default function Projects({ current, dirty, onOpen, onClose, initialPage = 'projects' }) {
  const [page, setPage] = useState(initialPage === 'import' ? 'builder' : 'projects');
  const close = () => {
    if (!busy) onClose();
  };
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => previous?.focus?.();
  }, []);
  const keyboard = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [
      ...dialog.current.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary',
      ),
    ].filter((element) => element.getClientRects().length && !element.closest('fieldset:disabled'));
    const first = focusable[0],
      last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  const [projects, setProjects] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [archives, setArchives] = useState(false),
    [pending, setPending] = useState(null),
    [importFile, setImportFile] = useState(null);
  const [canCompose, setCanCompose] = useState(false);
  const refresh = async () => {
    const p = await projectRequest('/projects');
    setCanCompose(!!p.capabilities?.composeProjects);
    setProjects(p.projects);
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  const action = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const open = (p) => {
    if (p.id === current.id) {
      onClose();
      return;
    }
    if (dirty) setPending(p);
    else onOpen(p);
  };
  return (
    <div className="modal-backdrop project-backdrop" onClick={close}>
      <section
        ref={dialog}
        onKeyDown={keyboard}
        className={'modal project-manager' + (page === 'ai' ? ' ai-project-manager' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-title"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.stopPropagation();
          if (busy) return;
          if (event.dataTransfer.files.length !== 1) {
            setError('Dépose un seul fichier Compose.');
            return;
          }
          setError('');
          setImportFile(event.dataTransfer.files[0]);
          setPage('builder');
        }}
      >
        <div className="project-heading">
          <div>
            <h2 id="projects-title">
              <FolderOpen size={19} />{' '}
              {page === 'projects' ? 'Mes infrastructures' : 'Importer un Compose'}
            </h2>
            {page !== 'ai' && (
              <p>{BROWSER_MODE
                ? 'Une carte par projet, conservée dans cet onglet pendant cet essai.'
                : 'Une carte par projet, avec son serveur Docker et ses propres ressources.'}</p>
            )}
          </div>
          <button aria-label="Fermer les projets" onClick={close} disabled={busy}>
            <X size={18} />
          </button>
        </div>
        {error && (
          <p className="project-error" role="alert">
            {error}
          </p>
        )}
        {pending ? (
          <div className="project-discard">
            <h3>Ouvrir « {pending.name} » ?</h3>
            <p>
              Le brouillon de « {current.name} » n’est pas enregistré. Tes modifications seront
              abandonnées.
            </p>
            <button onClick={() => setPending(null)}>Revenir aux projets</button>
            <button className="danger-button" onClick={() => onOpen(pending)}>
              Abandonner le brouillon et ouvrir
            </button>
          </div>
        ) : (
          <>
            {page !== 'projects' && (
              <div className="project-page-nav">
                <button
                  disabled={busy}
                  onClick={() => {
                    setPage('projects');
                    refresh().catch((e) => setError(e.message));
                  }}
                >
                  ← Mes infrastructures
                </button>
              </div>
            )}
            {page === 'builder' && (
              <ComposeImport
                initialFile={importFile}
                defaultHostId={current.hostId || 'local'}
                blocked={dirty ? 'Enregistre le projet ouvert avant d’en importer un autre.' : ''}
                onBusyChange={setBusy}
                onImported={(project, options) => onOpen(project, null, 'image', options)}
              />
            )}
            {page === 'projects' && (
              <>
                <div className="project-catalog-entry">
                  <div>
                    <h3>Une infrastructure existe déjà ?</h3>
                    <p>
                      Importe le fichier Compose de ton serveur ou celui généré avec AutoDocker.
                    </p>
                  </div>
                  <button
                    className="catalog-primary"
                    disabled={busy || !canCompose}
                    onClick={() => setPage('builder')}
                  >
                    <FolderOpen size={17} /> Importer un Compose
                  </button>
                </div>
                <div className="project-list-heading">
                  <h3>{archives ? 'Projets archivés' : 'Projets disponibles'}</h3>
                  <label>
                    <input
                      type="checkbox"
                      checked={archives}
                      onChange={(e) => setArchives(e.target.checked)}
                    />{' '}
                    Afficher les archives
                  </label>
                </div>
                <div className="project-list">
                  {projects
                    .filter((p) => !!p.archivedAt === archives)
                    .map((p) => (
                      <article
                        className={'project-row ' + (p.id === current.id ? 'current' : '')}
                        key={p.id}
                      >
                        <div>
                          <strong>
                            {p.name}
                            {p.id === current.id ? ' · ouvert' : ''}
                          </strong>
                          <span>
                            <Server size={12} /> {BROWSER_MODE ? 'Atelier navigateur' : p.host.name}{' '}
                            {!BROWSER_MODE && p.host.kind === 'ssh'
                              ? '· ' + p.host.username + '@' + p.host.address
                              : !BROWSER_MODE ? '· local' : ''}
                          </span>
                          <small>
                            {p.containers} services · {p.networks} réseaux ·{' '}
                            {BROWSER_MODE ? 'brouillon en mémoire' : p.capture
                              ? 'capture active'
                              : {
                                  deployed: 'déployé',
                                  draft: 'à déployer',
                                  offline: 'serveur inaccessible',
                                  unknown: 'état à vérifier',
                                }[p.state]}
                          </small>
                        </div>
                        <div className="project-row-actions">
                          {p.archivedAt ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                action(() =>
                                  projectRequest('/projects/' + p.id + '/restore', {
                                    revision: p.revision,
                                  }),
                                )
                              }
                            >
                              <RotateCcw size={14} />
                              Restaurer
                            </button>
                          ) : (
                            <>
                              <button disabled={busy || p.busy} onClick={() => open(p)}>
                                <FolderOpen size={14} />
                                {p.id === current.id ? 'Revenir' : 'Ouvrir'}
                              </button>
                              {!p.legacy && p.id !== current.id && (
                                <button
                                  title={'Archiver ' + p.name}
                                  disabled={busy || p.busy || p.capture}
                                  onClick={() =>
                                    action(() =>
                                      projectRequest('/projects/' + p.id + '/archive', {
                                        revision: p.revision,
                                      }),
                                    )
                                  }
                                >
                                  <Archive size={14} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </article>
                    ))}
                  {!projects.some((p) => !!p.archivedAt === archives) && (
                    <p>Aucun projet {archives ? 'archivé' : 'disponible'}.</p>
                  )}
                </div>
                <p className="project-hint">
                  {BROWSER_MODE
                    ? 'Les projets de cet atelier restent en mémoire pendant la visite. Exporte les fichiers à conserver avant de fermer l’onglet.'
                    : 'Les profils SSH se configurent dans « Tout Docker → Serveurs ». Un projet reste lié à son serveur. Pour changer de cible, crée une copie. Libère son déploiement avant de l’archiver ; ses volumes restent conservés.'}
                </p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
