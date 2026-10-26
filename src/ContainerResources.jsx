import React, { useEffect, useState } from 'react';
import { Cpu, HardDrive, RefreshCw, Monitor } from 'lucide-react';
import { GiB, cpuSetCount } from '../shared/container-resources.mjs';
import './container-resources.css';

export const resourceSize = (value) =>
  value == null ? 'Sans limite' : `${Math.round((value / GiB) * 100) / 100} Gio`;
export async function resourceRequest(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Impossible de lire les ressources.');
  return result;
}
export function HardwareSummary({ host }) {
  if (!host) return null;
  return (
    <div className="resource-hardware">
      <strong>{host.name}</strong>
      <div className="resource-capacities">
        <span>
          <Cpu size={16} /> {host.cpus} CPU
        </span>
        <span>
          <HardDrive size={16} /> {resourceSize(host.memoryBytes)} RAM
        </span>
      </div>
      {host.hardware?.cpuModel && <small>{host.hardware.cpuModel}</small>}
      {host.hardware?.scope === 'windows-desktop' && (
        <small>Capacité attribuée à Docker Desktop.</small>
      )}
    </div>
  );
}
export function AllocationFields({
  host,
  limits = {},
  mode,
  setMode,
  values,
  setValues,
  disabled,
}) {
  return (
    <div className="resource-allocation-grid">
      {[
        ['cpus', 'Processeur', host?.cpus, limits.cpus],
        [
          'memoryBytes',
          'Mémoire RAM',
          host?.memoryBytes / GiB,
          limits.memoryBytes == null ? null : limits.memoryBytes / GiB,
        ],
      ].map(([key, label, max, current]) => (
        <label key={key}>
          {label}
          <select
            disabled={disabled}
            value={mode[key]}
            onChange={(e) => setMode({ ...mode, [key]: e.target.value })}
          >
            <option value="keep">
              Actuel :{' '}
              {current == null
                ? 'sans limite'
                : `${Math.round(current * 100) / 100} ${key === 'cpus' ? 'CPU' : 'Gio'}`}
            </option>
            <option value="all" disabled={!max}>
              Toute la capacité Docker
            </option>
            <option value="custom" disabled={!max}>
              Choisir une limite
            </option>
          </select>
          {mode[key] === 'custom' && (
            <div className="resource-number">
              <input
                type="number"
                min={key === 'cpus' ? '0.01' : '0.01'}
                step="0.01"
                max={max || undefined}
                disabled={disabled}
                aria-label={key === 'cpus' ? 'CPU alloués' : 'Mémoire RAM allouée'}
                value={values[key]}
                onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              />
              <span>{key === 'cpus' ? 'CPU' : 'Gio'}</span>
            </div>
          )}
          {mode[key] === 'all' && (
            <small>
              {Math.round(max * 100) / 100} {key === 'cpus' ? 'CPU' : 'Gio'}, partagés avec les
              autres services.
            </small>
          )}
        </label>
      ))}
    </div>
  );
}
export function allocationInput(mode, values, host) {
  const result = {};
  for (const key of ['cpus', 'memoryBytes']) {
    if (mode[key] === 'keep') continue;
    result[key] =
      mode[key] === 'all' ? host[key] : Number(values[key]) * (key === 'memoryBytes' ? GiB : 1);
    if (key === 'memoryBytes') result[key] = Math.round(result[key]);
  }
  return result;
}
export default function ContainerResources({ container, onChanged, onEditConfiguration }) {
  const id = container.dockerId || container.id,
    hostId = container.hostId || 'local',
    base = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(id)}/resources`;
  const [data, setData] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [mode, setMode] = useState({ cpus: 'keep', memoryBytes: 'keep' }),
    [values, setValues] = useState({ cpus: '1', memoryBytes: '1' }),
    [preview, setPreview] = useState(null);
  useEffect(() => {
    let current = true;
    setData(null);
    setError('');
    setBusy(true);
    setPreview(null);
    setMode({ cpus: 'keep', memoryBytes: 'keep' });
    resourceRequest(base)
      .then((result) => {
        if (current) setData(result);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [base]);
  async function refresh() {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      setData(await resourceRequest(base));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPreview(
        await resourceRequest(base + '/preview', 'POST', {
          expectedName: data.name,
          version: data.version,
          ...allocationInput(mode, values, allocationHost),
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError('');
    try {
      const result = await resourceRequest(base + '/apply', 'POST', {
        expectedName: data.name,
        token: preview.token,
      });
      setData(result.resources);
      setPreview(null);
      setMode({ cpus: 'keep', memoryBytes: 'keep' });
      setMessage(result.warnings?.length ? result.warnings.join(' ') : 'Ressources appliquées.');
      onChanged?.();
    } catch (e) {
      setError(e.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  const dirty = Object.values(mode).some((value) => value !== 'keep');
  const cpuCount = cpuSetCount(data?.limits.cpuSet),
    allocationHost = data
      ? { ...data.host, cpus: cpuCount ? Math.min(data.host.cpus, cpuCount) : data.host.cpus }
      : null;
  return (
    <div className="container-resources">
      <header>
        <h3>
          <Cpu size={17} /> Matériel et ressources
        </h3>
        <button type="button" disabled={busy} onClick={refresh} title="Actualiser le matériel">
          <RefreshCw size={15} /> Actualiser
        </button>
      </header>
      {error && (
        <p className="resource-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="resource-success" role="status">
          {message}
        </p>
      )}
      {!data && !error && <p>Lecture du serveur…</p>}
      {data && (
        <>
          <HardwareSummary host={data.host} />
          {data.usage && (
            <p className="resource-usage">
              Utilisation :{' '}
              {data.usage.cpuPercent == null
                ? 'CPU indisponible'
                : `${data.usage.cpuPercent.toFixed(1)} % CPU`}{' '}
              ·{' '}
              {data.usage.memoryBytes == null
                ? 'RAM indisponible'
                : resourceSize(data.usage.memoryBytes) + ' RAM'}
            </p>
          )}
          <AllocationFields
            host={allocationHost}
            limits={data.limits}
            mode={mode}
            setMode={(next) => {
              setMode(next);
              setPreview(null);
            }}
            values={values}
            setValues={(next) => {
              setValues(next);
              setPreview(null);
            }}
            disabled={busy}
          />
          {data.limits.cpuSet && (
            <small>CPU autorisés par la configuration : {data.limits.cpuSet}.</small>
          )}
          {data.limits.memorySwap > 0 && (
            <small>
              RAM + swap plafonnés à {resourceSize(data.limits.memorySwap)}. Pour aller au-delà,
              modifie aussi le swap dans Compose.
            </small>
          )}
          <div className="resource-actions">
            <button type="button" disabled={busy || !dirty} onClick={prepare}>
              Vérifier la modification
            </button>
            {onEditConfiguration && (
              <button type="button" onClick={() => onEditConfiguration('resources')}>
                Ouvrir Compose
              </button>
            )}
          </div>
          {preview && (
            <section className="resource-confirm" aria-label="Confirmer les ressources">
              <strong>
                Appliquer à {preview.name} sur {preview.host} ?
              </strong>
              {preview.after.cpus !== undefined && (
                <p>
                  CPU : {preview.before.cpus ?? 'sans limite'} → {preview.after.cpus}
                </p>
              )}
              {preview.after.memoryBytes !== undefined && (
                <p>
                  RAM : {resourceSize(preview.before.memoryBytes)} →{' '}
                  {resourceSize(preview.after.memoryBytes)}
                </p>
              )}
              <small>{preview.note}</small>
              {preview.after.memoryBytes < data.usage?.memoryBytes && (
                <small className="resource-error">
                  La limite est inférieure à la RAM utilisée. L’application peut manquer de mémoire.
                </small>
              )}
              {data.composeProject && (
                <small>Un prochain déploiement Compose peut remplacer ces limites.</small>
              )}
              <div className="resource-actions">
                <button type="button" disabled={busy} onClick={apply}>
                  Appliquer maintenant
                </button>
                <button type="button" disabled={busy} onClick={() => setPreview(null)}>
                  Annuler
                </button>
              </div>
            </section>
          )}
          <section className="resource-gpu">
            <h4>
              <Monitor size={16} /> Cartes graphiques
            </h4>
            {data.host.gpus.length ? (
              data.host.gpus.map((gpu) => (
                <div className="resource-gpu-card" key={gpu.uuid}>
                  <strong>{gpu.name}</strong>
                  <small>
                    GPU {gpu.index} · {gpu.totalGiB} Gio VRAM
                    {gpu.freeGiB != null ? ` · ${gpu.freeGiB} Gio libres` : ''}
                  </small>
                </div>
              ))
            ) : (
              <p>
                {data.host.hardware?.gpuStatus === 'none'
                  ? 'Aucune carte NVIDIA détectée.'
                  : 'Détection GPU indisponible sur ce serveur.'}
              </p>
            )}
            {!!data.limits.devices.length && (
              <small>
                Attribution actuelle :{' '}
                {data.limits.devices
                  .map((device) =>
                    device.DeviceIDs?.length
                      ? device.DeviceIDs.join(', ')
                      : device.Count === -1
                        ? 'tous les GPU'
                        : `${device.Count || '?'} GPU`,
                  )
                  .join(' · ')}
              </small>
            )}
            <p>Le choix des GPU s’applique en recréant le service.</p>
            {onEditConfiguration && (
              <button type="button" onClick={() => onEditConfiguration('resources')}>
                Choisir les GPU dans Compose
              </button>
            )}
            <details>
              <summary>À savoir</summary>
              <p>
                Les limites CPU et RAM ne réservent pas le matériel. Le swap et les périphériques
                existants sont conservés. La mémoire GPU de vLLM se règle dans ses paramètres,
                indépendamment de la RAM du conteneur.
              </p>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
