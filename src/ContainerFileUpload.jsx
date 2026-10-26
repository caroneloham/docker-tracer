import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import './container-file-upload.css';

const LIMIT = 20 * 1024 * 1024;

export default function ContainerFileUpload({
  api,
  containerName,
  directory = '/',
  onUploaded,
  onBusyChange,
  disabled = false,
}) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const picker = useRef(null);
  const request = useRef(null);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const folder = typeof directory === 'string' ? directory : directory?.path || '/';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      busyCallback.current?.(false);
    };
  }, [api]);

  const choose = (event) => {
    const next = event.target.files?.[0];
    event.target.value = '';
    if (!next) return;
    setNotice('');
    setError('');
    if (next.size > LIMIT) {
      setError('20 Mio maximum par fichier.');
      setFile(null);
      return;
    }
    setFile(next);
    setName(next.name);
  };

  const upload = () => {
    if (!file || busy || disabled) return;
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[\x00-\x1f\x7f/\\]/.test(name) ||
      new TextEncoder().encode(name).length > 255
    ) {
      setError('Choisis un nom de fichier sans / ni \\.');
      return;
    }
    const destination = `${folder === '/' ? '' : folder}/${name}`;
    const query = new URLSearchParams({ path: destination, expectedName: containerName });
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    setBusy(true);
    busyCallback.current?.(true);
    setProgress(0);
    setError('');
    setNotice('');
    xhr.open('POST', `${api}/upload?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Docker-Tracer', '1');
    xhr.timeout = 120000;
    xhr.upload.onprogress = (event) => {
      if (mounted.current && event.lengthComputable)
        setProgress(Math.round((event.loaded * 100) / event.total));
    };
    const finish = () => {
      if (request.current !== xhr) return;
      request.current = null;
      if (mounted.current) setBusy(false);
      busyCallback.current?.(false);
    };
    xhr.onerror = xhr.ontimeout = () => {
      if (mounted.current)
        setError('Import non confirmé. Actualise le dossier avant de réessayer.');
      finish();
    };
    xhr.onabort = finish;
    xhr.onload = async () => {
      if (!mounted.current) return finish();
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        result = { error: 'Réponse du serveur invalide. Actualise le dossier.' };
      }
      if (xhr.status < 200 || xhr.status >= 300 || result.error) {
        setError(result.error || 'Import impossible.');
        finish();
        return;
      }
      setNotice(`${name} importé.`);
      setFile(null);
      setName('');
      try {
        await onUploaded?.(result);
      } catch {
        if (mounted.current) setError('Import réussi. Actualise le dossier pour voir le fichier.');
      } finally {
        finish();
      }
    };
    xhr.send(file);
  };

  return (
    <div className="cw-upload">
      <input
        ref={picker}
        type="file"
        className="cw-upload-picker"
        onChange={choose}
        aria-label="Fichier à importer"
        disabled={busy || disabled}
      />
      <div className="cw-upload-heading">
        <button disabled={busy || disabled} onClick={() => picker.current?.click()}>
          <Upload size={16} /> Importer un fichier
        </button>
        <small title={folder}>
          Dans <strong>{folder}</strong> · 20 Mio max.
        </small>
      </div>
      {file && (
        <div className="cw-upload-selection">
          <label>
            Nom du fichier
            <input
              aria-label="Nom du fichier importé"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  upload();
                }
              }}
            />
          </label>
          <button className="cw-primary" disabled={busy || disabled} onClick={upload}>
            {busy ? 'Import en cours…' : 'Importer'}
          </button>
          <button
            disabled={busy}
            aria-label="Annuler la sélection du fichier"
            onClick={() => {
              setFile(null);
              setError('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {busy && (
        <div className="cw-upload-progress" role="status">
          <progress max={100} value={progress} aria-label="Progression de l’import" />
          <span>{progress < 100 ? `${progress} %` : 'Vérification…'}</span>
        </div>
      )}
      {error && (
        <p className="cw-upload-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="cw-upload-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
