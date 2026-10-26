import React from 'react';
import { Cpu, HardDrive, MemoryStick, RefreshCw, Check, Server } from 'lucide-react';
import { aiModelStoragePath } from '../shared/ai-infrastructure.mjs';

export function detectedGpuSettings(gpus) {
  return {
    gpuIds: gpus.map((g) => g.uuid),
    gpuName: gpus
      .map((g) => g.name)
      .join(' + ')
      .slice(0, 80),
    ...(gpus.length ? { vramGiB: Math.min(...gpus.map((g) => g.totalGiB)) } : {}),
  };
}

export default function AiHardware({
  values,
  update,
  report,
  loading,
  error,
  refresh,
  existing,
  projectName,
  field,
  resourceMode = 'manual',
  useAvailableResources,
}) {
  const hardware = report?.hardware;
  const gpus = hardware?.gpus || [];
  const selected = gpus.filter(
    (g) => values.gpuIds.includes(g.uuid) || values.gpuIds.includes(g.index),
  );
  const missing = values.gpuIds.filter((id) => !gpus.some((g) => g.uuid === id || g.index === id));
  const cpus = report?.cpus;
  const ram = report?.ramGiB;
  const maxRam = Math.max(2, Math.floor((ram || values.ramGiB) - values.webRamGiB - 2));
  const disk = hardware?.disks?.find((d) => d.path === values.modelStorageRoot);
  return (
    <div className="ai-hardware">
      <div className="ai-section-heading">
        <div>
          <h4>Sur quelle carte graphique ?</h4>
        </div>
        <button type="button" onClick={refresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'ai-spinning' : ''} />
          {loading ? 'Détection…' : 'Actualiser'}
        </button>
      </div>
      {loading && <p role="status">Lecture des composants du serveur sélectionné…</p>}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div className="ai-machine-summary">
          <Server size={23} />
          <div>
            <strong>{hardware?.hostname || report.operatingSystem}</strong>
            <small>
              {hardware?.cpuModel || report.architecture} · {report.operatingSystem}
            </small>
          </div>
          <span>
            <b>{cpus}</b> CPU Docker
          </span>
          <span>
            <b>{ram} Gio</b> RAM Docker
          </span>
        </div>
      )}
      {hardware?.scope === 'windows-desktop' && (
        <p className="ai-inline-note">
          GPU de ce PC · CPU et RAM limités par la machine virtuelle Docker Desktop. Sur Ubuntu, les
          composants seront lus directement sur le serveur.
        </p>
      )}
      {report?.storage && (
        <p className="ai-hardware-storage">
          <HardDrive size={16} />
          <span>
            {report.storage.status === 'detected' && Number.isFinite(report.storage.availableGiB)
              ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(report.storage.availableGiB)} Gio libres sur le stockage Docker · ${report.storage.path}`
              : 'Espace disque non mesuré. La vérification du stockage apparaît au récapitulatif.'}
          </span>
        </p>
      )}
      {hardware?.status === 'unavailable' && <p className="ai-help">{hardware.reason}</p>}
      {report && !hardware && (
        <p className="ai-help">
          La version du serveur ne propose pas encore la détection matérielle. Redémarre Docker
          Tracer pour charger la mise à jour ; la saisie manuelle reste disponible.
        </p>
      )}
      <div className="ai-section-heading">
        <h5>Cartes graphiques NVIDIA</h5>
        <span>
          {selected.length} sélectionnée{selected.length > 1 ? 's' : ''}
        </span>
      </div>
      <div className="ai-gpu-list">
        {gpus.map((gpu) => {
          const checked = selected.includes(gpu);
          return (
            <label className={'ai-gpu-card' + (checked ? ' selected' : '')} key={gpu.uuid}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  update(
                    detectedGpuSettings(
                      checked ? selected.filter((g) => g.uuid !== gpu.uuid) : [...selected, gpu],
                    ),
                  )
                }
              />
              <Cpu size={30} />
              <span className="ai-gpu-info">
                <strong>{gpu.name}</strong>
                <small>
                  Carte {gpu.index} · {gpu.totalGiB} Gio de VRAM · pilote {gpu.driver}
                </small>
                <span className="ai-memory-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${gpu.freeGiB === null ? 0 : 100 * (1 - gpu.freeGiB / gpu.totalGiB)}%`,
                    }}
                  />
                </span>
                <small>
                  {gpu.freeGiB === null
                    ? 'Mémoire libre non disponible'
                    : `${gpu.freeGiB} Gio libres au relevé`}
                  {gpu.utilization === null ? '' : ` · utilisation ${gpu.utilization} %`}
                </small>
              </span>
              <span className="ai-gpu-state">{checked ? <Check size={20} /> : 'Choisir'}</span>
            </label>
          );
        })}
      </div>
      {hardware?.gpuMessage && <p className="ai-inline-note">{hardware.gpuMessage}</p>}
      {selected.some((g) => g.freeGiB !== null && g.freeGiB < g.totalGiB * values.gpuMemory) && (
        <p className="ai-error">
          D’autres applications occupent une partie de la VRAM choisie. vLLM peut manquer de mémoire
          au démarrage ; ajuste la mémoire allouée dans les réglages avancés ou libère les
          applications concernées.
        </p>
      )}
      {gpus.length > 0 && missing.length > 0 && (
        <p className="ai-error">
          La sélection enregistrée contient un GPU absent de ce relevé. Choisis les cartes de ce
          serveur ou vérifie la saisie manuelle.
        </p>
      )}
      {gpus.length > 0 && !values.gpuIds.length && (
        <p className="ai-error">Sélectionne au moins une carte graphique pour vLLM.</p>
      )}
      {selected.length > 1 && (
        <p className="ai-inline-note">
          Le modèle sera réparti entre ces cartes. Le dimensionnement utilise la plus petite VRAM de
          la sélection ; la compatibilité entre cartes reste à vérifier.
        </p>
      )}
      <details className="ai-hardware-budgets" open={resourceMode === 'manual' ? true : undefined}>
        <summary>
          CPU et mémoire ·{' '}
          {values.inferenceCpus ? `${values.inferenceCpus} CPU` : 'CPU sans limite'} ·{' '}
          {values.inferenceRamGiB ? `${values.inferenceRamGiB} Gio RAM` : 'RAM sans limite'}
        </summary>
        <div className="ai-section-heading">
          <h5>Ressources du moteur IA</h5>
          {ram >= 8 && cpus && useAvailableResources && (
            <button type="button" className="ai-text-button" onClick={useAvailableResources}>
              Utiliser les ressources disponibles
            </button>
          )}
        </div>
        <div className="ai-resource-grid">
          <label className="ai-resource-card">
            <span>
              <Cpu size={19} /> CPU du moteur IA
            </span>
            <strong>
              {values.inferenceCpus ?? 'Sans limite'}
              <small>{cpus ? ` / ${cpus} disponibles` : ''}</small>
            </strong>
            <input
              aria-label="CPU alloués au moteur IA"
              type="range"
              min="1"
              max={cpus || 64}
              step="1"
              value={values.inferenceCpus ?? cpus ?? 4}
              onChange={(e) => update({ inferenceCpus: Number(e.target.value) })}
            />
            <small>Un plafond de calcul, sans réserver des cœurs physiques.</small>
          </label>
          <label className="ai-resource-card">
            <span>
              <MemoryStick size={19} /> RAM du moteur IA
            </span>
            <strong>
              {values.inferenceRamGiB ?? 'Sans limite'}
              <small>
                {values.inferenceRamGiB ? ' Gio' : ''}
                {ram ? ` / ${ram} Gio Docker` : ''}
              </small>
            </strong>
            <input
              aria-label="RAM allouée au moteur IA"
              type="range"
              min="2"
              max={maxRam}
              step="1"
              value={values.inferenceRamGiB ?? maxRam}
              onChange={(e) =>
                update({
                  inferenceRamGiB: Number(e.target.value),
                  shmGiB: Math.min(
                    values.shmGiB,
                    Math.max(1, Math.floor(Number(e.target.value) / 2)),
                  ),
                  ...(ram ? { ramGiB: ram } : {}),
                })
              }
            />
            <small>
              {values.webRamGiB} Gio pour Open WebUI ; garde de la marge pour le système et les
              autres applications.
            </small>
          </label>
        </div>
      </details>
      {report &&
        ((values.inferenceCpus || 0) > cpus ||
          (values.inferenceRamGiB || 0) + values.webRamGiB + 2 > ram) && (
          <p className="ai-error">
            Les limites enregistrées dépassent les ressources Docker détectées. Ajuste les
            ressources avant le déploiement.
          </p>
        )}
      <details>
        <summary>
          Stockage des modèles · {values.modelStorageRoot || 'volume Docker du projet'}
        </summary>
        <div className="ai-section-heading">
          <h5>
            <HardDrive size={18} /> Stockage des modèles
          </h5>
        </div>
        <div className="ai-grid">
          <label>
            Disque de destination
            <select
              value={values.modelStorageRoot || ''}
              disabled={!!existing}
              onChange={(e) => update({ modelStorageRoot: e.target.value || undefined })}
            >
              <option value="">Stockage Docker par défaut (volume du projet)</option>
              {(hardware?.disks || []).map((d) => (
                <option key={d.path} value={d.path}>
                  {d.path} · {d.freeGiB} Gio libres · {d.device}
                </option>
              ))}
              {values.modelStorageRoot && !disk && (
                <option value={values.modelStorageRoot}>
                  {values.modelStorageRoot} · emplacement enregistré, non vérifié
                </option>
              )}
            </select>
          </label>
          {field('diskGiB', 'Capacité souhaitée pour les modèles (Gio)', 'number', { min: 20 })}
        </div>
        <p className="ai-inline-note">
          {hardware?.storageMessage || 'Les modèles restent dans le stockage Docker du serveur.'}{' '}
          L’espace indiqué est une prévision, pas un quota disque.
        </p>
        {values.modelStorageRoot && (
          <p className="ai-help">
            Dossier dédié : <code>{aiModelStoragePath(values.modelStorageRoot, projectName)}</code>
          </p>
        )}
        {disk && disk.freeGiB < values.diskGiB && (
          <p className="ai-error">
            Ce disque n’a que {disk.freeGiB} Gio libres pour {values.diskGiB} Gio prévus.
          </p>
        )}
        {existing && (
          <p className="ai-inline-note">
            L’emplacement d’un projet existant reste fixe pour conserver ses modèles. Un changement
            de disque nécessite une migration des données.
          </p>
        )}
      </details>
      <details open={!loading && !gpus.length ? true : undefined}>
        <summary>Saisie manuelle et identifiants du matériel</summary>
        <p className="ai-inline-note">
          Pour préparer une autre machine ou corriger une détection indisponible. Les valeurs
          saisies ne prouvent pas la présence du matériel.
        </p>
        <div className="ai-grid">
          {field('gpuName', 'Nom des GPU')}
          <label>
            Identifiants GPU (indices ou UUID, séparés par des virgules)
            <input
              value={values.gpuIds.join(',')}
              onChange={(e) =>
                update({
                  gpuIds: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          {field('vramGiB', 'VRAM par GPU ; minimum si différentes (Gio)', 'number', {
            min: 1,
            step: 0.1,
          })}
          {field('ramGiB', 'RAM disponible pour Docker (Gio)', 'number', { min: 8, step: 0.1 })}
          {field('inferenceCpus', 'Plafond CPU du moteur (vide : sans limite)', 'number', {
            min: 1,
          })}
          {field('inferenceRamGiB', 'Plafond RAM du moteur (Gio, vide : sans limite)', 'number', {
            min: 2,
          })}
        </div>
      </details>
    </div>
  );
}
