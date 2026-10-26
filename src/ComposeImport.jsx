import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, FolderOpen, Play, Upload } from 'lucide-react';
import { workspaceApi, WorkspaceModal } from './WorkspacePanels.jsx';
import { readComposeImportFile, summarizeComposeImport } from '../shared/compose-import.mjs';
import './compose-import.css';
import { BROWSER_MODE } from './browser-mode.js';

export function ComposeImport({
  initialFile,
  defaultHostId = 'local',
  blocked = '',
  onImported,
  onBusyChange,
}) {
  const [source, setSource] = useState(''),
    [filename, setFilename] = useState(''),
    [error, setError] = useState('');
  const [hosts, setHosts] = useState([]),
    [hostId, setHostId] = useState(defaultHostId),
    [name, setName] = useState(''),
    [projectName, setProjectName] = useState('');
  const [adopt, setAdopt] = useState(false),
    [directory, setDirectory] = useState(''),
    [useDotEnv, setUseDotEnv] = useState(false),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false);
  const picker = useRef(null),
    reading = useRef(0),
    alive = useRef(true),
    busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const summary = useMemo(() => {
    if (!source) return null;
    try {
      return summarizeComposeImport(source, filename);
    } catch (e) {
      return { error: e.message };
    }
  }, [source, filename]);
  useEffect(() => {
    if (summary && !summary.error) {
      setName((current) => current || summary.name);
      setProjectName((current) => current || summary.projectName);
    }
  }, [summary]);
  useEffect(() => {
    alive.current = true;
    workspaceApi('/api/hosts')
      .then((list) => {
        if (alive.current) setHosts(list);
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    return () => {
      alive.current = false;
      reading.current++;
      busyCallback.current?.(false);
    };
  }, []);
  const loadFile = async (file) => {
    if (busy || !file) return;
    const sequence = ++reading.current;
    setError('');
    try {
      const loaded = await readComposeImportFile(file);
      if (!alive.current || sequence !== reading.current) return;
      setSource(loaded.source);
      setFilename(loaded.filename);
      const details = summarizeComposeImport(loaded.source, loaded.filename);
      setName(details.name);
      setProjectName(details.projectName);
      setDirectory('');
      setUseDotEnv(false);
      setAdopt(false);
    } catch (e) {
      if (alive.current && sequence === reading.current) {
        setSource('');
        setFilename('');
        setError(e.message);
      }
    }
  };
  useEffect(() => {
    if (initialFile) loadFile(initialFile);
  }, [initialFile]);
  const host = hosts.find((h) => h.id === hostId);
  const valid =
    summary &&
    !summary.error &&
    name.trim() &&
    /^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName) &&
    host &&
    (!useDotEnv || directory.trim());
  const submit = async (previewImport) => {
    if (!valid || busy || blocked) return;
    setBusy(true);
    busyCallback.current?.(true);
    setError('');
    try {
      const result = await workspaceApi('/api/projects', {
        name: name.trim(),
        hostId,
        template: 'empty',
        compose: { source, projectName, adopt, directory: directory.trim(), useDotEnv },
      });
      await onImported(result.project, { previewImport });
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
      busyCallback.current?.(false);
    }
  };
  return (
    <section className="compose-import-flow" aria-label="Importer un fichier Compose">
      <div
        className={`compose-import-drop ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.stopPropagation();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          if (event.dataTransfer.files.length !== 1) {
            setError('Dépose un seul fichier Compose.');
            return;
          }
          loadFile(event.dataTransfer.files[0]);
        }}
      >
        <FileUp size={28} />
        <strong>{filename || 'Dépose ton fichier Compose ici'}</strong>
        <span>.yaml ou .yml · 2 Mio maximum</span>
        <input
          ref={picker}
          type="file"
          accept=".yaml,.yml"
          hidden
          aria-label="Fichier Compose à importer"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            loadFile(file);
          }}
        />
        <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
          <FolderOpen size={16} />
          {filename ? 'Changer de fichier' : 'Choisir un fichier'}
        </button>
      </div>
      <details className="compose-import-options">
        <summary>Ou coller le YAML</summary>
        <textarea
          aria-label="Configuration Compose à importer"
          value={source}
          disabled={busy}
          rows={8}
          spellCheck={false}
          maxLength={2 * 1024 * 1024}
          onChange={(event) => {
            setError('');
            setSource(event.target.value);
          }}
        />
      </details>
      {(error || summary?.error) && (
        <p className="compose-import-error" role="alert">
          {error || summary.error}
        </p>
      )}
      {summary && !summary.error && (
        <>
          <div className="compose-import-grid">
            <label>
              Nom de l’infrastructure
              <input
                maxLength={80}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {!BROWSER_MODE && <label>
              Serveur cible
              <select
                value={hostId}
                disabled={busy}
                onChange={(event) => setHostId(event.target.value)}
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                    {h.kind === 'ssh' ? ' · SSH' : ''}
                  </option>
                ))}
              </select>
            </label>}
            <label>
              Nom du projet Compose
              <input
                value={projectName}
                maxLength={63}
                disabled={busy}
                onChange={(event) => setProjectName(event.target.value)}
                pattern="[a-z0-9][a-z0-9_\-]{0,62}"
                spellCheck={false}
              />
            </label>
            {!BROWSER_MODE && <label>
              Ce projet est
              <select
                value={adopt ? 'existing' : 'new'}
                disabled={busy}
                onChange={(event) => setAdopt(event.target.value === 'existing')}
              >
                <option value="new">À démarrer sur ce serveur</option>
                <option value="existing">Déjà déployé sur ce serveur</option>
              </select>
            </label>}
          </div>
          {adopt && (
            <p className="compose-import-note">
              Utilise le nom Compose exact du projet existant. Ses conteneurs pourront être mis à
              jour après validation.
            </p>
          )}
          <div className="compose-import-summary">
            <h3>
              {summary.services.length} service{summary.services.length > 1 ? 's' : ''} ·{' '}
              {summary.volumes.length} volume{summary.volumes.length > 1 ? 's' : ''} nommé
              {summary.volumes.length > 1 ? 's' : ''}
            </h3>
            <div className="compose-import-table">
              <table>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Image</th>
                    <th>Ports</th>
                    <th>Stockage</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.services.map((service) => (
                    <tr key={service.name}>
                      <td>
                        <strong>{service.name}</strong>
                        {service.profiles.length > 0 && (
                          <small>Profil : {service.profiles.join(', ')}</small>
                        )}
                      </td>
                      <td>{service.image}</td>
                      <td>{service.ports.join(', ') || 'Aucun publié'}</td>
                      <td>{service.mounts.join(', ') || 'Aucun montage'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {(summary.dependencies.length > 0 || summary.variables.length > 0) && (
            <div className="compose-import-files">
              <strong>Fichiers et variables à prévoir</strong>
              {summary.dependencies.length > 0 && (
                <ul>
                  {summary.dependencies.map((item, index) => (
                    <li key={index}>
                      {item.kind}
                      {item.service ? ` · ${item.service}` : ''} : <code>{item.path}</code>
                    </li>
                  ))}
                </ul>
              )}
              {summary.variables.length > 0 && (
                <p>
                  Variables :{' '}
                  {summary.variables
                    .map(
                      (variable) => `${variable.name}${variable.required ? '' : ' (optionnelle)'}`,
                    )
                    .join(', ')}
                  .
                </p>
              )}
              <p>
                Seul le YAML est importé. Les fichiers associés doivent rester sur le serveur cible.
                La validation Compose vérifiera aussi les fichiers inclus et contextes de build.
              </p>
            </div>
          )}
          {!BROWSER_MODE && <details
            className="compose-import-options"
            open={
              summary.dependencies.length > 0 || summary.variables.length > 0 ? true : undefined
            }
          >
            <summary>Dossier et fichier .env</summary>
            <label>
              Dossier d’origine sur {host?.name || 'le serveur'}
              <input
                value={directory}
                disabled={busy}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder={host?.kind === 'ssh' ? '/srv/mon-projet' : 'Chemin absolu du dossier'}
              />
            </label>
            <label className="compose-import-check">
              <input
                type="checkbox"
                checked={useDotEnv}
                disabled={busy}
                onChange={(event) => setUseDotEnv(event.target.checked)}
              />{' '}
              Lire le fichier .env de ce dossier
            </label>
            {summary.needsDirectory && !directory.trim() && (
              <p>Indique le dossier pour retrouver les chemins relatifs avant le démarrage.</p>
            )}
            <small>
              Les variables peuvent aussi être complétées dans la configuration du projet.
            </small>
          </details>}
          {summary.warnings.length > 0 && (
            <details className="compose-import-options">
              <summary>
                {summary.warnings.length} point{summary.warnings.length > 1 ? 's' : ''} à vérifier
              </summary>
              <ul>
                {summary.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {blocked && (
            <p className="compose-import-error" role="alert">
              {blocked}
            </p>
          )}
          <p className="compose-import-note">
            {BROWSER_MODE
              ? 'Le fichier d’origine reste intact. L’import ouvre la carte sans lancer Docker.'
              : 'Le fichier d’origine reste intact. Rien ne démarre à l’import.'}
          </p>
          <div className="compose-import-actions">
            <button
              type="button"
              disabled={!valid || busy || !!blocked}
              onClick={() => submit(false)}
            >
              <Upload size={16} />
              {BROWSER_MODE ? 'Importer et ouvrir la carte' : 'Importer sans démarrer'}
            </button>
            {!BROWSER_MODE && <button
              type="button"
              className="deploy-button"
              disabled={
                !valid || busy || !!blocked || (summary.needsDirectory && !directory.trim())
              }
              onClick={() => submit(true)}
            >
              <Play size={16} />
              {busy ? 'Import en cours…' : 'Vérifier puis démarrer'}
            </button>}
          </div>
        </>
      )}
    </section>
  );
}

export default function ComposeDropImport({
  openRequest,
  defaultHostId,
  blocked,
  onImported,
  onClose,
}) {
  const [droppedFile, setDroppedFile] = useState(null),
    [dropError, setDropError] = useState(''),
    [dragging, setDragging] = useState(false),
    [busy, setBusy] = useState(false);
  const visible = !!openRequest || !!droppedFile || !!dropError;
  useEffect(() => {
    let depth = 0;
    const isFile = (event) =>
      event.dataTransfer?.types.includes('Files') && !event.target.closest?.('.cw-dialog');
    const enter = (event) => {
      if (isFile(event)) {
        event.preventDefault();
        depth++;
        setDragging(true);
      }
    };
    const over = (event) => {
      if (isFile(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      }
    };
    const leave = (event) => {
      if (isFile(event) && --depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const drop = (event) => {
      if (!isFile(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (busy) return;
      if (event.dataTransfer.files.length !== 1) {
        setDropError('Dépose un seul fichier Compose .yaml ou .yml.');
        return;
      }
      setDropError('');
      setDroppedFile(event.dataTransfer.files[0]);
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', drop);
    };
  }, [busy]);
  const close = () => {
    if (!busy) {
      setDroppedFile(null);
      setDropError('');
      onClose();
    }
  };
  return (
    <>
      {dragging && !visible && (
        <div className="compose-global-drop" aria-hidden="true">
          <FileUp size={42} />
          <strong>Dépose ton Compose pour voir son récapitulatif</strong>
          <span>Aucun service ne démarre automatiquement.</span>
        </div>
      )}
      {visible && (
        <WorkspaceModal title="Importer un Compose" wide onClose={close}>
          {dropError && (
            <p className="compose-import-error" role="alert">
              {dropError}
            </p>
          )}
          <ComposeImport
            initialFile={droppedFile}
            defaultHostId={defaultHostId}
            blocked={blocked}
            onBusyChange={setBusy}
            onImported={async (project, options) => {
              await onImported(project, options);
              setDroppedFile(null);
              setDropError('');
              onClose();
            }}
          />
        </WorkspaceModal>
      )}
    </>
  );
}
