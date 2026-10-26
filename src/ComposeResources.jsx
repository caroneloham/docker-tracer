import React, { useEffect, useState } from 'react';
import { Monitor, RefreshCw } from 'lucide-react';
import {
  composeGpuState,
  memoryBytes,
  patchComposeResources,
  vllmFraction,
} from '../shared/container-resources.mjs';
import { patchDeclarativeComposeResources } from '../shared/compose-resources.mjs';
import { BROWSER_MODE } from './browser-mode.js';
import {
  HardwareSummary,
  AllocationFields,
  allocationInput,
  resourceRequest,
} from './ContainerResources.jsx';
import './container-resources.css';

export default function ComposeResources({ source, name, service, hostId, onChange }) {
  const [host, setHost] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [mode, setMode] = useState({ cpus: 'keep', memoryBytes: 'keep' }),
    [values, setValues] = useState({ cpus: '1', memoryBytes: '1' });
  const [gpuMode, setGpuMode] = useState('keep'),
    [ids, setIds] = useState([]),
    [manualIds, setManualIds] = useState(''),
    [editFraction, setEditFraction] = useState(false),
    [fraction, setFraction] = useState('90');
  const gpu = composeGpuState(service),
    vllm = vllmFraction(service);
  const endpoint = BROWSER_MODE
    ? ''
    : `/api/hosts/${encodeURIComponent(hostId || 'local')}/hardware`;
  useEffect(() => {
    if (BROWSER_MODE) return undefined;
    let current = true;
    setHost(null);
    setError('');
    setBusy(true);
    resourceRequest(endpoint)
      .then((result) => {
        if (current) setHost(result);
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
  }, [endpoint]);
  useEffect(() => {
    setMode({ cpus: 'keep', memoryBytes: 'keep' });
    setGpuMode('keep');
    setIds(gpu.ids);
    setManualIds(gpu.ids.join(', '));
    setEditFraction(false);
    setFraction(String(Math.round((vllm?.value || 0.9) * 100)));
  }, [name]);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setHost(await resourceRequest(endpoint));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const limits = {
    cpus: service.cpus ?? service.deploy?.resources?.limits?.cpus ?? null,
    memoryBytes: memoryBytes(service.mem_limit ?? service.deploy?.resources?.limits?.memory),
  };
  const declaredMemory = service.mem_limit ?? service.deploy?.resources?.limits?.memory;
  const hardwareIds = new Set((host?.gpus || []).flatMap((device) => [device.uuid, device.index]));
  const missingIds = gpu.ids.filter((id) => !hardwareIds.has(id));
  const dirty =
    Object.values(mode).some((value) => value !== 'keep') || gpuMode !== 'keep' || editFraction;
  function apply() {
    setError('');
    try {
      const next = BROWSER_MODE
        ? patchDeclarativeComposeResources(source, name, {
            cpus: { mode: mode.cpus === 'custom' ? 'set' : mode.cpus, value: values.cpus },
            memory: {
              mode: mode.memoryBytes === 'custom' ? 'set' : mode.memoryBytes,
              value: values.memoryBytes,
            },
            gpu: { mode: gpuMode, ids: manualIds },
            ...(editFraction ? { vllmFraction: Number(fraction) / 100 } : {}),
          })
        : patchComposeResources(
            source,
            name,
            {
              ...allocationInput(mode, values, host || {}),
              gpu: { mode: gpuMode, ids },
              ...(editFraction ? { vllmFraction: Number(fraction) / 100 } : {}),
            },
            host || {},
          );
      onChange(next);
      setMode({ cpus: 'keep', memoryBytes: 'keep' });
      setGpuMode('keep');
      setEditFraction(false);
      setMessage(
        BROWSER_MODE
          ? 'Brouillon Compose mis à jour. La compatibilité avec votre machine reste à vérifier.'
          : 'Brouillon mis à jour. Vérifie puis applique les changements du projet.',
      );
    } catch (e) {
      setError(e.message);
    }
  }
  if (BROWSER_MODE)
    return (
      <div className="compose-resources">
        <p className="resource-usage">
          Ressources déclarées dans ce fichier Compose. Aucune machine n’est interrogée.
        </p>
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
        <div className="resource-allocation-grid">
          {[
            [
              'cpus',
              'Processeur',
              limits.cpus == null ? 'sans limite' : `${limits.cpus} CPU`,
              'CPU',
              '0.01',
              '256',
            ],
            [
              'memoryBytes',
              'Mémoire RAM',
              declaredMemory == null
                ? 'sans limite'
                : limits.memoryBytes == null
                  ? String(declaredMemory)
                  : `${Math.round((limits.memoryBytes / 1024 ** 3) * 100) / 100} Gio`,
              'Gio',
              '0.006',
              '1024',
            ],
          ].map(([key, label, current, unit, min, max]) => (
            <label key={key}>
              {label}
              <select
                value={mode[key]}
                onChange={(event) => setMode({ ...mode, [key]: event.target.value })}
              >
                <option value="keep">Actuel dans Compose : {current}</option>
                <option value="custom">Définir une limite</option>
                <option value="remove">Retirer la limite</option>
              </select>
              {mode[key] === 'custom' && (
                <span className="resource-number">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={values[key]}
                    aria-label={
                      key === 'cpus' ? 'Limite CPU déclarée' : 'Limite RAM déclarée en Gio'
                    }
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                    spellCheck={false}
                  />
                  <span>{unit}</span>
                </span>
              )}
              {mode[key] === 'custom' && (
                <small>
                  Saisie entre {min} et {max} {unit}. Ce plafond de formulaire ne représente pas la
                  capacité de votre machine.
                </small>
              )}
            </label>
          ))}
        </div>
        <section className="resource-gpu">
          <h4>
            <Monitor size={16} /> Cartes graphiques
          </h4>
          <label>
            GPU déclarés pour le service
            <select value={gpuMode} onChange={(event) => setGpuMode(event.target.value)}>
              <option value="keep">
                Conserver l’attribution actuelle
                {gpu.mode === 'none' ? ' : aucun GPU' : gpu.mode === 'all' ? ' : tous les GPU' : ''}
              </option>
              <option value="none" disabled={!gpu.editable}>
                Aucun GPU
              </option>
              <option value="all" disabled={!gpu.editable}>
                Tous les GPU de l’hôte cible
              </option>
              <option value="selected" disabled={!gpu.editable}>
                Identifiants précis
              </option>
            </select>
          </label>
          {gpuMode === 'selected' && (
            <label>
              Indices ou identifiants GPU
              <input
                type="text"
                value={manualIds}
                onChange={(event) => setManualIds(event.target.value)}
                placeholder="0, GPU-xxxxxxxx"
                spellCheck={false}
                aria-label="Identifiants GPU déclarés"
              />
              <small>
                Sépare les identifiants par des virgules. Vérifie-les sur le PC où le Compose sera
                lancé.
              </small>
            </label>
          )}
          {!gpu.editable && (
            <small>Plusieurs règles GPU existent. Modifie-les dans les options avancées.</small>
          )}
          {vllm && (
            <details>
              <summary>Mémoire GPU de vLLM</summary>
              {vllm.editable ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={editFraction}
                      onChange={(event) => setEditFraction(event.target.checked)}
                    />{' '}
                    Régler la part utilisée par vLLM
                  </label>
                  {editFraction && (
                    <label>
                      Part de VRAM (%)
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={fraction}
                        onChange={(event) => setFraction(event.target.value)}
                      />
                    </label>
                  )}
                </>
              ) : (
                <p>Le réglage se trouve dans la commande du service, dans les options avancées.</p>
              )}
              <p>Valeur par GPU. Ce paramètre n’est pas une limite Docker.</p>
            </details>
          )}
          <small>Compatibilité matérielle et effet au démarrage non vérifiés ici.</small>
        </section>
        <button type="button" disabled={!dirty} onClick={apply}>
          Ajouter au brouillon Compose
        </button>
      </div>
    );
  return (
    <div className="compose-resources">
      <HardwareSummary host={host} />
      <button type="button" disabled={busy} onClick={refresh}>
        <RefreshCw size={14} /> Actualiser le matériel
      </button>
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
      <AllocationFields
        host={host}
        limits={limits}
        mode={mode}
        setMode={setMode}
        values={values}
        setValues={setValues}
        disabled={busy}
      />
      <section className="resource-gpu">
        <h4>
          <Monitor size={16} /> Cartes graphiques
        </h4>
        <label>
          GPU du service
          <select
            value={gpuMode}
            onChange={(e) => {
              setGpuMode(e.target.value);
              if (e.target.value === 'selected' && !ids.length) setIds(gpu.ids);
            }}
          >
            <option value="keep">
              Conserver l’attribution actuelle
              {gpu.mode === 'none' ? ' : aucun GPU' : gpu.mode === 'all' ? ' : tous les GPU' : ''}
            </option>
            <option value="none" disabled={!gpu.editable}>
              Aucun GPU
            </option>
            <option value="all" disabled={!gpu.editable || !host?.gpus?.length}>
              Tous les GPU détectés
            </option>
            <option
              value="selected"
              disabled={!gpu.editable || (!host?.gpus?.length && !gpu.ids.length)}
            >
              Choisir les cartes
            </option>
          </select>
        </label>
        {(host?.gpus || []).map((device) => {
          const activeId = gpu.ids.includes(device.index) ? device.index : device.uuid;
          return (
            <div className="resource-gpu-card" key={device.uuid}>
              <label>
                {gpuMode === 'selected' && (
                  <input
                    type="checkbox"
                    checked={ids.includes(activeId)}
                    onChange={(e) =>
                      setIds(
                        e.target.checked ? [...ids, activeId] : ids.filter((id) => id !== activeId),
                      )
                    }
                  />
                )}
                <span>
                  <strong>{device.name}</strong>
                  <small>
                    GPU {device.index} · {device.totalGiB} Gio VRAM
                    {device.freeGiB != null ? ` · ${device.freeGiB} Gio libres` : ''}
                  </small>
                </span>
              </label>
            </div>
          );
        })}
        {gpuMode === 'selected' &&
          missingIds.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={ids.includes(id)}
                onChange={(e) =>
                  setIds(e.target.checked ? [...ids, id] : ids.filter((value) => value !== id))
                }
              />{' '}
              {id} · déjà configuré, non détecté
            </label>
          ))}
        {!host?.gpus?.length && (
          <small>
            {host?.hardware?.gpuStatus === 'none'
              ? 'Aucune carte NVIDIA détectée.'
              : 'La détection GPU est indisponible. L’attribution existante reste conservée.'}
          </small>
        )}
        {!gpu.editable && (
          <small>
            Plusieurs règles GPU existent. Utilise les options avancées pour les modifier.
          </small>
        )}
        {vllm && (
          <details>
            <summary>Mémoire GPU de vLLM</summary>
            {vllm.editable ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={editFraction}
                    onChange={(e) => setEditFraction(e.target.checked)}
                  />{' '}
                  Régler la part utilisée par vLLM
                </label>
                {editFraction && (
                  <label>
                    Part de VRAM (%)
                    <input
                      type="number"
                      min="1"
                      max="99"
                      value={fraction}
                      onChange={(e) => setFraction(e.target.value)}
                    />
                  </label>
                )}
              </>
            ) : (
              <p>Le réglage se trouve dans la commande du service, dans les options avancées.</p>
            )}
            <p>
              Valeur par GPU. Ce paramètre vLLM n’est pas une limite Docker et doit laisser de la
              place aux autres usages.
            </p>
          </details>
        )}
        <small>Le service sera recréé au prochain déploiement si son matériel change.</small>
      </section>
      <button type="button" disabled={!dirty || busy} onClick={apply}>
        Ajouter au brouillon
      </button>
    </div>
  );
}
