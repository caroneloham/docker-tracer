import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import AddContainer from './AddContainer.jsx';
import DockerImagePicker from './DockerImagePicker.jsx';
import ContainerWorkbench from './ContainerWorkbench.jsx';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  useReactFlow,
  ConnectionMode,
  BaseEdge,
  getStraightPath,
} from '@xyflow/react';
import {
  FolderOpen,
  BrainCircuit,
  Save,
  Play,
  Square,
  RefreshCw,
  Plus,
  Network,
  FileCode,
  History,
  Download,
  Trash2,
  X,
  Settings2,
  Cpu,
  Cable,
  HardDrive,
  ListFilter,
  Box,
} from 'lucide-react';
import YAML from 'yaml';
import EquipmentIcon from './EquipmentIcon.jsx';
import ComposeNetworkEditor from './ComposeNetworkEditor.jsx';
import ComposeConnectionDialog from './ComposeConnectionDialog.jsx';
import RedundancyDialog from './RedundancyDialog.jsx';
import {
  composeConnectionTarget,
  composeConnectionChanges,
  serviceNetworks,
} from '../shared/compose-connections.mjs';
import ComposeEquipmentPalette from './ComposeEquipmentPalette.jsx';
import { addComposeEquipment } from '../shared/compose-equipment.mjs';
import ComposeResources from './ComposeResources.jsx';
import Projects, { projectRequest } from './Projects.jsx';
import AiServiceSettings from './AiServiceSettings.jsx';
import { AI_EXTENSION } from '../shared/ai-infrastructure.mjs';
import { detectAiServices } from '../shared/ai-service-context.mjs';
import { visibleComposeProgress } from '../shared/compose-progress.mjs';
import { reconcileFlowNodes } from '../shared/flow-nodes.mjs';
import { catalogConnection } from '../shared/catalog.mjs';
import Inventory from './Inventory.jsx';
import { WorkspaceModal } from './WorkspacePanels.jsx';
import { DeploymentHistory, DeploymentResult } from './Deployments.jsx';
import {
  composeGraph,
  composeDocument,
  composeSettings,
  patchComposeObject,
  addComposeObject,
  removeComposeObject,
  connectComposeNetwork,
} from '../shared/compose-project.mjs';
import './compose.css';
import './browser.css';
import { BROWSER_MODE, LOCAL_APP_URL } from './browser-mode.js';
import { AUTODOCKER_LOGO_URL } from './autodocker-logo.js';
import BrowserDownloads from './BrowserDownloads.jsx';
import './compose-connections.css';
import './redundancy.css';

const labels = {
  running: 'En marche',
  exited: 'Arrêté',
  created: 'Créé',
  restarting: 'Redémarrage',
  paused: 'En pause',
  dead: 'En erreur',
};
const Device = memo(function Device({ data, selected }) {
  const instances = data.instances || [],
    healthy =
      instances.length && instances.every((i) => i.state === 'running' && i.health !== 'unhealthy');
  return (
    <div
      className={'device compose-device ' + (selected ? 'selected' : '')}
      title={
        (data.displayName || data.name) +
        ' · sélectionner pour configurer' +
        (data.note ? ' · ' + data.note : '')
      }
    >
      <Handle id="left" type="source" position={Position.Left} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <div className="device-picture">
        <EquipmentIcon
          kind={data.icon}
          image={data.kind === 'service' ? data.description : undefined}
        />
        <span className={'device-led ' + (healthy ? 'live' : instances.length ? 'stopped' : '')} />
      </div>
      <strong style={data.color ? { color: data.color } : undefined}>
        {data.displayName || data.name}
      </strong>
      <small title={data.description}>{data.description}</small>
      {data.subnet && <small>{data.subnet}</small>}
      {data.kind === 'service' && (
        <span className={healthy ? 'live' : 'idle'}>
          {BROWSER_MODE
            ? 'Dans le fichier'
            : instances.length
            ? `${instances.filter((i) => i.state === 'running').length}/${instances.length} en marche`
            : data.plannedReplicas > 1
              ? `${data.plannedReplicas} instances à déployer`
              : 'À déployer'}
        </span>
      )}
    </div>
  );
});
const nodeTypes = { composeDevice: Device };
function ComposeCable(props) {
  const [path] = getStraightPath(props),
    dx = props.targetX - props.sourceX,
    dy = props.targetY - props.sourceY;
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: props.selected ? '#1772b4' : props.data?.color || '#303538',
          strokeWidth: 1.5,
        }}
      />
      {[0.07, 0.93].map((t) => (
        <path
          key={t}
          d="M-4-3 4 0-4 3Z"
          transform={`translate(${props.sourceX + dx * t} ${props.sourceY + dy * t}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + (t > 0.5 ? 180 : 0)})`}
          fill={props.data?.running ? '#41a43a' : '#929da4'}
        />
      ))}
    </>
  );
}
const edgeTypes = { composeCable: ComposeCable };
const obj = (value) =>
  Array.isArray(value)
    ? Object.fromEntries(
        value.map((s) => {
          const i = s.indexOf('=');
          return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
        }),
      )
    : value || {};
const brief = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const portLabel = (port) => {
  if (!port || typeof port !== 'object') {
    if (String(port).includes('${')) return String(port);
    const [address, protocol = 'tcp'] = String(port).split('/');
    const parts = address.split(':'),
      target = parts.pop(),
      published = parts.length ? parts.pop() : '';
    const host = parts.join(':');
    return `${host ? host + ':' : ''}${published || 'Port automatique'} → ${target} / ${protocol.toUpperCase()}`;
  }
  const hostIp = String(port.host_ip || '');
  const ip = hostIp
    ? (hostIp.includes(':') && !hostIp.startsWith('[') ? '[' + hostIp + ']' : hostIp) + ':'
    : '';
  return `${ip}${port.published || 'Port automatique'} → ${port.target ?? 'Non défini'} / ${String(port.protocol || 'tcp').toUpperCase()}`;
};
const download = (name, content, type = 'text/yaml;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function ValueEditor({ label, value, onApply }) {
  const [text, setText] = useState(value === undefined ? '' : YAML.stringify(value)),
    [error, setError] = useState('');
  useEffect(() => {
    setText(value === undefined ? '' : YAML.stringify(value));
  }, [value]);
  return (
    <details className="compose-value">
      <summary>{label}</summary>
      <textarea
        aria-label={label}
        rows={5}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => {
          try {
            const d = YAML.parseDocument(text, { merge: true, uniqueKeys: true });
            if (d.errors.length) throw d.errors[0];
            onApply(text.trim() ? d.toJS({ maxAliasCount: 100 }) : undefined);
            setError('');
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        Appliquer ce champ au brouillon
      </button>
    </details>
  );
}
function Pairs({ title, value, onApply }) {
  const [rows, setRows] = useState(() => Object.entries(obj(value))),
    [error, setError] = useState('');
  useEffect(() => {
    setRows(Object.entries(obj(value)));
  }, [value]);
  return (
    <section className="compose-field-group">
      <h3>{title}</h3>
      {rows.map(([key, val], i) => (
        <div className="compose-pair" key={i}>
          <input
            aria-label={`${title} nom ${i + 1}`}
            placeholder="NOM"
            value={key}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, val] : r)))}
          />
          <input
            aria-label={`${title} valeur ${i + 1}`}
            placeholder={val === null ? 'Héritée par Compose' : 'Valeur'}
            value={val ?? ''}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? [key, e.target.value] : r)))}
          />
          <button
            type="button"
            aria-label={`Retirer ${title} ${i + 1}`}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="compose-buttons">
        <button type="button" onClick={() => setRows([...rows, ['', '']])}>
          Ajouter une variable
        </button>
        <button
          type="button"
          onClick={() => {
            if (rows.some(([k]) => !k.trim()) || new Set(rows.map(([k]) => k)).size !== rows.length)
              return setError('Chaque nom doit être renseigné et unique.');
            setError('');
            onApply(Object.fromEntries(rows));
          }}
        >
          Appliquer les variables
        </button>
      </div>
    </section>
  );
}
function PortEditor({ value = [], onChange }) {
  value ||= [];
  const [host, setHost] = useState(''),
    [target, setTarget] = useState('80'),
    [ip, setIp] = useState(''),
    [protocol, setProtocol] = useState('tcp'),
    [editingIndex, setEditingIndex] = useState(null);
  const fields = (port) => {
    if (typeof port === 'object' && port)
      return /^\d+$/.test(String(port.target)) &&
        (!port.published || /^\d+$/.test(String(port.published)))
        ? {
            target: String(port.target),
            host: String(port.published || ''),
            ip: port.host_ip || '',
            protocol: port.protocol || 'tcp',
          }
        : null;
    const [address, proto = 'tcp'] = String(port).split('/'),
      parts = address.split(':'),
      to = parts.pop(),
      from = parts.length ? parts.pop() : '';
    return /^\d+$/.test(to) && (!from || /^\d+$/.test(from))
      ? { target: to, host: from, ip: parts.join(':').replace(/^\[|\]$/g, ''), protocol: proto }
      : null;
  };
  const reset = () => {
    setEditingIndex(null);
    setHost('');
    setTarget('80');
    setIp('');
    setProtocol('tcp');
  };
  return (
    <section className="compose-field-group">
      <h3>Ports publiés</h3>
      {value.map((v, i) => (
        <div className="compose-entry" key={i}>
          <code>{portLabel(v)}</code>
          <button
            type="button"
            aria-label={`Modifier le port ${i + 1}`}
            disabled={!fields(v)}
            title={
              fields(v)
                ? 'Modifier ce port'
                : 'Utilise les options complètes pour les plages ou variables Compose'
            }
            onClick={() => {
              const f = fields(v);
              setEditingIndex(i);
              setHost(f.host);
              setTarget(f.target);
              setIp(f.ip);
              setProtocol(f.protocol);
            }}
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            aria-label={`Retirer le port ${i + 1}`}
            onClick={() => {
              onChange(value.filter((_, j) => j !== i));
              if (editingIndex === i) reset();
              else if (editingIndex !== null && editingIndex > i) setEditingIndex(editingIndex - 1);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {editingIndex !== null && (
        <p className="field-hint">
          Modification du port {editingIndex + 1}. Valide ci-dessous pour l’ajouter au brouillon.
        </p>
      )}
      <div className="compose-form-grid">
        <label>
          Port du serveur
          <input
            type="number"
            min="1"
            max="65535"
            placeholder="Automatique"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </label>
        <label>
          Port du conteneur
          <input
            type="number"
            min="1"
            max="65535"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label>
          Adresse d’écoute
          <input
            placeholder="Toutes les adresses"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
          />
        </label>
        <label>
          Protocole
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option>tcp</option>
            <option>udp</option>
            {!['tcp', 'udp'].includes(protocol) && <option>{protocol}</option>}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={
          !/^\d+$/.test(target) ||
          +target < 1 ||
          +target > 65535 ||
          (!!host && (!/^\d+$/.test(host) || +host < 1 || +host > 65535))
        }
        onClick={() => {
          const previous =
            editingIndex !== null && typeof value[editingIndex] === 'object'
              ? value[editingIndex]
              : {};
          const next = {
            ...previous,
            target: +target,
            published: host || undefined,
            protocol,
            host_ip: ip || undefined,
          };
          onChange(
            editingIndex === null
              ? [...value, next]
              : value.map((v, i) => (i === editingIndex ? next : v)),
          );
          reset();
        }}
      >
        {editingIndex === null ? 'Publier ce port' : 'Modifier ce port dans le brouillon'}
      </button>
      {editingIndex !== null && (
        <button type="button" onClick={reset}>
          Annuler la modification du port
        </button>
      )}
      <ValueEditor label="Options complètes des ports" value={value} onApply={onChange} />
    </section>
  );
}
function MountEditor({ value = [], model, onChange, onAdd }) {
  value ||= [];
  const [type, setType] = useState('volume'),
    [source, setSource] = useState(''),
    [target, setTarget] = useState('/data'),
    [ro, setRo] = useState(false);
  return (
    <section className="compose-field-group">
      <h3>Stockage du service</h3>
      {value.map((v, i) => (
        <div className="compose-entry" key={i}>
          <code>{brief(v)}</code>
          <button
            type="button"
            aria-label={`Retirer le montage ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="compose-form-grid">
        <label>
          Type de stockage
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="volume">Volume Docker</option>
            <option value="bind">Dossier du serveur</option>
            <option value="tmpfs">Mémoire temporaire</option>
          </select>
        </label>
        {type !== 'tmpfs' && (
          <label>
            {type === 'volume' ? 'Nom du volume (existant ou nouveau)' : 'Chemin sur le serveur'}
            <input
              list="compose-volumes"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <datalist id="compose-volumes">
              {Object.keys(model.volumes || {}).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </datalist>
          </label>
        )}
        <label>
          Dossier dans le conteneur
          <input value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="compose-check">
          <input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} />
          Lecture seule
        </label>
      </div>
      <button
        type="button"
        disabled={
          !target.startsWith('/') ||
          (type !== 'tmpfs' && !source) ||
          (type === 'volume' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(source))
        }
        onClick={() =>
          onAdd({ type, ...(type !== 'tmpfs' ? { source } : {}), target, read_only: ro })
        }
      >
        Ajouter ce montage
      </button>
      <ValueEditor label="Options complètes des montages" value={value} onApply={onChange} />
    </section>
  );
}

function ServiceInstances({ instances, onAction, onLogs, onTools }) {
  if (!instances.length)
    return (
      <p className="compose-instance-empty">
        {BROWSER_MODE
          ? 'Aucune instance Docker dans le navigateur. Configure le service et exporte le Compose pour le tester localement.'
          : 'Pas encore déployé. Configure ce service puis prépare le déploiement.'}
      </p>
    );
  return instances.map((c) => (
    <article className="compose-instance" key={c.id}>
      <div className="compose-instance-heading">
        <strong>{labels[c.state] || c.state}</strong>
        {c.health && (
          <span className={'compose-health ' + c.health}>
            {c.health === 'healthy'
              ? 'Sain'
              : c.health === 'unhealthy'
                ? 'À vérifier'
                : 'Démarrage'}
          </span>
        )}
      </div>
      <small title={c.name}>{c.name}</small>
      {!!c.ips?.length && <small>{c.ips.join(' · ')}</small>}
      <div className="compose-buttons compose-instance-actions">
        <button
          type="button"
          disabled={c.state !== 'running'}
          onClick={() => onTools(c, 'terminal')}
        >
          Terminal
        </button>
        <button type="button" onClick={() => onTools(c, 'files')}>
          Fichiers
        </button>
        <button type="button" onClick={() => onLogs(c)}>
          <FileCode size={14} />
          Logs
        </button>
        <button type="button" onClick={() => onAction(c, c.state === 'running' ? 'stop' : 'start')}>
          {c.state === 'running' ? <Square size={14} /> : <Play size={14} />}
          {c.state === 'running' ? 'Arrêter' : 'Démarrer'}
        </button>
        <button type="button" onClick={() => onAction(c, 'restart')}>
          <RefreshCw size={14} />
          Redémarrer
        </button>
      </div>
    </article>
  ));
}

function ObjectEditor({
  hostId,
  selected,
  model,
  patch,
  change,
  source,
  runtime,
  onAction,
  onLogs,
  onSource,
  onAiSettings,
  onClearSelection,
  onTools,
  initialSection = 'image',
}) {
  const [editorSection, setEditorSection] = useState(initialSection);
  useEffect(() => setEditorSection(initialSection), [selected, initialSection]);
  const [kind, name] = selected.split(/:(.*)/s),
    section = kind === 'service' ? 'services' : kind === 'network' ? 'networks' : 'volumes',
    value = model[section]?.[name] || {};
  const set = (field, v) => patch(section, name, field, v);
  if (!Object.hasOwn(model[section] || {}, name) && !(kind === 'network' && name === 'default'))
    return (
      <>
        <h2>{name}</h2>
        <p>
          {runtime[name]?.length
            ? 'Ce service est encore déployé, mais il n’est pas déclaré dans le fichier Compose principal. Ses conteneurs restent gérables ci-dessous. Vérifie les fichiers inclus ou sa déclaration avant de modifier sa configuration.'
            : 'Cet équipement n’apparaît pas dans le fichier principal et aucun conteneur correspondant n’est détecté. Il a pu être retiré, renommé ou déclaré dans un fichier inclus. Sélectionne une autre machine sur la carte, ou consulte la configuration complète.'}
        </p>
        {!!runtime[name]?.length && (
          <ServiceInstances
            instances={runtime[name]}
            onAction={onAction}
            onLogs={onLogs}
            onTools={onTools}
          />
        )}
        <button type="button" onClick={onSource}>
          <FileCode size={14} />
          Ouvrir la configuration complète
        </button>
        <button type="button" onClick={onClearSelection}>
          Revenir à la carte
        </button>
      </>
    );
  if (kind === 'network')
    return (
      <>
        <ComposeNetworkEditor name={name} value={value} model={model} runtime={runtime} set={set} />
        <ValueEditor
          label="Toutes les options IPAM"
          value={value.ipam}
          onApply={(v) => set('ipam', v)}
        />
        <ValueEditor
          label="Options du pilote"
          value={value.driver_opts}
          onApply={(v) => set('driver_opts', v)}
        />
        <ValueEditor label="Labels Docker" value={value.labels} onApply={(v) => set('labels', v)} />
      </>
    );
  if (kind !== 'service')
    return (
      <>
        <h2>
          {kind === 'network' ? 'Réseau' : 'Volume'} · {name}
        </h2>
        <label>
          Pilote
          <input
            value={value.driver || ''}
            placeholder={kind === 'network' ? 'bridge' : 'local'}
            onChange={(e) => set('driver', e.target.value || undefined)}
          />
        </label>
        <label>
          Nom Docker explicite
          <input
            value={value.name || ''}
            placeholder="Préfixé par le projet"
            onChange={(e) => set('name', e.target.value || undefined)}
          />
        </label>
        <label className="compose-check">
          <input
            type="checkbox"
            checked={!!value.external}
            onChange={(e) => set('external', e.target.checked || undefined)}
          />
          Ressource externe déjà présente
        </label>
        <ValueEditor
          label="Options du pilote"
          value={value.driver_opts}
          onApply={(v) => set('driver_opts', v)}
        />
        <ValueEditor label="Labels" value={value.labels} onApply={(v) => set('labels', v)} />
      </>
    );
  const networks = new Set([...Object.keys(model.networks || {}), 'default']),
    assigned = Object.keys(serviceNetworks(value));
  return (
    <>
      <div className="compose-editor-heading">
        <span>Gérer ce service</span>
        <h2>{name}</h2>
      </div>
      <ServiceInstances
        instances={runtime[name] || []}
        onAction={onAction}
        onLogs={onLogs}
        onTools={onTools}
      />
      {onAiSettings && (
        <button type="button" className="compose-ai-shortcut" onClick={onAiSettings}>
          <BrainCircuit size={16} />
          Modifier les réglages du moteur IA
        </button>
      )}
      <h3 className="compose-editor-title">
        <Settings2 size={15} />
        Modifier la configuration
      </h3>
      <nav className="compose-editor-sections" aria-label={'Réglages du service ' + name}>
        {[
          ['image', 'Image', Box],
          ['resources', 'Ressources', Cpu],
          ['ports', 'Ports', Cable],
          ['networks', 'Réseaux', Network],
          ['storage', 'Stockage', HardDrive],
          ['environment', 'Variables', ListFilter],
          ['advanced', 'Avancé', FileCode],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            aria-pressed={editorSection === id}
            onClick={() => setEditorSection(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>
      <div className="compose-editor-section" hidden={editorSection !== 'image'}>
        <label>
          Image Docker
          <input
            value={value.image || ''}
            placeholder="nginx:alpine"
            onChange={(e) => set('image', e.target.value || undefined)}
          />
        </label>
        <label>
          Redémarrage automatique
          <select value={value.restart || 'no'} onChange={(e) => set('restart', e.target.value)}>
            <option value="no">Jamais</option>
            <option value="unless-stopped">Sauf arrêt manuel</option>
            <option value="always">Toujours</option>
            <option value="on-failure">En cas d’échec</option>
            {value.restart?.startsWith('on-failure:') && (
              <option value={value.restart}>{value.restart}</option>
            )}
          </select>
        </label>
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'resources'}>
        {editorSection === 'resources' && (
          <ComposeResources
            source={source}
            name={name}
            service={value}
            hostId={hostId}
            onChange={change}
          />
        )}
        <ValueEditor
          label="GPU et ressources avancées"
          value={value.deploy?.resources}
          onApply={(v) => set('deploy', { ...value.deploy, resources: v })}
        />
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'environment'}>
        <Pairs
          title="Variables du service"
          value={value.environment}
          onApply={(v) => set('environment', v)}
        />
        <p className="field-hint">
          Valide avec « Appliquer les variables » pour les ajouter au brouillon. Un mot de passe
          initial ne remplace pas celui d’une base déjà créée.
        </p>
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'ports'}>
        <PortEditor value={value.ports} onChange={(v) => set('ports', v)} />
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'storage'}>
        <MountEditor
          value={value.volumes}
          model={model}
          onChange={(v) => set('volumes', v)}
          onAdd={(v) => {
            let s = source;
            if (v.type === 'volume' && !Object.hasOwn(model.volumes || {}, v.source))
              s = addComposeObject(s, 'volumes', v.source);
            change(
              patchComposeObject(s, 'services', name, 'volumes', [...(value.volumes || []), v]),
            );
          }}
        />
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'networks'}>
        <section className="compose-field-group">
          <h3>Connexions réseau</h3>
          <label>
            Mode réseau
            <select
              value={value.network_mode || 'networks'}
              onChange={(e) => {
                let s = patchComposeObject(source, 'services', name, 'networks', undefined);
                change(
                  patchComposeObject(
                    s,
                    'services',
                    name,
                    'network_mode',
                    e.target.value === 'networks' ? undefined : e.target.value,
                  ),
                );
              }}
            >
              <option value="networks">Réseaux Docker</option>
              <option value="none">Isolé, sans réseau</option>
              <option value="host">Réseau de l’hôte</option>
              {value.network_mode && !['none', 'host'].includes(value.network_mode) && (
                <option value={value.network_mode}>{value.network_mode}</option>
              )}
            </select>
          </label>
          {!value.network_mode &&
            [...networks].map((n) => (
              <div key={n}>
                <label className="compose-check">
                  <input
                    type="checkbox"
                    checked={assigned.includes(n)}
                    onChange={(e) =>
                      change(connectComposeNetwork(source, name, n, e.target.checked))
                    }
                  />
                  {n}
                </label>
                {assigned.includes(n) && (
                  <div className="compose-form-grid">
                    {['aliases', 'ipv4_address'].map((field) => (
                      <label key={field}>
                        {field === 'aliases' ? `Alias sur ${n}` : `IPv4 fixe sur ${n}`}
                        <input
                          value={
                            field === 'aliases'
                              ? (value.networks?.[n]?.aliases || []).join(', ')
                              : value.networks?.[n]?.[field] || ''
                          }
                          onChange={(e) => {
                            const ns = Array.isArray(value.networks)
                              ? Object.fromEntries(value.networks.map((v) => [v, null]))
                              : value.networks || { default: null };
                            set('networks', {
                              ...ns,
                              [n]: {
                                ...ns[n],
                                [field]:
                                  field === 'aliases'
                                    ? e.target.value
                                        .split(',')
                                        .map((s) => s.trim())
                                        .filter(Boolean)
                                    : e.target.value || undefined,
                              },
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          <ValueEditor
            label="Options complètes des réseaux"
            value={value.networks}
            onApply={(v) => set('networks', v)}
          />
        </section>
      </div>
      <div className="compose-editor-section" hidden={editorSection !== 'advanced'}>
        <ValueEditor
          label="Contrôle de santé Compose"
          value={value.healthcheck}
          onApply={(v) => set('healthcheck', v)}
        />
        <ValueEditor
          label="Commande du conteneur"
          value={value.command}
          onApply={(v) => set('command', v)}
        />
        <ValueEditor
          label="Labels du service"
          value={value.labels}
          onApply={(v) => set('labels', v)}
        />
        <p className="field-hint">
          Build, secrets, configs, dépendances et autres options restent dans le fichier Compose.
          L’onglet Configuration complète permet de les modifier dans cette interface.
        </p>
        <button type="button" onClick={onSource}>
          <FileCode size={14} />
          Ouvrir la configuration complète
        </button>
      </div>
    </>
  );
}

export default function ComposeWorkspace({
  project,
  onOpenProject,
  initialSelection,
  initialInventory,
  initialSection = 'image',
  initialImportPreview = false,
  onImportCompose,
  onWorkspaceStatus,
}) {
  const [state, setState] = useState(null),
    [draft, setDraft] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [view, setView] = useState('map'),
    [selected, setSelected] = useState(initialSelection || null),
    [nodes, setNodes] = useState([]),
    [projectsOpen, setProjectsOpen] = useState(false),
    [inventory, setInventory] = useState(!!initialInventory && !initialSelection),
    [modal, setModal] = useState(null),
    [connectionMode, setConnectionMode] = useState(false),
    [connectionStart, setConnectionStart] = useState(null),
    [connectionTarget, setConnectionTarget] = useState(null),
    [redundancyTarget, setRedundancyTarget] = useState(null),
    [contextMenu, setContextMenu] = useState(null),
    [dropRequest, setDropRequest] = useState(null),
    [newName, setNewName] = useState(''),
    [progress, setProgress] = useState('');
  const [addHost, setAddHost] = useState(null),
    [imagePicker, setImagePicker] = useState(false),
    [workbench, setWorkbench] = useState(null),
    [instanceChoice, setInstanceChoice] = useState(null),
    [editorSection, setEditorSection] = useState(initialSection);
  const flow = useReactFlow();
  const current = useRef(null),
    inspector = useRef(null),
    canvas = useRef(null),
    browserProjectInput = useRef(null),
    serviceDropPosition = useRef(null),
    dropSequence = useRef(0),
    skipNextFit = useRef(false),
    contextMenuPanel = useRef(null),
    pending = useRef(false),
    base = '/api/projects/' + project.id;
  const focusEquipment = (id) => {
    setSelected(id);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  };
  const onNodesChange = (changes) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    // React Flow emits one final position batch for all dragged nodes, and the
    // same kind of completed batch for keyboard moves. Keep pointer frames local.
    const finished = changes.filter((c) => c.type === 'position' && c.position && !c.dragging);
    if (finished.length)
      setDraft((d) => {
        if (
          !d ||
          !finished.some(
            (c) => d.positions[c.id]?.x !== c.position.x || d.positions[c.id]?.y !== c.position.y,
          )
        )
          return d;
        return {
          ...d,
          positions: {
            ...d.positions,
            ...Object.fromEntries(finished.map((c) => [c.id, c.position])),
          },
        };
      });
  };
  const sourceModel = useMemo(() => {
    try {
      return draft ? composeDocument(draft.source).model : {};
    } catch {
      return {};
    }
  }, [draft?.source]);
  const aiServices = useMemo(() => detectAiServices(sourceModel), [sourceModel]);
  useEffect(() => {
    if (view === 'ai' && aiServices.length === 0) setView('map');
  }, [view, aiServices]);
  const parsed = useMemo(() => {
    try {
      return draft
        ? {
            ...composeGraph(
              draft.source,
              draft.positions,
              state?.runtime.services,
              state?.compose.source === draft.source ? state.compose.resolved : null,
            ),
            model: sourceModel,
          }
        : { nodes: [], edges: [], model: {} };
    } catch (e) {
      return { nodes: [], edges: [], model: {}, error: e.message };
    }
  }, [draft, state?.runtime.services, sourceModel]);
  const dirty = !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.compose);
  const connectionChanges = useMemo(() => {
    if (!draft || !state) return [];
    try {
      return composeConnectionChanges(
        state.compose.lastApplied?.source || state.compose.source,
        draft.source,
      );
    } catch {
      return [];
    }
  }, [draft?.source, state?.compose]);
  const locked = busy || state?.busy;
  const serviceNames = Object.keys(sourceModel.services || {});
  const selectedServiceNames = nodes
    .filter((node) => node.selected && node.id.startsWith('service:'))
    .map((node) => node.id.slice(8))
    .filter((name) => Object.hasOwn(sourceModel.services || {}, name));
  const selectInfrastructure = () => {
    if (locked || parsed.error) return;
    setNodes((items) => items.map((node) => ({ ...node, selected: true })));
    setContextMenu(null);
    canvas.current?.focus();
  };
  const openRedundancy = (names) => {
    if (locked || parsed.error || !names.length) return;
    setContextMenu(null);
    setConnectionMode(false);
    setConnectionStart(null);
    setRedundancyTarget([...names]);
  };
  const openMapMenu = (event, node) => {
    event.preventDefault();
    if (locked || parsed.error) return;
    const preserveSelection = node && nodes.some((item) => item.id === node.id && item.selected);
    if (node && !preserveSelection) focusEquipment(node.id);
    const names =
      node && !preserveSelection
        ? node.id.startsWith('service:') &&
          Object.hasOwn(sourceModel.services || {}, node.id.slice(8))
          ? [node.id.slice(8)]
          : []
        : selectedServiceNames;
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 190)),
      serviceNames: names,
      nodeId: node?.id,
    });
  };
  useEffect(() => {
    if (!contextMenu) return;
    contextMenuPanel.current?.querySelector('button:not(:disabled)')?.focus();
    const dismiss = (event) => {
      if (!contextMenuPanel.current?.contains(event.target)) setContextMenu(null);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [contextMenu]);
  useEffect(() => {
    if (locked || view !== 'map') setContextMenu(null);
  }, [locked, view]);
  useEffect(() => {
    const cancelConnection = (event) => {
      if (event.key === 'Escape') {
        setConnectionStart(null);
        setConnectionMode(false);
      }
    };
    window.addEventListener('keydown', cancelConnection);
    return () => window.removeEventListener('keydown', cancelConnection);
  }, []);
  useEffect(() => {
    onWorkspaceStatus?.({ dirty, busy: !!locked });
  }, [dirty, locked, onWorkspaceStatus]);
  const load = async (replace = false) => {
    const response = await fetch(base + '/state');
    const s = await response.json();
    if (!response.ok) throw Error(s.error);
    current.current = s;
    setState(s);
    if (replace) setDraft(s.compose);
    return s;
  };
  useEffect(() => {
    let active = true;
    load(true).catch((e) => {
      if (active) setError(e.message);
    });
    if (BROWSER_MODE) return () => { active = false; };
    const timer = setInterval(() => {
      if (!pending.current)
        load().catch((e) => {
          if (active) setError(e.message);
        });
    }, 5000);
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      const e = JSON.parse(event.data);
      if (e.projectId === project.id && e.type === 'notice')
        setProgress((s) => (s + e.message + '\n').slice(-24000));
    };
    return () => {
      active = false;
      clearInterval(timer);
      events.close();
    };
  }, [project.id]);
  useEffect(() => {
    setNodes((ns) => {
      const selection = new Map(ns.map((n) => [n.id, n.selected]));
      return reconcileFlowNodes(
        ns,
        parsed.nodes.map((n) => ({
          ...n,
          selected: selection.has(n.id) ? selection.get(n.id) : n.id === selected,
        })),
      );
    });
  }, [parsed, selected]);
  useEffect(() => {
    if (initialSelection) {
      focusEquipment(initialSelection);
      setView('map');
    }
  }, [project.id, initialSelection]);
  useEffect(() => {
    inspector.current?.scrollTo({ top: 0 });
  }, [selected]);
  useEffect(() => {
    if (skipNextFit.current) {
      skipNextFit.current = false;
      return;
    }
    const timer = setTimeout(() => flow.fitView({ duration: 200, maxZoom: 1.2 }), 80);
    return () => clearTimeout(timer);
  }, [parsed.nodes.length]);
  useEffect(() => {
    const listener = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);
  const request = async (route, body, method = 'POST') => {
    if (!BROWSER_MODE && sourceModel[AI_EXTENSION] && ['/compose/preview', '/compose/apply'].includes(route)) {
      const supported = await fetch('/api/projects').then((r) => r.json());
      if (
        !supported.capabilities?.aiInfrastructure ||
        supported.capabilities.aiInfrastructureVersion < 2 ||
        !supported.capabilities.aiInfrastructureVersion ||
        !supported.capabilities.aiStoragePreview
      )
        throw Error(
          'Ferme puis relance Docker Tracer pour activer les vérifications du déploiement IA et de l’espace disque. Ton brouillon est conservé.',
        );
    }
    const response = await fetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Docker-Tracer': '1',
        'If-Match': String(current.current.project.revision),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  };
  const run = async (fn, replace = false, rethrow = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setProgress('');
    try {
      await fn();
      await load(replace);
    } catch (e) {
      setError(e.message);
      await load().catch(() => {});
      if (rethrow) throw e;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const change = (source) => {
    setDraft((d) => ({ ...d, source, resolved: null }));
    setNotice('');
  };
  const changeAt = (source, id, position) => {
    if (!position) return change(source);
    // The dropped point is already in the current viewport; keep it in place when the node appears.
    skipNextFit.current = true;
    setDraft((d) => ({
      ...d,
      source,
      resolved: null,
      positions: { ...d.positions, [id]: position },
    }));
    setNotice('');
  };
  const edit = (fn) => {
    try {
      fn();
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  const patch = (kind, name, field, value) =>
    edit(() => change(patchComposeObject(draft.source, kind, name, field, value)));
  const openConnection = (source, target) => {
    if (locked) return;
    edit(() => {
      const next = composeConnectionTarget(draft.source, source, target);
      setConnectionTarget(next);
      setConnectionStart(null);
    });
  };
  const preview = (options = {}) =>
    run(async () => {
      const plan = await request(
        '/compose/preview',
        options.source ? { ...draft, source: options.source, resolved: null } : draft,
      );
      setModal({
        type: 'preview',
        plan,
        imported: options.imported === true,
        purpose: options.purpose,
        protection: options.protection,
      });
    });
  const importedPreviewHandled = useRef(false);
  useEffect(() => {
    if (!initialImportPreview || !draft || !state || importedPreviewHandled.current) return;
    importedPreviewHandled.current = true;
    preview({ imported: true });
  }, [initialImportPreview, !!draft, !!state]);
  const saveDraft = () =>
    run(async () => {
      await request('/compose/source', draft, 'PUT');
      setNotice(BROWSER_MODE
        ? 'Brouillon conservé dans cet onglet. Exporte le Compose avant de fermer la page.'
        : 'Brouillon enregistré. Docker sera modifié après aperçu et déploiement.');
    }, true);
  const confirmAction = (action, container) => {
    if (!BROWSER_MODE) setModal({ type: 'action', action, container });
  };
  const logs = (container) =>
    run(async () => {
      const r = await fetch(base + '/compose/nodes/' + container.id + '/logs');
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setModal({ type: 'logs', container, output: data.output });
    });
  const importBrowserProject = async (file) => {
    if (!BROWSER_MODE || !file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError('Projet JSON trop volumineux (4 Mio maximum).');
      return;
    }
    try {
      const value = JSON.parse(await file.text());
      if (value?.format !== 'docker-tracer-browser-project' || value.version !== 1)
        throw Error('Format de projet JSON non reconnu.');
      if (typeof value.name !== 'string' || !value.name.trim())
        throw Error('Nom du projet JSON manquant.');
      const compose = composeSettings.parse(value.compose);
      composeDocument(compose.source);
      const result = await projectRequest('/projects', {
        name: value.name,
        hostId: 'local',
        template: 'empty',
        compose,
      });
      onOpenProject(result.project);
    } catch (cause) {
      setError(cause.message || 'Import du projet JSON impossible.');
    }
  };
  if (!draft || !state)
    return (
      <div className="loading">
        <h2>Docker Tracer</h2>
        <p>{error || 'Ouverture de l’infrastructure Compose…'}</p>
        <button onClick={() => load(true).catch((e) => setError(e.message))}>Réessayer</button>
      </div>
    );
  const application = catalogConnection(state.compose, state.runtime, state.project.host);
  return (
    <div className={`compose-workspace${BROWSER_MODE ? ' browser-mode' : ''}`}>
      {!BROWSER_MODE && addHost && (
        <AddContainer
          hostId={addHost}
          projectId={addHost === project.hostId ? project.id : undefined}
          onClose={() => setAddHost(null)}
          onOpen={async (next, nodeId) => {
            if (next.id === project.id) {
              await load(true);
              setInventory(false);
              setView('map');
              focusEquipment(nodeId);
            } else onOpenProject(next, nodeId);
          }}
        />
      )}
      {imagePicker && (
        <WorkspaceModal title="Choisir une image Docker" wide onClose={() => {
          serviceDropPosition.current = null;
          setImagePicker(false);
        }}>
          {error && (
            <p role="alert" className="compose-error">
              {error}
            </p>
          )}
          <DockerImagePicker
            embedded
            hostId={project.hostId}
            onClose={() => {
              serviceDropPosition.current = null;
              setImagePicker(false);
            }}
            onSelect={({ image }) => {
              edit(() => {
                const suggestion =
                  image
                    .split('@')[0]
                    .split('/')
                    .at(-1)
                    .split(':')[0]
                    .replace(/[^a-zA-Z0-9_.-]/g, '-')
                    .slice(0, 55) || 'container';
                let name = newName.trim() || suggestion;
                if (!newName.trim())
                  for (let i = 2; Object.hasOwn(sourceModel.services || {}, name); i++)
                    name = suggestion + '-' + i;
                const source = patchComposeObject(
                  addComposeObject(draft.source, 'services', name),
                  'services',
                  name,
                  'image',
                  image,
                );
                changeAt(
                  patchComposeObject(source, 'services', name, 'pull_policy', 'missing'),
                  'service:' + name,
                  serviceDropPosition.current,
                );
                serviceDropPosition.current = null;
                setSelected('service:' + name);
                setNewName('');
                setView('map');
                setImagePicker(false);
              });
            }}
          />
        </WorkspaceModal>
      )}
      {!BROWSER_MODE && workbench && (
        <ContainerWorkbench
          container={{ ...workbench.container, hostId: project.hostId }}
          initialTab={workbench.tab}
          onClose={() => setWorkbench(null)}
          onChanged={() => load()}
          onEditConfiguration={(_container, section = 'ports') => {
            setWorkbench(null);
            setEditorSection(section);
            setView('map');
          }}
        />
      )}
      {!BROWSER_MODE && instanceChoice && (
        <WorkspaceModal
          title="Choisir le conteneur du service"
          onClose={() => setInstanceChoice(null)}
        >
          {instanceChoice.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setWorkbench({ container: c, tab: 'terminal' });
                setInstanceChoice(null);
              }}
            >
              {c.name} · {labels[c.state] || c.state}
            </button>
          ))}
        </WorkspaceModal>
      )}

      {projectsOpen && (
        <Projects
          initialPage={projectsOpen === 'import' ? 'import' : 'projects'}
          current={state.project}
          dirty={dirty}
          onOpen={onOpenProject}
          onClose={() => setProjectsOpen(false)}
        />
      )}
      {!BROWSER_MODE && inventory && (
        <Inventory
          onClose={() => setInventory(false)}
          onOpenLab={(service, section) => {
            setInventory(false);
            setView('map');
            if (service)
              focusEquipment(service.startsWith('service:') ? service : 'service:' + service);
            setEditorSection(section || 'image');
          }}
          currentLab={project.id}
          currentHost={project.hostId}
          onOpenProject={(next, nodeId, section) => {
            if (next.id === project.id) {
              setInventory(false);
              setView('map');
              focusEquipment(nodeId || null);
              setEditorSection(section || 'image');
            } else if (dirty) {
              setInventory(false);
              setError('Enregistre ton brouillon avant d’ouvrir une autre infrastructure.');
            } else onOpenProject(next, nodeId, section);
          }}
          projectsOpen={projectsOpen}
          onProjects={(mode) => setProjectsOpen(mode === 'import' ? 'import' : true)}
          onAddContainer={(hostId) => {
            if (dirty) setError('Enregistre ton brouillon avant cet ajout.');
            else setAddHost(hostId);
          }}
        />
      )}
      {connectionTarget && (
        <ComposeConnectionDialog
          source={draft.source}
          target={connectionTarget}
          locked={locked}
          onClose={() => setConnectionTarget(null)}
          onApply={(source, changes, options = {}) => {
            if (locked) return;
            change(source);
            focusEquipment('service:' + connectionTarget.services[0]);
            setEditorSection('networks');
            setNotice(
              BROWSER_MODE
                ? changes.join(' · ') + '. Connexion ajoutée au brouillon YAML.'
                : changes.join(' · ') + '. Vérifie les modifications avant de les appliquer à Docker.',
            );
            setConnectionTarget(null);
            setConnectionMode(false);
            setConnectionStart(null);
            if (options.deploy && !BROWSER_MODE) preview({ source, purpose: 'connections' });
          }}
        />
      )}
      {redundancyTarget && (
        <RedundancyDialog
          source={draft.source}
          serviceNames={redundancyTarget}
          hostName={state.project.host.name}
          locked={locked}
          dirty={dirty}
          fresh={!state.project.everDeployed && !draft.adopt && !state.runtime.deployed && state.runtime.connected && !state.compose.lastApplied}
          onClose={() => setRedundancyTarget(null)}
          onApply={(source, options = {}) => {
            if (locked) return;
            change(source);
            setRedundancyTarget(null);
            setNotice(BROWSER_MODE
              ? 'Protection ajoutée au brouillon YAML. Exporte le Compose pour la conserver.'
              : 'Protection préparée. Vérifie le récapitulatif pour l’activer.');
            if (options.deploy && !BROWSER_MODE)
              preview({ source, purpose: 'protection', protection: options.summary });
          }}
        />
      )}
      <div
        className="compose-surface"
        inert={
          !!(
            projectsOpen ||
            inventory ||
            modal ||
            connectionTarget ||
            redundancyTarget ||
            addHost ||
            imagePicker ||
            workbench ||
            instanceChoice
          )
        }
      >
        <header className="compose-header">
          <div>
            <strong>Docker Tracer</strong>
            <span>
              {state.project.name} · {BROWSER_MODE ? 'Atelier navigateur' : state.project.host.name} · Compose : {draft.projectName}
            </span>
          </div>
          {BROWSER_MODE ? (
            <div className="browser-header-links">
              <a className="autodocker-brand-link" href="/essai/">
                <span className="autodocker-logo" aria-hidden="true">
                  <img src={AUTODOCKER_LOGO_URL} alt="" draggable={false} />
                </span>
                AutoDocker
              </a>
              <BrowserDownloads />
            </div>
          ) : (
            <span>
              {state.runtime.connected ? 'Docker connecté' : 'Serveur inaccessible'}
              {dirty ? ' · Brouillon modifié' : ' · Enregistré'}
            </span>
          )}
        </header>
        <nav className="compose-toolbar" aria-label="Actions de l’infrastructure">
          <button disabled={locked} onClick={onImportCompose || (() => setProjectsOpen('import'))}>
            <FolderOpen size={15} /> Importer un Compose
          </button>
          <button
            className="create-infrastructure-button"
            disabled={locked}
            onClick={() => setImagePicker(true)}
          >
            <Plus size={16} /> Ajouter un conteneur
          </button>
          <button disabled={busy} onClick={() => setProjectsOpen(true)}>
            <FolderOpen size={15} />
            Mes infrastructures
          </button>
          {!BROWSER_MODE && <button disabled={locked} onClick={() => setInventory(true)}>
            <Network size={15} />
            Tout Docker · diagnostics et paquets
          </button>}
          <button disabled={locked || !!parsed.error || !dirty} onClick={saveDraft}>
            <Save size={15} />
            Enregistrer
          </button>
          <button className="deploy-button" disabled={locked || !!parsed.error} onClick={preview}>
            {BROWSER_MODE ? <FileCode size={15} /> : <Play size={15} />}
            {BROWSER_MODE ? 'Vérifier le Compose' : 'Appliquer les modifications'}
          </button>
          {!BROWSER_MODE && <button
            disabled={locked || !state.runtime.deployed}
            onClick={() => confirmAction('start')}
          >
            <Play size={15} />
            Démarrer
          </button>}
          {!BROWSER_MODE && <button
            disabled={locked || !state.runtime.deployed}
            onClick={() => confirmAction('stop')}
          >
            <Square size={15} />
            Arrêter
          </button>}
          {!BROWSER_MODE && <button
            disabled={locked || !state.runtime.deployed}
            onClick={() => confirmAction('down')}
          >
            <Trash2 size={15} />
            Libérer
          </button>}
          {!BROWSER_MODE && <button
            aria-label="Actualiser l’état"
            disabled={locked}
            onClick={() => run(() => request('/refresh', {}))}
          >
            <RefreshCw size={15} />
          </button>}
        </nav>
        {BROWSER_MODE && (
          <p className="browser-compose-note" role="status">Atelier navigateur · carte, équipements, connexions et YAML. Les projets restent en mémoire dans cet onglet ; exporte-les pour les conserver.</p>
        )}
        {(error || notice || (!BROWSER_MODE && state.runtime.message)) && (
          <div
            role={error ? 'alert' : 'status'}
            className={error ? 'compose-error' : 'compose-notice'}
          >
            {error || notice || state.runtime.message}
          </div>
        )}
        {application && (
          <div className="catalog-application-access">
            <div>
              <strong>
                {application.name}
                {application.address ? ' · ' + application.address : ''}
              </strong>
              <p>{application.message}</p>
              <details>
                <summary>Premiers pas et accès</summary>
                <p>{application.next}</p>
                {application.password && (
                  <p>
                    Retrouve le mot de passe dans Paramètres → Variables explicites. Pour PostgreSQL
                    et MariaDB, ces valeurs initialisent une base vide ; changer la variable ne
                    modifie pas le mot de passe d’une base existante.
                  </p>
                )}
              </details>
            </div>
            {application.url && (
              <a href={application.url} target="_blank" rel="noreferrer">
                Ouvrir l’application ↗
              </a>
            )}
          </div>
        )}
        <nav className="compose-tabs" aria-label="Vues Compose">
          {aiServices.length > 0 && (
            <button className={view === 'ai' ? 'active' : ''} onClick={() => setView('ai')}>
              <BrainCircuit size={15} />
              Réglages IA
            </button>
          )}
          {[
            ['map', 'Carte et équipements', Network],
            ['source', 'Configuration complète', FileCode],
            ['settings', 'Paramètres', FolderOpen],
            ...(!BROWSER_MODE ? [['history', 'Historique', History]] : []),
          ].map(([id, label, Icon]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
        {view === 'ai' && aiServices.length > 0 ? (
          <section className="compose-ai-maintenance-panel">
            <AiServiceSettings
              key={state.project.id}
              source={draft.source}
              model={sourceModel}
              services={aiServices}
              selectedService={selected?.startsWith('service:') ? selected.slice(8) : undefined}
              hostId={project.hostId}
              locked={locked}
              onChange={change}
              onSelectService={(name) => focusEquipment('service:' + name)}
              onSource={() => setView('source')}
              onBack={() => setView('map')}
            />
          </section>
        ) : view === 'map' ? (
          <div className="compose-map-layout">
            <section
              className={'compose-canvas' + (connectionMode ? ' connection-mode' : '')}
              aria-label="Carte Compose"
              ref={canvas}
              tabIndex={0}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  event.target.closest?.('input, textarea, select, [contenteditable]')
                )
                  return;
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                  event.preventDefault();
                  selectInfrastructure();
                }
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  const bounds = canvas.current.getBoundingClientRect();
                  openMapMenu({
                    preventDefault() {},
                    clientX: bounds.left + 20,
                    clientY: bounds.top + 70,
                  });
                }
              }}
            >
              <div className="compose-connection-toolbar">
                <button
                  type="button"
                  disabled={locked || !!parsed.error || !nodes.length}
                  onClick={selectInfrastructure}
                >
                  Tout sélectionner
                </button>
                <button
                  type="button"
                  disabled={locked || !!parsed.error || !serviceNames.length}
                  onClick={() =>
                    openRedundancy(
                      selectedServiceNames.length ? selectedServiceNames : serviceNames,
                    )
                  }
                >
                  {selectedServiceNames.length
                    ? `Redonder la sélection (${selectedServiceNames.length})`
                    : 'Redonder l’infrastructure'}
                </button>
                <button
                  type="button"
                  aria-pressed={connectionMode}
                  disabled={locked || !!parsed.error}
                  onClick={() => {
                    const picked = nodes.filter((node) => node.selected);
                    if (!connectionMode && picked.length === 2) {
                      openConnection(picked[0].id, picked[1].id);
                      return;
                    }
                    setConnectionMode(!connectionMode);
                    setConnectionStart(null);
                  }}
                >
                  <Cable size={15} />{' '}
                  {connectionMode ? 'Annuler la connexion' : 'Relier des équipements'}
                </button>
                {connectionMode && (
                  <span role="status">
                    {connectionStart
                      ? `${connectionStart.slice(connectionStart.indexOf(':') + 1)} sélectionné. Clique sur la cible, ou Échap pour annuler.`
                      : 'Clique sur deux équipements, ou tire un câble entre leurs points bleus.'}
                  </span>
                )}
                {!connectionMode && connectionChanges.length > 0 && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setModal({ type: 'connections' })}
                  >
                    {connectionChanges.length} changement(s) de connexion
                  </button>
                )}
              </div>
              {parsed.error ? (
                <pre role="alert" className="compose-error">
                  {parsed.error}
                </pre>
              ) : (
                <ReactFlow
                  nodes={nodes.map((node) => ({
                    ...node,
                    className: connectionStart === node.id ? 'connection-start' : '',
                  }))}
                  edges={parsed.edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  connectionMode={ConnectionMode.Loose}
                  fitView
                  minZoom={0.12}
                  maxZoom={2}
                  onlyRenderVisibleElements
                  nodesDraggable={!locked && !connectionMode}
                  nodesConnectable={!locked}
                  connectionRadius={30}
                  connectOnClick
                  deleteKeyCode={null}
                  multiSelectionKeyCode="Shift"
                  onNodesChange={onNodesChange}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes('application/x-docker-tracer-equipment'))
                      return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = locked ? 'none' : 'copy';
                  }}
                  onDrop={(event) => {
                    const kind = event.dataTransfer.getData('application/x-docker-tracer-equipment');
                    if (!['service', 'switch', 'router', 'volume'].includes(kind)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (locked || parsed.error) return;
                    const position = flow.screenToFlowPosition({
                      x: event.clientX,
                      y: event.clientY,
                    });
                    setDropRequest({ id: ++dropSequence.current, kind, position });
                  }}
                  onSelectionChange={({ nodes: picked }) => {
                    if (!connectionMode && picked.length === 1) setSelected(picked[0].id);
                  }}
                  onNodeClick={(_, n) => {
                    if (connectionMode && !locked) {
                      if (!connectionStart) setConnectionStart(n.id);
                      else if (connectionStart === n.id) setConnectionStart(null);
                      else openConnection(connectionStart, n.id);
                      return;
                    }
                    setSelected(n.id);
                    setEditorSection('image');
                  }}
                  onEdgeClick={(_, edge) => openConnection(edge.source, edge.target)}
                  onNodeContextMenu={(event, n) => {
                    openMapMenu(event, n);
                  }}
                  onPaneContextMenu={(event) => openMapMenu(event)}
                  onSelectionContextMenu={(event) => openMapMenu(event)}
                  onPaneClick={() => setContextMenu(null)}
                  onConnect={({ source, target }) => openConnection(source, target)}
                >
                  <Background color="#dce4e9" gap={22} />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              )}
              {contextMenu && (
                <div
                  className="compose-map-context-menu"
                  role="menu"
                  aria-label="Actions de la carte"
                  ref={contextMenuPanel}
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' || event.key === 'Tab') {
                      setContextMenu(null);
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        canvas.current?.focus();
                      }
                    }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault();
                      const items = [
                        ...contextMenuPanel.current.querySelectorAll('button:not(:disabled)'),
                      ];
                      const currentIndex = items.indexOf(document.activeElement);
                      const index =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? items.length - 1
                            : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                              items.length;
                      items[index]?.focus();
                    }
                  }}
                >
                  {contextMenu.nodeId && (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setConnectionMode(true);
                        setConnectionStart(contextMenu.nodeId);
                        setContextMenu(null);
                      }}
                    >
                      <Cable size={14} /> Relier cet équipement
                    </button>
                  )}
                  {!!contextMenu.serviceNames.length && (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => openRedundancy(contextMenu.serviceNames)}
                    >
                      Redonder la sélection ({contextMenu.serviceNames.length})
                    </button>
                  )}
                  <button
                    role="menuitem"
                    type="button"
                    disabled={!serviceNames.length}
                    onClick={() => openRedundancy(serviceNames)}
                  >
                    Redonder l’infrastructure
                  </button>
                  <button role="menuitem" type="button" onClick={selectInfrastructure}>
                    Tout sélectionner
                  </button>
                  {contextMenu.nodeId?.startsWith('service:') &&
                    !!state.runtime.services[contextMenu.nodeId.slice(8)]?.length && (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          const instances = state.runtime.services[contextMenu.nodeId.slice(8)];
                          if (instances.length === 1)
                            setWorkbench({ container: instances[0], tab: 'terminal' });
                          else setInstanceChoice(instances);
                          setContextMenu(null);
                        }}
                      >
                        Ouvrir le terminal
                      </button>
                    )}
                </div>
              )}
            </section>
            <aside
              className="compose-inspector"
              aria-label="Gérer l’équipement sélectionné"
              ref={inspector}
            >
              <fieldset disabled={locked}>
                {selected && !parsed.error ? (
                  <>
                    <p className="compose-editor-target">
                      {state.project.host.name} · {state.project.name}
                    </p>
                    <ObjectEditor
                      hostId={project.hostId}
                      key={selected}
                      selected={selected}
                      model={parsed.model}
                      source={draft.source}
                      runtime={state.runtime.services || {}}
                      patch={patch}
                      change={(s) => edit(() => change(s))}
                      onAction={(c, a) => confirmAction(a, c)}
                      onLogs={logs}
                      onSource={() => setView('source')}
                      onAiSettings={
                        aiServices.some((service) => selected === 'service:' + service.name)
                          ? () => setView('ai')
                          : undefined
                      }
                      onClearSelection={() => focusEquipment(null)}
                      initialSection={editorSection}
                      onTools={(container, tab) => setWorkbench({ container, tab })}
                    />
                    {Object.hasOwn(
                      parsed.model[
                        selected.startsWith('service:')
                          ? 'services'
                          : selected.startsWith('network:')
                            ? 'networks'
                            : 'volumes'
                      ] || {},
                      selected.slice(selected.indexOf(':') + 1),
                    ) && (
                      <details className="compose-remove-section">
                        <summary>Retirer cet équipement</summary>
                        <p className="field-hint">
                          {BROWSER_MODE
                            ? 'Retire sa déclaration du brouillon YAML de cet onglet.'
                            : 'Retire sa déclaration du brouillon. Les conteneurs existants restent présents jusqu’aux actions de déploiement.'}
                        </p>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => setModal({ type: 'remove', selected })}
                        >
                          <Trash2 size={13} />
                          Retirer du brouillon
                        </button>
                      </details>
                    )}
                    <div className="compose-editor-footer">
                      <strong>
                        {dirty ? 'Brouillon à enregistrer' : 'Configuration enregistrée'}
                      </strong>
                      <p>{BROWSER_MODE
                        ? 'Ces réglages modifient le brouillon YAML en mémoire. Exporte-le pour le conserver.'
                        : 'Les réglages ne changent Docker qu’après vérification et déploiement.'}</p>
                      <div className="compose-buttons">
                        <button type="button" disabled={!dirty} onClick={saveDraft}>
                          <Save size={14} />
                          Enregistrer le brouillon
                        </button>
                        <button type="button" className="deploy-button" onClick={preview}>
                          <Play size={14} />
                          {BROWSER_MODE ? 'Vérifier le Compose' : 'Vérifier les modifications'}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="compose-welcome">
                    <h2>Toute l’infrastructure sur la carte</h2>
                    <p>
                      Sélectionne un équipement pour le configurer. Clique sur Relier des équipements
                      puis sur les deux équipements, ou tire un câble entre leurs connecteurs.
                    </p>
                    <p>
                      {BROWSER_MODE
                        ? 'Crée les équipements avec la palette ci-dessous, puis exporte le Compose pour le conserver.'
                        : 'Crée les équipements avec la palette ci-dessous, puis prépare le déploiement pour voir les changements prévus.'}
                    </p>
                  </div>
                )}
              </fieldset>
            </aside>
          </div>
        ) : view === 'source' ? (
          <section className="compose-source">
            <div className="compose-buttons">
              <button onClick={() => download(draft.projectName + '.compose.yaml', draft.source)}>
                <Download size={14} />
                Exporter ce brouillon
              </button>
              {BROWSER_MODE && <>
                <button onClick={() => download(
                  draft.projectName + '.docker-tracer.json',
                  JSON.stringify({
                    format: 'docker-tracer-browser-project',
                    version: 1,
                    name: state.project.name,
                    compose: draft,
                  }, null, 2),
                  'application/json',
                )}>
                  <Download size={14} /> Projet JSON (avec placement)
                </button>
                <button onClick={() => browserProjectInput.current?.click()}>
                  <FolderOpen size={14} /> Importer un projet JSON
                </button>
                <input
                  ref={browserProjectInput}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  aria-label="Projet JSON Docker Tracer"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    importBrowserProject(file);
                  }}
                />
              </>}
              {!BROWSER_MODE && <button
                disabled={locked || !draft.previousApplied}
                onClick={() => setModal({ type: 'previous' })}
              >
                Reprendre la version précédente
              </button>}
            </div>
            <p>
              Le fichier complet reste modifiable ici. Les réglages de la carte préservent les
              autres options. {BROWSER_MODE
                ? 'Les fichiers inclus restent à joindre lors de l’utilisation locale du Compose.'
                : 'Les fichiers inclus restent dans le dossier source ; ils ne sont pas réécrits par Docker Tracer.'}
            </p>
            <label>
              Fichier Compose complet
              <textarea
                disabled={locked}
                spellCheck={false}
                value={draft.source}
                onChange={(e) => change(e.target.value)}
              />
            </label>
            {parsed.error && (
              <p className="compose-error" role="alert">
                {parsed.error}
              </p>
            )}
          </section>
        ) : view === 'settings' ? (
          <section className="compose-settings">
            <fieldset disabled={locked}>
              <h2>{BROWSER_MODE ? 'Paramètres du Compose' : `Exécution sur ${state.project.host.name}`}</h2>
              <p>
                Projet Compose : <strong>{draft.projectName}</strong>
                {!BROWSER_MODE && <> · {draft.adopt ? 'Projet existant rattaché' : 'Nouvelle infrastructure'}</>}
              </p>
              {!BROWSER_MODE && <label>
                Dossier du projet{' '}
                {project.hostId === 'local' ? 'sur ce PC' : 'sur le serveur Linux'}
                <input
                  value={draft.directory}
                  onChange={(e) => setDraft({ ...draft, directory: e.target.value })}
                  placeholder={
                    project.hostId === 'local'
                      ? 'Chemin absolu si fichiers relatifs'
                      : '/srv/mon-projet'
                  }
                />
              </label>}
              {!BROWSER_MODE && <p className="field-hint">
                Ce dossier fournit les builds, fichiers inclus, env_file, configs et secrets.{' '}
                {project.hostId === 'local'
                  ? 'Docker CLI et Compose sont requis sur ce PC.'
                  : 'Docker CLI, Compose et timeout sont requis sur le serveur SSH. Les fichiers doivent être présents sur ce serveur.'}
              </p>}
              {!BROWSER_MODE && <label className="compose-check">
                <input
                  type="checkbox"
                  checked={draft.useDotEnv}
                  onChange={(e) => setDraft({ ...draft, useDotEnv: e.target.checked })}
                />
                Charger le fichier .env de ce dossier
              </label>}
              <Pairs
                title="Variables Compose explicites"
                value={draft.variables}
                onApply={(v) => setDraft({ ...draft, variables: v })}
              />
              <p className="field-hint">
                {BROWSER_MODE
                  ? 'Ces valeurs restent dans la mémoire de cet onglet. Évite les vrais secrets dans une démonstration publique.'
                  : 'Ces valeurs sont enregistrées avec le projet sur ce PC. Utilise des références de secrets dans Compose pour les données sensibles.'}
              </p>
              <label>
                Profils activés (séparés par une virgule)
                <input
                  value={draft.profiles.join(', ')}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      profiles: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              {!BROWSER_MODE && <label>
                Délai de démarrage (secondes)
                <input
                  type="number"
                  min="10"
                  max="7200"
                  value={draft.waitSeconds}
                  onChange={(e) => setDraft({ ...draft, waitSeconds: Number(e.target.value) })}
                />
              </label>}
            </fieldset>
          </section>
        ) : (
          <section className="compose-history">
            <DeploymentHistory
              runs={state.deployments || []}
              onSelect={(run) => setModal({ type: 'history', run })}
            />
          </section>
        )}
        <ComposeEquipmentPalette
          model={parsed.model}
          disabled={locked || !!parsed.error}
          dropRequest={dropRequest}
          onService={(name, position) => {
            setNewName(name);
            serviceDropPosition.current = position;
            setImagePicker(true);
          }}
          onAdd={(kind, options, position) => {
            const equipment = addComposeEquipment(draft.source, kind, options);
            changeAt(equipment.source, equipment.id, position);
            focusEquipment(equipment.id);
            setEditorSection(kind === 'router' ? 'networks' : 'image');
            setError('');
            setView('map');
          }}
          onSelectVolume={(name) => {
            setSelected('volume:' + name);
            setView('map');
          }}
        />
        {locked && (
          <div className="compose-progress" role="status">
            <strong>Opération en cours sur {state.project.host.name}…</strong>
            {progress && <pre>{visibleComposeProgress(progress)}</pre>}
          </div>
        )}
      </div>
      {modal && (
        <WorkspaceModal
          title={
            modal.type === 'preview'
              ? BROWSER_MODE ? 'Vérifier le Compose' : 'Vérifier le déploiement Compose'
              : modal.type === 'connections'
                ? 'Changements de connexion'
                : modal.type === 'logs'
                  ? 'Logs · ' + modal.container.name
                  : modal.type === 'history'
                    ? 'Résultat enregistré'
                    : 'Confirmer la modification'
          }
          wide
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal.type === 'connections' ? (
            <div className="compose-connection-preview">
              <ul>
                {connectionChanges.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
              <p>
                {BROWSER_MODE
                  ? 'Ces changements appartiennent au brouillon YAML de cet onglet.'
                  : 'Ces changements appartiennent au brouillon. Vérifie le déploiement avant de les appliquer à Docker.'}
              </p>
              <details>
                <summary>Aperçu du fichier Compose</summary>
                <pre>{draft.source}</pre>
              </details>
              <button className="deploy-button" disabled={locked} onClick={preview}>
                {BROWSER_MODE ? 'Vérifier le Compose' : 'Vérifier les modifications'}
              </button>
            </div>
          ) : modal.type === 'preview' ? (
            BROWSER_MODE ? (
              <div className="browser-compose-preview">
                <p><strong>{modal.plan.projectName}</strong> · {modal.plan.services.length} service{modal.plan.services.length > 1 ? 's' : ''}</p>
                <p>Le YAML a été analysé dans cet onglet. Aucun moteur Docker ni fichier du serveur n’a été vérifié.</p>
                <pre className="proxy-preview">{modal.plan.output}</pre>
                {modal.plan.attention?.map((item, index) => <p key={index} className="lab-change-warning">{item}</p>)}
                <div className="compose-buttons">
                  <button onClick={() => download(draft.projectName + '.compose.yaml', draft.source)}>
                    <Download size={14} /> Exporter le Compose
                  </button>
                  <button onClick={() => setModal(null)}>Revenir à la carte</button>
                </div>
                <p className="field-hint">Pour vérifier les fichiers associés et déployer sur Docker, ouvre ce projet dans l’application locale.</p>
              </div>
            ) : <>
              {modal.purpose === 'protection' && modal.protection && (
                <p className="compose-notice">
                  <strong>
                    {modal.protection.replicatedServices?.length
                      ? 'Instances supplémentaires et sondes'
                      : 'Relance automatique uniquement'}
                  </strong>{' '}
                  ·{' '}
                  {modal.protection.description ||
                    'Le nombre d’instances du groupe sera mis à jour.'}
                </p>
              )}
              <p>
                <strong>
                  {state.project.host.name} → {modal.plan.projectName}
                </strong>
              </p>
              <p>
                {modal.plan.services.length} services concernés. L’aperçu expire après deux minutes.
              </p>
              {connectionChanges.length > 0 && (
                <details className="compose-connection-preview" open>
                  <summary>Connexions modifiées</summary>
                  <ul>
                    {connectionChanges.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p>
                Compose applique les changements nécessaires. Un échec peut laisser le projet
                partiellement modifié ; aucun retour automatique à l’ancienne version n’est
                effectué.
              </p>
              {modal.plan.attention.map((n, i) => (
                <p className="lab-change-warning" key={i}>
                  {n}
                </p>
              ))}
              {modal.plan.existing.length > 0 && (
                <details>
                  <summary>Conteneurs existants concernés</summary>
                  {modal.plan.existing.map((c) => (
                    <p key={c.id}>
                      {c.name} · {c.state} · {c.id.slice(0, 12)}
                    </p>
                  ))}
                </details>
              )}
              <h3>
                {busy
                  ? 'Déploiement réel · progression'
                  : 'Simulation Compose · aucune ressource créée'}
              </h3>
              {modal.plan.config?.[AI_EXTENSION] && (
                <p className="field-hint">
                  La première installation télécharge plusieurs gigaoctets d’images et le modèle.
                  Les téléchargements peuvent prendre du temps ; leur progression s’affiche ici.
                </p>
              )}
              {!busy && modal.plan.dryRunSucceeded === false && (
                <p className="compose-error">
                  La configuration est valide, mais Compose n’a pas terminé sa simulation. Cela peut
                  arriver avec une dépendance arrêtée. Consulte la sortie ci-dessous avant de
                  choisir un déploiement réel.
                </p>
              )}
              <pre className="proxy-preview" role={busy ? 'log' : undefined}>
                {busy
                  ? visibleComposeProgress(progress) ||
                    'Vérification de la configuration et préparation du serveur…'
                  : modal.plan.output}
              </pre>
              <p className="field-hint">
                La configuration résolue sera vérifiée de nouveau avant application. Les fichiers et
                contextes de build externes peuvent évoluer ; cet aperçu ne fige pas leur contenu.
              </p>
              <button
                className="deploy-button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    try {
                      await request('/compose/apply', { token: modal.plan.token });
                    } catch (e) {
                      // Applying consumes the server's preview token, even on
                      // failure. Return to the editor instead of offering it again.
                      setModal(null);
                      throw Error(`${e.message} Recrée l’aperçu avant de réessayer.`);
                    }
                    setModal(null);
                    setNotice(
                      'Déploiement terminé. L’état réel et la sortie Compose sont disponibles dans l’historique.',
                    );
                  }, true)
                }
              >
                {modal.purpose === 'protection'
                  ? 'Activer sur '
                  : modal.purpose === 'connections'
                    ? 'Appliquer les connexions sur '
                    : modal.imported
                      ? 'Démarrer sur '
                      : 'Appliquer sur '}
                {state.project.host.name}
              </button>
            </>
          ) : modal.type === 'action' ? (
            <>
              <p>
                <strong>
                  {state.project.host.name} → {modal.container?.name || draft.projectName}
                </strong>
              </p>
              <p>
                {modal.action === 'down'
                  ? 'Supprimer les conteneurs et réseaux créés par ce projet. Les volumes sont conservés. Les données écrites seulement dans les conteneurs seront perdues.'
                  : modal.action === 'stop'
                    ? 'Arrêter cette cible. Ses applications seront indisponibles pendant l’arrêt.'
                    : modal.action === 'restart'
                      ? 'Redémarrer ce conteneur avec une interruption de son application.'
                      : 'Démarrer la cible dans sa configuration déjà déployée.'}
              </p>
              <button
                disabled={busy}
                className={modal.action === 'down' ? 'danger-button' : 'deploy-button'}
                onClick={() =>
                  run(async () => {
                    await request(
                      modal.container
                        ? '/compose/nodes/' + modal.container.id + '/action'
                        : '/compose/action',
                      { action: modal.action },
                    );
                    setModal(null);
                    setNotice(
                      'Action terminée sur ' + (modal.container?.name || draft.projectName) + '.',
                    );
                  })
                }
              >
                Confirmer{' '}
                {modal.action === 'down'
                  ? 'la libération'
                  : modal.action === 'stop'
                    ? 'l’arrêt'
                    : modal.action === 'restart'
                      ? 'le redémarrage'
                      : 'le démarrage'}
              </button>
            </>
          ) : modal.type === 'remove' ? (
            <>
              <p>
                Retirer <strong>{modal.selected.slice(modal.selected.indexOf(':') + 1)}</strong> de
                la configuration ? Cette modification sera enregistrée dans le brouillon. Docker
                changera seulement après un déploiement.
              </p>
              <p>
                Compose conserve les services devenus orphelins. Leur arrêt reste possible depuis
                Tout Docker ; la suppression de la déclaration ne supprime pas leurs volumes.
              </p>
              <button
                className="danger-button"
                onClick={() =>
                  edit(() => {
                    const [kind, name] = modal.selected.split(/:(.*)/s);
                    change(
                      removeComposeObject(
                        draft.source,
                        kind === 'service'
                          ? 'services'
                          : kind === 'network'
                            ? 'networks'
                            : 'volumes',
                        name,
                      ),
                    );
                    setSelected(null);
                    setModal(null);
                  })
                }
              >
                Retirer du brouillon
              </button>
            </>
          ) : modal.type === 'previous' ? (
            <>
              <p>
                Remplacer le brouillon par la configuration du déploiement précédent ? Les données
                des volumes et Docker ne changent pas. Prépare ensuite un déploiement pour
                réappliquer cette configuration.
              </p>
              <button
                onClick={() => {
                  setDraft({ ...draft, ...draft.previousApplied, resolved: null });
                  setModal(null);
                }}
              >
                Reprendre dans le brouillon
              </button>
            </>
          ) : modal.type === 'logs' ? (
            <pre className="proxy-preview">{modal.output || 'Aucune ligne de log.'}</pre>
          ) : (
            <DeploymentResult run={modal.run} />
          )}
          {busy && <p role="status">Opération en cours…</p>}
          {error && (
            <p role="alert" className="compose-error">
              {error}
            </p>
          )}
        </WorkspaceModal>
      )}
    </div>
  );
}
