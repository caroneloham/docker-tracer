import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  Cpu,
  ShieldCheck,
  Database,
  Server,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  ArrowRight,
  Check,
  RefreshCw,
  ArrowLeft,
  Copy,
  HardDrive,
} from 'lucide-react';
import AiHardware, { detectedGpuSettings } from './AiHardware.jsx';
import {
  aiSchema,
  defaultAiSettings,
  newAiSecrets,
  aiSizing,
  aiUrl,
  buildAiCompose,
  readAiSettings,
  aiChanges,
} from '../shared/ai-infrastructure.mjs';
import { newCatalogProjectName } from '../shared/catalog.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import { AI_MODEL_PRESETS, findAiModel, aiModelWeightGiB } from '../shared/ai-models.mjs';
import { automaticAiResources } from '../shared/ai-resources.mjs';
import { visibleComposeProgress } from '../shared/compose-progress.mjs';
import './ai-infrastructure.css';

async function api(path, body, revision, method = 'POST') {
  const r = await fetch(
    '/api' + path,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Docker-Tracer': '1',
            ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
          },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Opération impossible.');
  return data;
}
function storageSize(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value)} Gio`
    : 'Non mesuré';
}

async function fetchStoragePreview(hostId, compose, signal) {
  const response = await fetch('/api/hosts/' + encodeURIComponent(hostId) + '/ai-storage-preview', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
    body: JSON.stringify({ source: compose.source, profiles: compose.profiles }),
  });
  if (
    response.status === 404 ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    throw Error(
      'Redémarre le serveur Docker Tracer pour activer la vérification du stockage. Tes réglages sont conservés.',
    );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Impossible de vérifier l’espace de stockage.');
  if (
    !['ready', 'insufficient', 'unknown'].includes(result.status) ||
    !result.estimate ||
    !result.storage
  )
    throw Error(
      'Le serveur n’a pas fourni une mesure de stockage exploitable. Actualise la vérification.',
    );
  return result;
}
const steps = [
  ['client', 'Ton projet', Server],
  ['model', 'Modèle & matériel', Cpu],
  ['access', 'Accès & options', ShieldCheck],
  ['review', 'Vérifier & déployer', Check],
];
export function AiEntry({ onClick, disabled = false }) {
  return (
    <button type="button" className="ai-entry" onClick={onClick} disabled={disabled}>
      <span className="ai-entry-icon">
        <BrainCircuit size={38} />
      </span>
      <span>
        <strong>Créer une infra IA</strong>
        <small>Un client, son modèle, ses documents et son accès sécurisé.</small>
        <em>Caddy · Open WebUI · vLLM · PostgreSQL</em>
      </span>
      <ArrowRight size={22} />
    </button>
  );
}

export default function AiInfrastructure({
  hosts = [],
  currentHost = 'local',
  existing = null,
  accountMayExist = !!existing,
  onOpen,
  onChange,
  onBusyChange = () => {},
  locked = false,
  onDownloadCertificate,
  deploymentProgress = '',
}) {
  const [values, setValues] = useState(() => {
    try {
      return existing
        ? readAiSettings(existing.source) || defaultAiSettings()
        : {
            ...defaultAiSettings(),
            client: 'Mon IA',
            model: 'Qwen/Qwen3-0.6B',
            parametersB: 0.6,
            toolMode: 'chat',
            domain: 'localhost',
            maxModelLen: 2048,
            maxSequences: 2,
            webRamGiB: 2,
          };
    } catch {
      return defaultAiSettings();
    }
  });
  const [variables, setVariables] = useState(() =>
    existing ? { ...existing.variables } : newAiSecrets(),
  );
  const [step, setStep] = useState('client'),
    [hostId, setHostId] = useState(currentHost),
    [name, setName] = useState(existing?.projectName || 'Mon IA');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [report, setReport] = useState(null),
    [reveal, setReveal] = useState(false);
  const [fileStatus, setFileStatus] = useState('');
  const [passwordCopyStatus, setPasswordCopyStatus] = useState('');
  const [portNotice, setPortNotice] = useState('');
  const [phase, setPhase] = useState(''),
    [progress, setProgress] = useState(''),
    [elapsed, setElapsed] = useState(0),
    [resourceMode, setResourceMode] = useState(existing ? 'manual' : 'auto');
  const [hardwareLoading, setHardwareLoading] = useState(false),
    [hardwareError, setHardwareError] = useState(''),
    [hardwareRefresh, setHardwareRefresh] = useState(0);
  const [storageCheck, setStorageCheck] = useState(null),
    [storageRefresh, setStorageRefresh] = useState(0),
    [storageAcknowledgement, setStorageAcknowledgement] = useState(null);
  const suffix = useRef(crypto.randomUUID().replaceAll('-', '').slice(0, 8)),
    working = useRef(false),
    hardwareTouched = useRef(!!existing),
    clientNameTouched = useRef(!!existing),
    createdProject = useRef(null),
    portsTouched = useRef(!!existing),
    storageRequest = useRef({ sequence: 0, controller: null }),
    stepHeading = useRef(null),
    previousStep = useRef(step);
  const updateHardware = (patch) => {
    hardwareTouched.current = true;
    const gpuSelection = Object.hasOwn(patch, 'gpuIds');
    if (!gpuSelection) setResourceMode('manual');
    setValues((v) => {
      const next = { ...v, ...patch };
      return gpuSelection && resourceMode === 'auto'
        ? { ...next, ...automaticAiResources(report, next) }
        : next;
    });
    setError('');
  };
  const set = (key, value) => {
    if (['httpPort', 'httpsPort'].includes(key)) portsTouched.current = true;
    if (
      [
        'gpuIds',
        'gpuName',
        'vramGiB',
        'ramGiB',
        'inferenceCpus',
        'inferenceRamGiB',
        'shmGiB',
        'webRamGiB',
        'wslCompatibility',
        'eagerExecution',
        'gpuMemory',
      ].includes(key)
    ) {
      hardwareTouched.current = true;
      setResourceMode('manual');
    }
    setValues((v) => ({ ...v, [key]: value }));
    setError('');
  };
  const secret = (key, value) => {
    setVariables((v) => ({ ...v, [key]: value }));
    setError('');
    if (key === 'AI_ADMIN_PASSWORD') setPasswordCopyStatus('');
  };
  const copyAdminPassword = async () => {
    try {
      await navigator.clipboard.writeText(variables.AI_ADMIN_PASSWORD || '');
      setPasswordCopyStatus('Mot de passe copié.');
    } catch {
      setPasswordCopyStatus('Copie indisponible. Affiche le mot de passe pour le copier.');
    }
  };
  const parsed = aiSchema.safeParse(values);
  const built = useMemo(() => {
    try {
      const compose = buildAiCompose(
        values,
        variables,
        existing?.projectName || newCatalogProjectName(name, suffix.current),
        existing,
      );
      return {
        compose,
        services: composeDocument(compose.source).model.services,
      };
    } catch (e) {
      return { error: e.issues?.map((i) => i.message).join(' ') || e.message };
    }
  }, [values, variables, name, existing]);
  const storageKey = built.error
    ? ''
    : JSON.stringify([hostId, built.compose.source, built.compose.profiles]);
  const activeStorageCheck = storageCheck?.key === storageKey ? storageCheck : null;
  const storagePreview = activeStorageCheck?.result;
  const storageUnknownReasons = [
    ...new Set([
      ...(storagePreview?.storage.status === 'unavailable'
        ? [storagePreview.storage.reason || 'L’espace libre du serveur n’a pas pu être mesuré.']
        : []),
      ...(storagePreview?.estimate.incompleteReasons || []),
    ]),
  ];
  const storageLoading = !!storageKey && (!activeStorageCheck || activeStorageCheck.loading);
  const storageAccepted =
    storagePreview?.status === 'unknown' &&
    storageAcknowledgement?.key === storageKey &&
    storageAcknowledgement?.sequence === activeStorageCheck?.sequence;
  const storagePreventsDeployment =
    storageLoading ||
    !storagePreview ||
    storagePreview.status === 'insufficient' ||
    (storagePreview.status === 'unknown' && !storageAccepted);
  const checkStorage = async () => {
    storageRequest.current.controller?.abort();
    const controller = new AbortController();
    const sequence = storageRequest.current.sequence + 1;
    storageRequest.current = { sequence, controller };
    setStorageAcknowledgement(null);
    setStorageCheck({ key: storageKey, sequence, loading: true });
    try {
      const result = await fetchStoragePreview(hostId, built.compose, controller.signal);
      if (controller.signal.aborted || storageRequest.current.sequence !== sequence)
        throw new DOMException('Vérification remplacée.', 'AbortError');
      setStorageCheck({ key: storageKey, sequence, loading: false, result });
      return result;
    } catch (error) {
      if (!controller.signal.aborted && storageRequest.current.sequence === sequence)
        setStorageCheck({ key: storageKey, sequence, loading: false, error: error.message });
      throw error;
    }
  };
  useEffect(() => {
    setStorageAcknowledgement(null);
    if (step === 'review' && storageKey) checkStorage().catch(() => {});
    return () => storageRequest.current.controller?.abort();
  }, [step, storageKey, storageRefresh]);
  const installedImages = Object.entries(built.services || {})
    .filter(
      ([, service]) =>
        service.image &&
        (!service.profiles?.length ||
          (Array.isArray(service.profiles) &&
            service.profiles.some((profile) => built.compose.profiles.includes(profile)))),
    )
    .map(([service, config]) => ({ service, image: config.image }));
  const unversionedImages = installedImages.filter(
    ({ image }) =>
      !image.includes('@') && (!image.split('/').at(-1).includes(':') || image.endsWith(':latest')),
  );
  const sizing = parsed.success ? aiSizing(parsed.data) : null;
  const activeHost = hosts.find((h) => h.id === hostId);
  const selectedPreset = findAiModel(values.model);
  const suggestedModel = [...AI_MODEL_PRESETS]
    .filter((model) => sizing && model.weightGiB < sizing.budgetGiB * 0.65)
    .sort((a, b) => b.parametersB - a.parametersB)[0];
  const database = values.database || {
    mode: 'managed',
    host: '',
    port: 5432,
    name: 'webui',
    user: 'webui',
    sslMode: 'require',
  };
  const setDatabase = (key, value) => set('database', { ...database, [key]: value });
  const useAvailableResources = () => {
    const patch = automaticAiResources(report, values);
    if (!patch) {
      setError(
        'Les ressources libres ne sont pas connues ou sont insuffisantes. Actualise le matériel, libère la mémoire occupée ou choisis une allocation manuelle.',
      );
      return;
    }
    hardwareTouched.current = false;
    setResourceMode('auto');
    setValues((v) => ({ ...v, ...patch }));
    setError('');
  };
  const projectName = existing?.projectName || newCatalogProjectName(name, suffix.current);
  useEffect(() => {
    const controller = new AbortController();
    setHardwareLoading(true);
    setHardwareError('');
    setReport(null);
    fetch('/api/hosts/' + encodeURIComponent(hostId) + '/ai-readiness', {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (
          !response.headers.get('content-type')?.includes('application/json') ||
          response.status === 404
        )
          throw Error('Redémarre Docker Tracer pour activer la détection du matériel.');
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'Détection du serveur impossible.');
        if (controller.signal.aborted) return;
        setReport(result);
        if (!existing && !portsTouched.current && result.occupiedTcpPorts?.length) {
          setValues((v) => {
            if (v.tls === 'public') return v;
            const occupied = new Set(result.occupiedTcpPorts.map(Number));
            const nextFree = (port) => {
              let next = Number(port);
              while (occupied.has(next) && next < 65535) next += 1;
              occupied.add(next);
              return next;
            };
            const httpPort = nextFree(v.httpPort);
            const httpsPort = nextFree(v.httpsPort);
            if (httpPort !== v.httpPort || httpsPort !== v.httpsPort)
              setPortNotice(
                `Ports libres proposés : HTTP ${httpPort}, HTTPS ${httpsPort}. Un port initial était déjà utilisé par un conteneur.`,
              );
            return { ...v, httpPort, httpsPort };
          });
        }
        if (!hardwareTouched.current && result.ramGiB >= 8 && result.cpus) {
          setValues((v) => {
            const selected = result.hardware?.gpus?.filter((gpu) =>
              v.gpuIds.some((id) => id === gpu.uuid || String(id) === String(gpu.index)),
            );
            const next = {
              ...v,
              wslCompatibility: result.hardware?.scope === 'windows-desktop',
              eagerExecution: result.hardware?.scope === 'windows-desktop',
              ...(result.hardware?.gpus?.length
                ? detectedGpuSettings(selected?.length ? selected : [result.hardware.gpus[0]])
                : {}),
            };
            return { ...next, ...automaticAiResources(result, next) };
          });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setHardwareError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHardwareLoading(false);
      });
    return () => controller.abort();
  }, [hostId, hardwareRefresh]);
  useEffect(() => {
    if (previousStep.current !== step) stepHeading.current?.scrollIntoView({ block: 'start' });
    previousStep.current = step;
  }, [step]);
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (existing) return;
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data);
        if (item.projectId === createdProject.current?.id && item.type === 'notice')
          setProgress((current) => (current + item.message + '\n').slice(-24000));
      } catch {
        // An invalid event must not interrupt an ongoing deployment request.
      }
    };
    return () => events.close();
  }, [existing]);
  const perform = async (fn) => {
    if (working.current || locked) return;
    working.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setPhase('');
    setProgress('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      working.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  const inspectHost = () => setHardwareRefresh((n) => n + 1);
  const save = (deploy = true) =>
    perform(async () => {
      if (built.error) throw Error(built.error);
      const capabilities = await api('/projects');
      if (!(capabilities.capabilities?.aiInfrastructureVersion >= 2))
        throw Error(
          'Redémarre le serveur Docker Tracer pour activer cette version du déploiement IA. Tes réglages sont conservés.',
        );
      if (deploy && resourceMode === 'auto' && !automaticAiResources(report, values))
        throw Error(
          'Impossible de calculer une allocation automatique avec ce relevé : la mémoire GPU libre est inconnue ou insuffisante. Actualise le matériel ou choisis « Personnaliser » pour définir les ressources manuellement. Tu peux aussi enregistrer sans déployer.',
        );
      if (deploy) {
        const acceptUnmeasuredStorage = storageAccepted;
        setPhase('Vérification de l’espace libre sur le serveur…');
        const preview = await checkStorage();
        if (preview.status === 'insufficient')
          throw Error(
            `Espace insuffisant sur le stockage Docker : ${storageSize(preview.storage.availableGiB)} libres pour ${storageSize(preview.estimate.dockerRequiredGiB)} prévus, réserve comprise. Aucun déploiement n’a été lancé.`,
          );
        if (preview.status === 'unknown' && !acceptUnmeasuredStorage)
          throw Error(
            'Le stockage n’est pas entièrement mesuré. Vérifie l’espace sur le serveur puis confirme les éléments non mesurés dans le récapitulatif avant de continuer.',
          );
      }
      if (existing) {
        setPhase(deploy ? 'Vérification et déploiement des changements…' : 'Enregistrement…');
        await onChange(built.compose, { deploy });
      } else {
        const alreadyCreated = !!createdProject.current;
        setPhase('Création du projet…');
        if (!createdProject.current) {
          const r = await api('/projects', {
            name,
            hostId,
            template: 'empty',
            compose: built.compose,
          });
          createdProject.current = r.project;
        }
        if (deploy) {
          const base = '/projects/' + encodeURIComponent(createdProject.current.id);
          setPhase('Vérification de la configuration et du serveur…');
          const state = await api(base + '/state');
          const plan = await api(base + '/compose/preview', built.compose, state.project.revision);
          setPhase('Téléchargement des images et démarrage des services…');
          const readyState = await api(base + '/state');
          await api(base + '/compose/apply', { token: plan.token }, readyState.project.revision);
        } else if (alreadyCreated) {
          const base = '/projects/' + encodeURIComponent(createdProject.current.id);
          const state = await api(base + '/state');
          await api(base + '/compose/source', built.compose, state.project.revision, 'PUT');
        }
        onOpen(createdProject.current);
      }
    });
  const readPem = async (e, key) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 24000) {
      setError('Maximum 24 Ko par fichier PEM.');
      return;
    }
    try {
      secret(key, await file.text());
      setFileStatus('Fichier chargé : ' + file.name);
    } catch {
      setError('Lecture du fichier impossible.');
    }
  };
  const field = (key, label, type = 'text', props = {}) => (
    <label>
      {label}
      <input
        type={type}
        value={values[key] ?? ''}
        onChange={(e) =>
          set(
            key,
            type === 'number'
              ? e.target.value === '' && ['inferenceCpus', 'inferenceRamGiB'].includes(key)
                ? undefined
                : Number(e.target.value)
              : e.target.value,
          )
        }
        {...props}
      />
    </label>
  );
  return (
    <div className="ai-builder">
      <header className="ai-heading">
        <BrainCircuit size={32} />
        <div>
          <h3>
            {existing ? 'Réglages de l’infrastructure IA' : 'Une IA privée pour chaque client'}
          </h3>
          <p>
            Choisis ton modèle et ton accès. Les services et leurs connexions sont préparés pour
            toi.
          </p>
        </div>
        <span className="ai-badge">{values.environment === 'production' ? 'CLIENT' : 'TEST'}</span>
      </header>
      <nav className="ai-steps" aria-label="Configuration de l’infrastructure IA">
        {steps.map(([id, title, Icon], i) => (
          <button
            type="button"
            disabled={busy || locked}
            key={id}
            aria-current={step === id ? 'step' : undefined}
            onClick={() => setStep(id)}
          >
            <span className="ai-step-number">{i + 1}</span>
            <span>{existing && id === 'review' ? 'Vérifier les changements' : title}</span>
          </button>
        ))}
      </nav>
      <div className="ai-step-position" ref={stepHeading}>
        Étape {steps.findIndex(([id]) => id === step) + 1} sur {steps.length}
        <span>Configuration {existing ? 'du projet' : 'd’une nouvelle infrastructure'}</span>
      </div>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          {createdProject.current && (
            <p>
              Le projet est conservé. Tu peux corriger les réglages et réessayer le déploiement.
              <button type="button" onClick={() => onOpen(createdProject.current)} disabled={busy}>
                Ouvrir le projet et ses logs
              </button>
            </p>
          )}
        </div>
      )}
      {busy && phase && (
        <div className="ai-operation" role="status" aria-live="polite">
          <RefreshCw size={20} className="ai-spinning" />
          <div>
            <strong>{phase}</strong>
            <small>
              {Math.floor(elapsed / 60)} min {String(elapsed % 60).padStart(2, '0')} s écoulées. Le
              premier démarrage peut prendre plusieurs minutes pour télécharger le modèle.
            </small>
            {(deploymentProgress || progress) && (
              <pre className="ai-operation-output" role="log">
                {deploymentProgress || visibleComposeProgress(progress)}
              </pre>
            )}
          </div>
        </div>
      )}
      <fieldset disabled={busy || locked} className="ai-fields">
        {step === 'client' && (
          <section>
            <h4>
              {existing ? 'Ton projet et son compte administrateur' : 'Comment s’appelle ton IA ?'}
            </h4>
            <div className="ai-grid">
              {!existing && (
                <label>
                  Nom de l’infrastructure
                  <input
                    required
                    disabled={!!createdProject.current}
                    maxLength={80}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!clientNameTouched.current) set('client', e.target.value);
                    }}
                  />
                </label>
              )}
              <label>
                Usage
                <select
                  value={values.environment}
                  onChange={(e) => set('environment', e.target.value)}
                >
                  <option value="test">Essai et validation</option>
                  <option value="production">Installation client</option>
                </select>
              </label>
              {(hosts.length > 1 || activeHost?.kind === 'ssh') && (
                <label>
                  Serveur cible
                  <select
                    disabled={!!existing || !!createdProject.current}
                    value={hostId}
                    onChange={(e) => {
                      setHostId(e.target.value);
                      setReport(null);
                      hardwareTouched.current = false;
                      setResourceMode('auto');
                      setValues((v) => ({
                        ...v,
                        gpuIds: ['0'],
                        gpuName: 'NVIDIA · à préciser',
                        vramGiB: 24,
                        ramGiB: 32,
                        inferenceCpus: undefined,
                        inferenceRamGiB: undefined,
                        modelStorageRoot: undefined,
                        wslCompatibility: undefined,
                        eagerExecution: undefined,
                      }));
                    }}
                  >
                    {hosts.length ? (
                      hosts.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.kind === 'ssh' ? h.name + ' · SSH' : 'Ce serveur · Docker local'}
                        </option>
                      ))
                    ) : (
                      <option value={hostId}>{hostId}</option>
                    )}
                  </select>
                </label>
              )}
            </div>
            <div className="ai-host-check">
              <Server size={23} />
              <div className="ai-host-description">
                <strong>
                  {activeHost?.kind === 'ssh' ? activeHost.name : 'Installation sur ce serveur'}
                </strong>
                <small>
                  {activeHost?.kind === 'ssh'
                    ? 'Moteur Docker distant par SSH'
                    : 'Docker Tracer utilise le Docker de cette machine.'}
                </small>
                {report && (
                  <small>
                    {report.operatingSystem} · {report.cpus} CPU · {report.ramGiB} Gio RAM Docker ·{' '}
                    {report.hardware?.gpus?.length || 0} GPU détecté(s)
                  </small>
                )}
                {hardwareLoading && <small role="status">Détection du matériel…</small>}
                {report && report.os !== 'linux' && (
                  <p className="ai-error">Docker Linux est requis pour cette infrastructure.</p>
                )}
              </div>
              <button type="button" onClick={inspectHost} disabled={hardwareLoading}>
                <RefreshCw size={15} />
                {hardwareLoading ? 'Détection…' : 'Actualiser'}
              </button>
            </div>
            {hardwareError && (
              <p className="ai-error" role="alert">
                {hardwareError}
              </p>
            )}
            <h4>Ton compte Open WebUI</h4>
            <p className="ai-inline-note">
              Ce compte permet d’ouvrir le chat privé. Tu peux utiliser le mot de passe généré ou
              choisir le tien, puis le transmettre au client pour qu’il le change dans Open WebUI.
            </p>
            <div className="ai-grid">
              {field('adminEmail', 'Email administrateur', 'email', { readOnly: accountMayExist })}
              <div className="ai-admin-password">
                <label>
                  Mot de passe initial du compte administrateur
                  <div className="ai-password">
                    <input
                      readOnly={accountMayExist}
                      type={reveal ? 'text' : 'password'}
                      value={variables.AI_ADMIN_PASSWORD || ''}
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={72}
                      onChange={(e) => secret('AI_ADMIN_PASSWORD', e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={
                        reveal ? 'Masquer le mot de passe IA' : 'Afficher le mot de passe IA'
                      }
                      onClick={() => setReveal(!reveal)}
                    >
                      {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>
                <div className="ai-password-tools">
                  {!accountMayExist && (
                    <button
                      type="button"
                      onClick={() => secret('AI_ADMIN_PASSWORD', newAiSecrets().AI_ADMIN_PASSWORD)}
                    >
                      <RefreshCw size={15} /> Générer un mot de passe
                    </button>
                  )}
                  <button type="button" onClick={copyAdminPassword}>
                    <Copy size={15} /> Copier
                  </button>
                </div>
                <small>
                  {accountMayExist
                    ? 'Mot de passe initial conservé ; il peut avoir été modifié dans Open WebUI.'
                    : '8 caractères minimum. Tu peux saisir un mot de passe facile à transmettre, sans règle de majuscules ni de symboles.'}
                </small>
                {passwordCopyStatus && <small role="status">{passwordCopyStatus}</small>}
              </div>
            </div>
            <p className="ai-inline-note">
              {accountMayExist
                ? 'Les comptes existants se modifient dans Open WebUI. Le mot de passe initial peut avoir été changé.'
                : 'Le compte sera créé au premier démarrage. Les inscriptions publiques sont fermées.'}
            </p>
            <details>
              <summary>Organisation et serveurs distants</summary>
              <div className="ai-grid">
                {field('client', 'Client / organisation', 'text', {
                  maxLength: 80,
                  onChange: (e) => {
                    clientNameTouched.current = true;
                    set('client', e.target.value);
                  },
                })}
              </div>
              <p className="ai-inline-note">
                Le nom du projet sert aussi de nom de client, sauf si tu le personnalises ici. Pour
                ajouter un serveur distant : « Tout Docker → Serveurs ».
              </p>
            </details>
          </section>
        )}
        {step === 'model' && (
          <section>
            <div className="ai-section-heading ai-model-heading">
              <div>
                <h4>Choisis ton modèle</h4>
              </div>
            </div>
            <p className="ai-inline-note">
              Cinq modèles Qwen et cinq Mistral. La mention « Vision » indique les modèles capables
              de comprendre des images. Tu peux aussi saisir ton propre modèle.
            </p>
            <div className="ai-resource-mode">
              <div>
                <strong>
                  {resourceMode === 'auto'
                    ? report && automaticAiResources(report, values)
                      ? 'Ressources disponibles utilisées'
                      : 'Allocation automatique · relevé à compléter'
                    : 'Allocation personnalisée'}
                </strong>
                <p>
                  {values.inferenceCpus || 'Tous les'} CPU ·{' '}
                  {values.inferenceRamGiB || 'Sans limite'} Gio RAM ·{' '}
                  {Math.round(values.gpuMemory * 100)} % de la VRAM des cartes sélectionnées.
                </p>
                <small>
                  Une marge reste pour Open WebUI, le système et le moteur GPU. Les ressources
                  affichées sont mesurées à cet instant, sans réservation exclusive.
                </small>
              </div>
              <div className="ai-resource-mode-actions" aria-label="Allocation des ressources">
                <button
                  type="button"
                  aria-pressed={resourceMode === 'auto'}
                  onClick={useAvailableResources}
                  disabled={hardwareLoading || !report}
                >
                  Utiliser les ressources disponibles
                </button>
                <button
                  type="button"
                  aria-pressed={resourceMode === 'manual'}
                  onClick={() => {
                    hardwareTouched.current = true;
                    setResourceMode('manual');
                  }}
                >
                  Personnaliser
                </button>
              </div>
            </div>
            {['Qwen', 'Mistral'].map((family) => (
              <div className="ai-model-family" key={family}>
                <h5>
                  {family} <span>5 modèles</span>
                </h5>
                <div className="ai-presets">
                  {AI_MODEL_PRESETS.filter((model) => model.family === family).map((preset) => (
                    <button
                      type="button"
                      key={preset.model}
                      aria-pressed={values.model === preset.model}
                      className={values.model === preset.model ? 'selected' : ''}
                      onClick={() => {
                        setValues((v) => ({
                          ...v,
                          model: preset.model,
                          parametersB: preset.parametersB,
                          modelRevision: '',
                          toolParser: preset.toolParser,
                        }));
                        setError('');
                      }}
                    >
                      <BrainCircuit size={23} />
                      <strong>{preset.label}</strong>
                      <span
                        className={'ai-model-capability' + (preset.vision ? ' has-vision' : '')}
                      >
                        {preset.vision ? <Eye size={14} /> : null}
                        {preset.vision ? 'Vision · texte et images' : 'Texte uniquement'}
                      </span>
                      <small>{preset.description}</small>
                      {preset.model === suggestedModel?.model && (
                        <span className="ai-suggestion-tag">
                          Poids adaptés à la mémoire allouée*
                        </span>
                      )}
                      <span className="ai-model-size">
                        ≈ {preset.weightGiB} Gio de poids · {preset.precision}
                      </span>
                      {sizing && preset.weightGiB >= sizing.budgetGiB && (
                        <small className="ai-model-warning">Plus de VRAM nécessaire</small>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="ai-inline-note">
              * Estimation des poids, avec une marge pour le contexte. La compatibilité et la
              vitesse dépendent aussi du GPU et de la configuration du modèle.
            </p>
            <p className="ai-selected-model">
              <Check size={16} /> Modèle choisi : <strong>{values.model}</strong>
              <span>
                {selectedPreset
                  ? selectedPreset.vision
                    ? 'Vision disponible'
                    : 'Sans vision'
                  : 'Vision : à vérifier pour ce modèle personnalisé'}
              </span>
            </p>
            <details className="ai-custom-model">
              <summary>Choisir un autre modèle ou une révision précise</summary>
              <div className="ai-grid">
                {field('model', 'Modèle Hugging Face')}
                {field('modelRevision', 'Révision du modèle (commit ou tag, facultatif)')}
                {field('parametersB', 'Taille du modèle, milliards de paramètres', 'number', {
                  min: 0.1,
                  step: 0.1,
                })}
              </div>
            </details>
            <details className="ai-sizing" open={sizing && !sizing.fitsWeights ? true : undefined}>
              <summary>Vérifier la mémoire nécessaire</summary>
              <strong>
                {sizing
                  ? `Poids estimés : ${Math.round(aiModelWeightGiB(values.model, values.parametersB) * 10) / 10} Gio · mémoire GPU allouée : ${sizing.budgetGiB} Gio`
                  : 'Complète les réglages pour estimer les poids.'}
              </strong>
              <p>
                {sizing && !sizing.fitsWeights
                  ? 'Les poids seuls dépassent la mémoire GPU allouée. Utilise les ressources disponibles, choisis un modèle plus petit ou ajoute un GPU. '
                  : ''}
                Estimation selon la précision du modèle, hors cache KV, contexte et surcharge du
                moteur. Les modèles personnalisés sont estimés en 16 bits. Il ne s’agit pas d’un
                budget financier.
              </p>
            </details>
            <AiHardware
              values={values}
              update={updateHardware}
              report={report}
              loading={hardwareLoading}
              error={hardwareError}
              refresh={inspectHost}
              existing={existing}
              projectName={projectName}
              field={field}
              resourceMode={resourceMode}
              useAvailableResources={useAvailableResources}
            />
            <div className="ai-chat-mode">
              <div className="ai-grid">
                <label>
                  Fonctionnement du modèle
                  <select
                    value={values.toolMode || ''}
                    onChange={(e) => {
                      set('toolMode', e.target.value);
                      if (!values.toolParser) set('toolParser', 'hermes');
                      if (e.target.value === 'native' && values.maxModelLen < 8192)
                        set('maxModelLen', 8192);
                    }}
                  >
                    {!values.toolMode && <option value="">Ancien réglage · à vérifier</option>}
                    <option value="chat">Chat simple · pour valider un modèle</option>
                    <option value="native">Chat et outils · modèle compatible requis</option>
                  </select>
                </label>
                {values.toolMode === 'native' &&
                  field('toolParser', 'Format des appels d’outils vLLM')}
              </div>
              <p className="ai-inline-note">
                {values.toolMode === 'chat'
                  ? 'Pour valider le modèle : chat sans outils automatiques ni recherche documentaire agentique.'
                  : 'Les outils demandent un modèle compatible et davantage de mémoire. Le contexte passe à au moins 8 192 tokens quand tu actives ce mode.'}
              </p>
              <details>
                <summary>Compatibilité des appels d’outils</summary>
                <p className="ai-inline-note">
                  Le format « hermes » convient aux modèles Qwen2.5 et Qwen3 ; pour un autre modèle,
                  vérifie son format dans la documentation vLLM. Les réglages propres à un modèle
                  déjà personnalisé dans Open WebUI restent prioritaires.
                </p>
              </details>
            </div>
            <details>
              <summary>Réglages du moteur et versions des images</summary>
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={!!values.wslCompatibility}
                  onChange={(e) => set('wslCompatibility', e.target.checked)}
                />
                Compatibilité Docker Desktop / WSL
              </label>
              <p className="ai-help">
                Pour les essais sous Windows, utilise le moteur vLLM compatible avec WSL. Sur Ubuntu
                natif, laisse cette option désactivée.
              </p>
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={!!values.eagerExecution}
                  onChange={(e) => set('eagerExecution', e.target.checked)}
                />
                Démarrage simple, sans compilation GPU
              </label>
              <p className="ai-help">
                Utile pour les essais et les pilotes qui bloquent pendant l’optimisation. Ce mode
                peut réduire le débit ; le modèle continue de tourner sur le GPU.
              </p>
              <div className="ai-grid">
                {field('maxModelLen', 'Contexte maximal (tokens)', 'number', { min: 512 })}
                {field('startupMinutes', 'Délai de démarrage par service (minutes)', 'number', {
                  min: 2,
                  max: 30,
                })}
                {field('maxSequences', 'Séquences simultanées maximales', 'number', { min: 1 })}
                {field('gpuMemory', 'Fraction de VRAM utilisée', 'number', {
                  min: 0.1,
                  max: 0.95,
                  step: 0.05,
                })}
                {field('shmGiB', 'Mémoire partagée du moteur (Gio)', 'number', { min: 1 })}
                {field('webRamGiB', 'Limite RAM Open WebUI (Gio)', 'number', { min: 2 })}
                <label>
                  Précision
                  <select value={values.dtype} onChange={(e) => set('dtype', e.target.value)}>
                    <option value="auto">Automatique</option>
                    <option value="half">FP16</option>
                    <option value="bfloat16">BF16</option>
                  </select>
                </label>
                {Object.entries(values.images).map(([key, value]) => (
                  <label key={key}>
                    Image {key}
                    <input
                      value={value}
                      onChange={(e) => set('images', { ...values.images, [key]: e.target.value })}
                    />
                  </label>
                ))}
                <label>
                  Jeton Hugging Face (modèle à accès restreint)
                  <input
                    type="password"
                    autoComplete="off"
                    value={variables.AI_HF_TOKEN || ''}
                    onChange={(e) => secret('AI_HF_TOKEN', e.target.value)}
                  />
                </label>
              </div>
            </details>
          </section>
        )}
        {step === 'access' && (
          <section>
            <h4>Comment ouvrir le chat ?</h4>
            <p className="ai-inline-note">
              Caddy protège l’accès HTTPS. Le moteur IA et la base de données restent privés.
            </p>
            <div className="ai-grid">
              {field('domain', 'Nom DNS ou IPv4 d’accès')}
              <label>
                Certificat Caddy
                <select
                  value={values.tls}
                  onChange={(e) => {
                    set('tls', e.target.value);
                    if (e.target.value === 'public') {
                      set('httpsPort', 443);
                      set('httpPort', 80);
                    }
                  }}
                >
                  <option value="internal">Autorité locale Caddy · réseau privé / VPN</option>
                  <option value="provided">Certificat fourni par le client · PEM</option>
                  <option value="public">Certificat public automatique · domaine public</option>
                </select>
              </label>
              {values.tls === 'public' &&
                field('acmeEmail', 'Email de renouvellement ACME', 'email')}
              {values.tls === 'provided' && (
                <>
                  <label>
                    Certificat et chaîne PEM
                    <input
                      type="file"
                      accept=".pem,.crt,.cer"
                      onChange={(e) => readPem(e, 'AI_TLS_CERT')}
                    />
                    <small>
                      {variables.AI_TLS_CERT ? 'Certificat chargé' : 'Aucun certificat chargé'}
                    </small>
                  </label>
                  <label>
                    Clé privée PEM
                    <input
                      type="file"
                      accept=".pem,.key"
                      onChange={(e) => readPem(e, 'AI_TLS_KEY')}
                    />
                    <small>
                      {variables.AI_TLS_KEY ? 'Clé chargée et masquée' : 'Aucune clé chargée'}
                    </small>
                  </label>
                  <p role="status">{fileStatus}</p>
                </>
              )}
            </div>
            <p className="ai-access-preview">
              <ShieldCheck size={19} />
              {parsed.success ? aiUrl(parsed.data) : 'Complète l’adresse pour afficher le lien.'}
            </p>
            <p className="ai-inline-note">
              {values.tls === 'internal'
                ? 'Sur le réseau privé, les postes clients doivent faire confiance au certificat racine Caddy. Tu pourras le télécharger après le déploiement.'
                : values.tls === 'provided'
                  ? 'Le certificat, sa clé, sa validité et le nom couvert seront vérifiés à la préparation. Le renouvellement de ce certificat reste à ta charge.'
                  : 'Le DNS doit pointer vers le serveur et les ports 80/443 doivent être joignables depuis Internet pour ACME. Le challenge DNS et ses fournisseurs ne sont pas configurés ici.'}
            </p>
            {values.tls === 'internal' && onDownloadCertificate && (
              <button type="button" onClick={onDownloadCertificate}>
                <ShieldCheck size={16} />
                Télécharger le certificat racine déployé
              </button>
            )}
            <details>
              <summary>
                Ports et adresse d’écoute · {values.bindIp}:{values.httpsPort}
              </summary>
              {portNotice && <p className="ai-inline-note">{portNotice}</p>}
              <div className="ai-grid">
                {field('bindIp', 'Adresse d’écoute sur le serveur')}
                {field('httpsPort', 'Port HTTPS publié', 'number', { min: 1, max: 65535 })}
                {field('httpPort', 'Port HTTP publié (redirection)', 'number', {
                  min: 1,
                  max: 65535,
                })}
              </div>
              <p className="ai-inline-note">
                127.0.0.1 : accès depuis le serveur seulement. Pour le VPN/LAN, indique son adresse
                privée. 0.0.0.0 écoute sur toutes les interfaces : restreins l’accès au niveau du
                réseau et du pare-feu. Le nom doit être résolu par le DNS du client.
              </p>
              <details>
                <summary>Ports internes des services</summary>
                <div className="ai-grid">
                  {field('webPort', 'Port interne Open WebUI', 'number', { min: 1, max: 65535 })}
                  {field('enginePort', 'Port interne vLLM', 'number', { min: 1, max: 65535 })}
                </div>
                <p>
                  Toutes les connexions et les contrôles de santé générés seront mis à jour
                  ensemble.
                </p>
              </details>
            </details>
            <div className="ai-access-scope">
              {values.bindIp === '127.0.0.1'
                ? 'Accès limité à ce serveur. Pour les postes du client, renseigne l’adresse LAN ou VPN dans « Ports et adresse d’écoute ».'
                : `Accès via ${values.bindIp === '0.0.0.0' ? 'toutes les interfaces du serveur' : values.bindIp}. Le DNS du client doit résoudre le nom choisi.`}
            </div>
            <div className="ai-database-options">
              <div className="ai-section-heading">
                <h4>
                  <Database size={21} /> Base de données du chat
                </h4>
              </div>
              <div className="ai-database-choices" aria-label="Emplacement de la base de données">
                <button
                  type="button"
                  aria-pressed={database.mode === 'managed'}
                  onClick={() =>
                    set('database', {
                      mode: 'managed',
                      host: '',
                      port: 5432,
                      name: 'webui',
                      user: 'webui',
                      sslMode: 'require',
                    })
                  }
                >
                  <Database size={22} />
                  <strong>Créer PostgreSQL pour moi</strong>
                  <small>Base privée et stockage gérés avec cette infrastructure.</small>
                </button>
                <button
                  type="button"
                  aria-pressed={database.mode === 'external'}
                  onClick={() => setDatabase('mode', 'external')}
                >
                  <Server size={22} />
                  <strong>Connecter une base existante</strong>
                  <small>Utiliser un serveur PostgreSQL externe.</small>
                </button>
              </div>
              {database.mode === 'external' && (
                <>
                  <p className="ai-inline-note">
                    Prépare une base PostgreSQL dédiée, vide, accessible depuis les conteneurs. Open
                    WebUI y conservera les comptes et conversations. Ce raccordement ne donne pas au
                    modèle un accès aux données métier du client.
                  </p>
                  <div className="ai-grid">
                    <label>
                      Hôte PostgreSQL
                      <input
                        value={database.host}
                        placeholder="postgres.client.lan"
                        onChange={(e) => setDatabase('host', e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Port PostgreSQL
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={database.port}
                        onChange={(e) => setDatabase('port', Number(e.target.value))}
                      />
                    </label>
                    <label>
                      Nom de la base
                      <input
                        value={database.name}
                        onChange={(e) => setDatabase('name', e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Utilisateur PostgreSQL
                      <input
                        value={database.user}
                        onChange={(e) => setDatabase('user', e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Mot de passe PostgreSQL externe
                      <input
                        type="password"
                        value={variables.AI_EXTERNAL_DB_PASSWORD || ''}
                        onChange={(e) => secret('AI_EXTERNAL_DB_PASSWORD', e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                    <label>
                      Connexion à PostgreSQL
                      <select
                        value={database.sslMode}
                        onChange={(e) => setDatabase('sslMode', e.target.value)}
                      >
                        <option value="require">TLS obligatoire (chiffrement)</option>
                        <option value="prefer">TLS si disponible</option>
                        <option value="disable">Sans TLS</option>
                      </select>
                    </label>
                  </div>
                  <p className="ai-inline-note">
                    L’hôte ne doit contenir ni protocole ni port. « localhost » désigne le
                    conteneur, pas ton serveur PostgreSQL. Le mode TLS chiffre la connexion sans
                    vérifier l’identité du serveur distant.
                  </p>
                </>
              )}
              {existing && (
                <p className="ai-help">
                  Changer de base ne transfère ni comptes ni conversations. L’ancien volume reste
                  conservé ; une migration de tes données doit être préparée séparément.
                </p>
              )}
            </div>
            <details className="ai-data-options">
              <summary>
                Documents et outils{' '}
                <span>
                  {values.tools.length ? `${values.tools.length} API configurée(s)` : 'Facultatif'}
                </span>
              </summary>
              <h4>Documents privés et recherche RAG</h4>
              <p>
                Le RAG est intégré à Open WebUI : documents, index Chroma et modèles d’embeddings
                restent sur le serveur. Importe les documents et attribue leurs permissions dans
                l’espace de connaissances Open WebUI.
              </p>
              <details>
                <summary>Réglages de recherche documentaire</summary>
                <div className="ai-grid">
                  {field('embeddingModel', 'Modèle d’embeddings local')}
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={values.embeddingAutoUpdate !== false}
                      onChange={(e) => set('embeddingAutoUpdate', e.target.checked)}
                    />
                    Actualiser le modèle documentaire au démarrage
                  </label>
                  {field('chunkSize', 'Taille des fragments', 'number', { min: 100 })}
                  {field('chunkOverlap', 'Chevauchement des fragments', 'number', { min: 0 })}
                  {field('ragTopK', 'Passages récupérés par recherche', 'number', { min: 1 })}
                </div>
                <p className="ai-help">
                  Changer de modèle d’embeddings nécessite de réindexer les documents dans Open
                  WebUI. Les modèles sont téléchargés au premier démarrage ; ce profil n’est pas une
                  installation hors ligne.
                </p>
              </details>
              <h4>Outils et API du client</h4>
              <p>
                Raccorde des serveurs OpenAPI / MCPO existants, accessibles depuis le serveur. Leur
                installation et leurs droits métier restent propres au client.
              </p>
              {values.toolMode !== 'native' && (
                <p className="ai-inline-note">
                  Ajouter une API activera le mode « Chat et outils » avec un contexte d’au moins 8
                  192 tokens. Vérifie ensuite la compatibilité de ton modèle à l’étape Modèle &
                  matériel.
                </p>
              )}
              {values.tools.map((t, i) => (
                <div className="ai-tool" key={i}>
                  <div className="ai-grid">
                    {[
                      ['name', 'Nom de l’outil'],
                      ['url', 'URL du serveur'],
                      ['path', 'Chemin de la spécification OpenAPI'],
                    ].map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          value={t[key]}
                          onChange={(e) =>
                            set(
                              'tools',
                              values.tools.map((x, j) =>
                                j === i ? { ...x, [key]: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </label>
                    ))}
                    <label>
                      Authentification
                      <select
                        value={t.auth}
                        onChange={(e) =>
                          set(
                            'tools',
                            values.tools.map((x, j) =>
                              j === i ? { ...x, auth: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        <option value="none">Aucune</option>
                        <option value="bearer">Clé Bearer</option>
                      </select>
                    </label>
                    {t.auth === 'bearer' && (
                      <label>
                        Clé de l’outil
                        <input
                          type="password"
                          value={variables['AI_TOOL_KEY_' + i] || ''}
                          onChange={(e) => secret('AI_TOOL_KEY_' + i, e.target.value)}
                        />
                      </label>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={'Retirer l’outil ' + (t.name || i + 1)}
                    onClick={() => {
                      set(
                        'tools',
                        values.tools.filter((_, j) => i !== j),
                      );
                      setVariables((v) => {
                        const n = { ...v };
                        for (let j = i; j < values.tools.length; j++)
                          n['AI_TOOL_KEY_' + j] = v['AI_TOOL_KEY_' + (j + 1)] || '';
                        return n;
                      });
                    }}
                  >
                    <Trash2 size={15} />
                    Retirer
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={values.tools.length >= 8}
                onClick={() => {
                  set('tools', [
                    ...values.tools,
                    { name: '', url: '', path: 'openapi.json', auth: 'none' },
                  ]);
                  set('toolMode', 'native');
                  if (!values.toolParser) set('toolParser', 'hermes');
                  if (values.maxModelLen < 8192) set('maxModelLen', 8192);
                }}
              >
                <Plus size={16} />
                Ajouter un outil OpenAPI
              </button>
              <div className="ai-storage">
                <Database size={24} />
                <div>
                  <strong>Des stockages persistants, propres au projet</strong>
                  <p>
                    Comptes et conversations PostgreSQL · documents et index · poids des modèles ·
                    cache vLLM · certificats et configuration Caddy.
                  </p>
                  <small>
                    Les volumes persistent après l’arrêt ; ils ne remplacent pas une sauvegarde.
                    Prévois un dump PostgreSQL et une sauvegarde cohérente des documents et
                    certificats avant les mises à jour.
                  </small>
                </div>
              </div>
            </details>
          </section>
        )}
        {step === 'review' && (
          <section>
            <h4>{existing ? 'Vérifier les modifications' : 'Vérifie ton infrastructure'}</h4>
            <div className="ai-flow" aria-label="Parcours de la requête">
              <span>
                <ShieldCheck />
                Caddy<small>HTTPS · {values.httpsPort}</small>
              </span>
              <ArrowRight />
              <span>
                <BrainCircuit />
                Open WebUI
                <small>{values.toolMode === 'chat' ? 'Chat simple' : 'Chat + RAG + outils'}</small>
              </span>
              <ArrowRight />
              <span>
                <Cpu />
                vLLM<small>{values.model}</small>
              </span>
              <span>
                <Database />
                PostgreSQL
                <small>
                  {database.mode === 'external' ? 'Serveur externe' : 'Données privées'}
                </small>
              </span>
            </div>
            <dl className="ai-summary">
              <div>
                <dt>Client</dt>
                <dd>
                  {values.client} ·{' '}
                  {values.environment === 'production'
                    ? 'Installation client'
                    : 'Essai et validation'}
                </dd>
              </div>
              <div>
                <dt>Cible</dt>
                <dd>
                  {hostId === 'local' ? 'Ce serveur · Docker local' : activeHost?.name || hostId}
                </dd>
              </div>
              <div>
                <dt>Accès prévu</dt>
                <dd>
                  {parsed.success ? aiUrl(parsed.data) : 'À compléter'} · écoute {values.bindIp}
                </dd>
              </div>
              <div>
                <dt>Matériel sélectionné</dt>
                <dd>
                  {values.gpuName} · {values.gpuIds.length} GPU · {values.vramGiB} Gio minimum par
                  carte
                </dd>
              </div>
              <div>
                <dt>Limites du moteur IA</dt>
                <dd>
                  {values.inferenceCpus ? `${values.inferenceCpus} CPU` : 'CPU sans plafond'} ·{' '}
                  {values.inferenceRamGiB
                    ? `${values.inferenceRamGiB} Gio RAM`
                    : 'RAM sans plafond'}
                </dd>
              </div>
              <div>
                <dt>Compte administrateur</dt>
                <dd>{values.adminEmail}</dd>
              </div>
              <div>
                <dt>Base de données du chat</dt>
                <dd>
                  {database.mode === 'external'
                    ? `${database.host}:${database.port} · ${database.name} · PostgreSQL externe`
                    : 'PostgreSQL privé créé sur ce serveur'}
                </dd>
              </div>
              <div>
                <dt>Documents et outils</dt>
                <dd>
                  {values.toolMode === 'chat'
                    ? 'Chat simple, sans outils automatiques'
                    : `Recherche documentaire · ${values.tools.length} API configurée(s)`}
                </dd>
              </div>
              <div>
                <dt>Stockage des modèles</dt>
                <dd>{values.modelStorageRoot || 'Volume Docker du projet'}</dd>
              </div>
            </dl>
            <div
              className="ai-storage-preview"
              aria-label="Vérification du stockage avant déploiement"
            >
              <div className="ai-storage-preview-heading">
                <div>
                  <HardDrive size={24} />
                  <h4>De la place pour cette installation ?</h4>
                </div>
                <button
                  type="button"
                  disabled={!storageKey || storageLoading}
                  onClick={() => setStorageRefresh((value) => value + 1)}
                >
                  <RefreshCw size={15} className={storageLoading ? 'ai-spinning' : ''} />
                  {storageLoading ? 'Vérification…' : 'Actualiser l’espace libre'}
                </button>
              </div>
              <p className="ai-inline-note">
                Cette vérification ne télécharge rien et ne réserve pas d’espace.
              </p>
              {storageLoading && (
                <p role="status">
                  Lecture de l’espace disponible et des images déjà présentes sur le serveur…
                </p>
              )}
              {built.error && (
                <p className="ai-inline-note">Complète les réglages pour vérifier le stockage.</p>
              )}
              {activeStorageCheck?.error && (
                <p className="ai-error" role="alert">
                  {activeStorageCheck.error} Tu peux enregistrer le brouillon sans déployer.
                </p>
              )}
              {storagePreview && (
                <>
                  <p className={'ai-storage-verdict ' + storagePreview.status} role="status">
                    {storagePreview.status === 'ready'
                      ? 'L’espace mesuré couvre cette estimation.'
                      : storagePreview.status === 'insufficient'
                        ? 'Espace insuffisant. Libère de l’espace sur le serveur ou enregistre un brouillon.'
                        : 'Certains éléments restent à vérifier sur le serveur.'}
                  </p>
                  <dl className="ai-storage-main-values">
                    <div>
                      <dt>Espace libre réel · stockage Docker</dt>
                      <dd>{storageSize(storagePreview.storage.availableGiB)}</dd>
                      {storagePreview.storage.status === 'detected' && (
                        <small>sur {storageSize(storagePreview.storage.totalGiB)}</small>
                      )}
                    </div>
                    <div>
                      <dt>À prévoir sur ce stockage</dt>
                      <dd>
                        {!storagePreview.estimate.complete ? '≥ ' : ''}
                        {storageSize(storagePreview.estimate.dockerRequiredGiB)}
                      </dd>
                      <small>
                        {storagePreview.estimate.complete
                          ? 'Estimation, réserve comprise'
                          : 'Estimation incomplète, réserve comprise'}
                      </small>
                    </div>
                  </dl>
                  <dl className="ai-storage-breakdown">
                    <div>
                      <dt>
                        {storagePreview.estimate.imageCacheChecked
                          ? 'Images Docker manquantes'
                          : 'Images Docker à vérifier'}
                      </dt>
                      <dd>
                        {storagePreview.estimate.unknownImages?.length
                          ? `${storageSize(storagePreview.estimate.imagesGiB)} + part inconnue`
                          : storageSize(storagePreview.estimate.imagesGiB)}
                      </dd>
                    </div>
                    <div>
                      <dt>Poids du modèle sélectionné</dt>
                      <dd>{storageSize(storagePreview.estimate.modelGiB)}</dd>
                    </div>
                    <div>
                      <dt>Réserve conservée</dt>
                      <dd>{storageSize(storagePreview.estimate.reserveGiB)}</dd>
                    </div>
                  </dl>
                  <p className="ai-inline-note">
                    {storagePreview.estimate.imageCacheChecked
                      ? 'Images présentes prises en compte ; cache du modèle non vérifié.'
                      : 'Cache des images et du modèle non vérifié.'}
                  </p>
                  {storagePreview.status === 'unknown' && storageUnknownReasons.length > 0 && (
                    <p className="ai-inline-note">
                      {storageUnknownReasons[0]}
                      {storageUnknownReasons.length > 1
                        ? ' Consulte les autres points dans « Détails du calcul ».'
                        : ''}
                    </p>
                  )}
                  <details>
                    <summary>Détails du calcul</summary>
                    {storagePreview.storage.status === 'detected' && (
                      <p className="ai-storage-location">
                        Stockage mesuré : <code>{storagePreview.storage.path}</code>
                        {storagePreview.checkedAt
                          ? ` · relevé à ${new Date(storagePreview.checkedAt).toLocaleTimeString('fr-FR')}`
                          : ''}
                      </p>
                    )}
                    {storageUnknownReasons.length > 0 && (
                      <ul className="ai-checklist">
                        {storageUnknownReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                    {storagePreview.estimate.modelStorage?.status === 'unverified' && (
                      <div className="ai-storage-separate">
                        <strong>Emplacement personnalisé pour les modèles</strong>
                        <p>
                          <code>{storagePreview.estimate.modelStorage.path}</code> ·{' '}
                          {storageSize(storagePreview.estimate.modelStorage.requiredGiB)} à prévoir,
                          espace libre non mesuré.
                        </p>
                        <small>
                          Ce dossier peut partager le disque Docker ou être sur un autre disque. Ces
                          poids sont exclus du besoin affiché sur le stockage Docker. Total prévu :{' '}
                          {storageSize(storagePreview.estimate.requiredGiB)}.
                        </small>
                      </div>
                    )}
                    {storagePreview.estimate.message && (
                      <p className="ai-inline-note">{storagePreview.estimate.message}</p>
                    )}
                    {storagePreview.estimate.missingImages?.length > 0 && (
                      <p>
                        {storagePreview.estimate.imageCacheChecked
                          ? 'Absentes du cache : '
                          : 'Présence à vérifier : '}
                        <code>{storagePreview.estimate.missingImages.join(', ')}</code>
                      </p>
                    )}
                    {storagePreview.estimate.unknownImages?.length > 0 && (
                      <p>
                        Taille non estimée :{' '}
                        <code>{storagePreview.estimate.unknownImages.join(', ')}</code>
                      </p>
                    )}
                  </details>
                  {storagePreview.status === 'unknown' && (
                    <label className="ai-storage-acknowledgement">
                      <input
                        type="checkbox"
                        checked={storageAccepted}
                        onChange={(event) =>
                          setStorageAcknowledgement(
                            event.target.checked
                              ? { key: storageKey, sequence: activeStorageCheck.sequence }
                              : null,
                          )
                        }
                      />
                      <span>
                        J’ai vérifié l’espace disponible sur le serveur et les emplacements non
                        mesurés. Je souhaite poursuivre ce déploiement malgré cette estimation
                        incomplète.
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
            {!built.error && (
              <div className="ai-installation-summary">
                <h4>Ce qui sera installé</h4>
                <p className="ai-inline-note">
                  Le catalogue ne télécharge rien. Seuls les services de cette infrastructure et le
                  modèle choisi sont préparés au déploiement.
                </p>
                <div className="ai-installation-model">
                  <BrainCircuit size={24} />
                  <div>
                    <span>Modèle IA choisi</span>
                    <strong>{values.model}</strong>
                    <small>
                      ≈ {Math.round(aiModelWeightGiB(values.model, values.parametersB) * 10) / 10}{' '}
                      Gio de poids
                      {' · '}
                      {selectedPreset?.precision || 'estimation en 16 bits'}
                      {' · '}
                      {selectedPreset
                        ? selectedPreset.vision
                          ? 'Texte et images'
                          : 'Texte uniquement'
                        : 'Vision à vérifier'}
                    </small>
                    <small>Estimation des poids, pas du volume à télécharger.</small>
                  </div>
                </div>
                <ul
                  className="ai-installation-images"
                  aria-label="Images Docker de cette infrastructure"
                >
                  {installedImages.map(({ service, image }) => (
                    <li key={service}>
                      <Server size={18} />
                      <div>
                        <strong>
                          {{
                            caddy: 'Accès HTTPS · Caddy',
                            webui: 'Chat · Open WebUI',
                            inference: 'Moteur IA · vLLM',
                            database: 'Base de données · PostgreSQL',
                          }[service] || service}
                        </strong>
                        <code>{image}</code>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="ai-inline-note">
                  Docker réutilise ses images déjà présentes sur ce serveur. Les poids de ce modèle
                  restent dans le stockage du projet ; ils ne sont pas partagés automatiquement
                  entre projets ou serveurs.
                </p>
                <p className="ai-inline-note">
                  Recherche documentaire : <code>{values.embeddingModel}</code>, téléchargé si
                  nécessaire par Open WebUI pour les documents.
                </p>
                {unversionedImages.length > 0 && (
                  <p className="ai-help">
                    {unversionedImages.map(({ image }) => image).join(', ')} : ces images utilisent
                    « latest » ou n’ont pas de version. Compose consulte le registre au déploiement
                    même si elles sont déjà présentes, et peut télécharger une mise à jour.
                  </p>
                )}
              </div>
            )}
            {sizing && !sizing.fitsWeights && (
              <p className="ai-error">
                Les poids de ce modèle dépassent la mémoire GPU allouée. Reviens à « Modèle &
                matériel » pour adapter le choix avant de déployer.
              </p>
            )}
            {built.error ? (
              <p className="ai-error" role="alert">
                {built.error}
              </p>
            ) : (
              <p className="ai-impact">
                Services dont la configuration change :{' '}
                {aiChanges(existing?.source, built.compose.source).join(', ') || 'aucun'}. Le bouton
                de déploiement applique cette configuration au serveur. Une modification peut
                redémarrer les services concernés.
              </p>
            )}
            <details>
              <summary>Prérequis et conservation des données</summary>
              <ul className="ai-checklist">
                <li>
                  Le pilote NVIDIA et NVIDIA Container Toolkit doivent déjà fonctionner dans Docker
                  sur la cible.
                </li>
                <li>
                  La mémoire libre affichée est un relevé ponctuel, pas une réservation. Les
                  performances du modèle et l’espace nécessaire doivent être validés sur le serveur.
                </li>
                <li>
                  La configuration Open WebUI est pilotée par Docker Tracer ; les changements de
                  paramètres administrateur faits dans Open WebUI ne persistent pas au redémarrage.
                  Les comptes, chats et documents persistent.
                </li>
                <li>
                  Les secrets sont conservés dans les données locales du projet et transmis au
                  serveur choisi. Ce stockage local n’est pas un coffre chiffré.
                </li>
              </ul>
            </details>
            <p className="ai-draft-note">
              « {existing ? 'Appliquer et déployer' : 'Créer et déployer'} » télécharge les images,
              prépare les données et démarre les services. Le premier chargement du modèle peut
              durer plusieurs minutes. Tu peux aussi conserver un brouillon sans démarrer Docker.
            </p>
          </section>
        )}
        <footer className="ai-actions">
          {step !== 'client' && (
            <button
              type="button"
              onClick={() => setStep(steps[steps.findIndex(([id]) => id === step) - 1][0])}
            >
              <ArrowLeft size={16} />
              Précédent
            </button>
          )}
          <span>
            {busy ? 'Déploiement en cours…' : 'Tes réglages restent modifiables depuis le schéma.'}
          </span>
          {step !== 'review' ? (
            <button
              type="button"
              className="catalog-primary"
              onClick={() => setStep(steps[steps.findIndex(([id]) => id === step) + 1][0])}
            >
              Continuer
              <ArrowRight size={16} />
            </button>
          ) : (
            <div className="ai-final-actions">
              <button
                type="button"
                disabled={
                  hardwareLoading || !!built.error || !name.trim() || (!existing && !hosts.length)
                }
                onClick={() => save(false)}
              >
                Enregistrer sans déployer
              </button>
              <button
                type="button"
                className="catalog-primary"
                disabled={
                  hardwareLoading ||
                  !!built.error ||
                  !name.trim() ||
                  (!existing && !hosts.length) ||
                  storagePreventsDeployment
                }
                onClick={() => save(true)}
              >
                <Check size={16} />
                {existing ? 'Appliquer et déployer' : 'Créer et déployer'}
              </button>
            </div>
          )}
        </footer>
      </fieldset>
    </div>
  );
}
