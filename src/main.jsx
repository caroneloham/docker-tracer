import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  ConnectionMode,
  BaseEdge,
  getStraightPath,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
} from '@xyflow/react';
import {
  Cable,
  BrainCircuit,
  FolderOpen,
  Save,
  ZoomIn,
  ZoomOut,
  Scan,
  Mail,
  Hand,
  Monitor,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  Globe,
  Layers,
  MousePointer2,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { templates, newNode, topologySchema, composeObject } from '../shared/model.mjs';
import YAML from 'yaml';
import DeviceSettings, { NetworkConnections } from './DeviceSettings.jsx';
import LabPreview from './LabPreview.jsx';
import { DeploymentHistory, DeploymentResult } from './Deployments.jsx';
import Volumes from './Volumes.jsx';
import { assertStartupSupport } from '../shared/startup.mjs';
import { assertBridgeSupport } from '../shared/bridge.mjs';
import { deploymentSignature } from '../shared/model.mjs';
import { duplicateDevice } from '../shared/lab-changes.mjs';
import { PROJECT_JSON_LIMIT, assertConfigurationSupport } from '../shared/configuration.mjs';

// React Flow measures unchanged DOM nodes once. Keep that measurement when the API
// returns the persisted graph, which intentionally contains no renderer metadata.
const withMeasurements = (previous, next) => ({
  ...next,
  nodes: next.nodes.map((node) => ({
    ...node,
    measured: previous?.nodes.find((n) => n.id === node.id)?.measured,
  })),
});
import '@xyflow/react/dist/style.css';
import './classic.css';
import './browser.css';
import EquipmentIcon from './EquipmentIcon.jsx';
import Inventory from './Inventory.jsx';
import Projects, { projectRequest } from './Projects.jsx';
import ComposeWorkspace from './ComposeWorkspace.jsx';
import ComposeDropImport from './ComposeImport.jsx';
import AddContainer from './AddContainer.jsx';
import DockerImagePicker from './DockerImagePicker.jsx';
import ContainerWorkbench from './ContainerWorkbench.jsx';
import DockerTerminal from './DockerTerminal.jsx';
import { PacketComposer, PacketInspector, ProbeHistory } from './Packets.jsx';
import EquipmentTemplates from './EquipmentTemplates.jsx';
import { WorkspaceModal } from './WorkspacePanels.jsx';
import { loadEquipmentTemplates, templateStorageKey } from '../shared/templates.mjs';
import { BROWSER_MODE } from './browser-mode.js';
import { AUTODOCKER_LOGO_URL } from './autodocker-logo.js';
import BrowserDownloads from './BrowserDownloads.jsx';

const iconMap = {
  server: Server,
  terminal: Terminal,
  globe: Globe,
  database: Database,
  network: Network,
};
const colors = {
  ICMP: '#378330',
  ICMPV6: '#378330',
  TCP: '#246aa5',
  UDP: '#97610c',
  DNS: '#7749ac',
  HTTP: '#16806c',
  TLS: '#ad4576',
  ARP: '#bd502e',
  OTHER: '#a0aca4',
};
const LiveContext = createContext({
  runtime: { nodes: {}, networks: [] },
  bursts: [],
  paused: false,
});
const formatBytes = (n) =>
  !n
    ? '0 B'
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
async function requestApi(path, body, method = 'POST', base = '/api', revision) {
  // A refreshed UI can be served by a process still running the previous schema.
  // Check before sending rich topologies; old Zod schemas would silently strip these fields.
  if (
    body?.nodes?.some(
      (n) =>
        n.data?.files?.length ||
        n.data?.proxy ||
        n.data?.bridge ||
        (n.data?.startup?.mode && n.data.startup.mode !== 'none'),
    )
  ) {
    const status = await fetch(base + '/state');
    if (!status.ok) throw Error('Impossible de vérifier la version de Docker Tracer.');
    const capabilities = (await status.json()).capabilities;
    assertConfigurationSupport(body, capabilities);
    assertStartupSupport(body, capabilities);
    assertBridgeSupport(body, capabilities);
  }
  const response = await fetch(
    `${base}${path}`,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Docker-Tracer': '1',
            ...(revision ? { 'If-Match': String(revision) } : {}),
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || 'La requête a échoué.'), {
      deploymentRun: result.deploymentRun,
    });
  return result;
}
function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Device({ id, data, selected }) {
  const { runtime } = useContext(LiveContext);
  const live = runtime.nodes[id],
    net = runtime.networks.find((n) => n.nodeId === id);
  const network = data.kind === 'network';
  const running = runtime.connected && (network ? !!net : live?.state === 'running');
  return (
    <div
      className={`device ${selected ? 'selected' : ''}`}
      title={`${network ? data.bridge?.label || data.label : data.label} · ${network ? data.bridge?.description || 'Réseau bridge' : data.image} · clique pour configurer`}
    >
      <Handle id="left" type="source" position={Position.Left} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <div className="device-picture">
        <EquipmentIcon kind={data.icon} image={network ? undefined : data.image} />
        <span className={`device-led ${running ? 'live' : live ? 'stopped' : ''}`} />
      </div>
      <div className="device-type">
        {network
          ? data.internal
            ? 'Bridge isolé'
            : 'Bridge Docker'
          : data.icon === 'terminal'
            ? 'PC Linux'
            : data.icon === 'database'
              ? 'Serveur Redis'
              : data.icon === 'globe'
                ? 'Serveur HTTP'
                : 'Serveur Docker'}
      </div>
      <div
        className="device-name"
        style={network && data.bridge?.color ? { color: data.bridge.color } : undefined}
      >
        {network ? data.bridge?.label || data.label : data.label}
      </div>
      <div className="device-detail">
        {network ? net?.subnet || data.subnet : live?.addresses?.join(' / ')}
      </div>
    </div>
  );
}
function PacketDot({ packet, path }) {
  const { inspectPacket, animationSpeed } = useContext(LiveContext);
  const stepMs = (packet.replay ? 1600 : 650) / animationSpeed;
  const circle = useRef(null),
    motion = useRef(null);
  useEffect(() => {
    const start = setTimeout(() => {
      if (circle.current) circle.current.style.visibility = 'visible';
      motion.current?.beginElement();
    }, packet.step * stepMs);
    const end = setTimeout(
      () => {
        if (circle.current) circle.current.style.visibility = 'hidden';
      },
      (packet.step + 1) * stepMs,
    );
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [packet.id, packet.step, path, stepMs]);
  return (
    <g
      ref={circle}
      visibility="hidden"
      fill={colors[packet.protocol] || colors.OTHER}
      className="packet-envelope"
      role="button"
      tabIndex={0}
      aria-label={`Inspecter le paquet ${packet.protocol} de ${packet.source} vers ${packet.target}`}
      onClick={(e) => {
        e.stopPropagation();
        inspectPacket(packet);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          inspectPacket(packet);
        }
      }}
    >
      <title>
        {packet.protocol} · {packet.source} → {packet.target} · Cliquer pour inspecter
      </title>
      <rect x="-10" y="-7" width="20" height="14" rx="1" stroke="#243d50" strokeWidth=".8" />
      <path d="m-10-7 10 8 10-8" stroke="white" strokeWidth="1" fill="none" />
      <animateMotion
        ref={motion}
        begin="indefinite"
        dur={`${stepMs / 1000}s`}
        path={path}
        keyPoints={packet.reverse ? '1;0' : '0;1'}
        keyTimes="0;1"
        calcMode="linear"
        fill="freeze"
      />
    </g>
  );
}
function TrafficEdge(props) {
  const { bursts, paused, runtime, topology, showPorts } = useContext(LiveContext);
  const [path] = getStraightPath(props);
  const source = topology.nodes.find((n) => n.id === props.source);
  const containerId = source?.data.kind === 'container' ? props.source : props.target;
  const networkId = source?.data.kind === 'network' ? props.source : props.target;
  const live = runtime.nodes[containerId];
  const iface = live?.interfaces?.find((i) => i.networkId === networkId);
  const online = runtime.connected && live?.state === 'running';
  const events = bursts.flatMap((p) =>
    p.route
      .map((r, step) => ({ ...p, edgeId: r.id, reverse: r.reverse, step }))
      .filter((p) => p.edgeId === props.id),
  );
  const dx = props.targetX - props.sourceX,
    dy = props.targetY - props.sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const point = (t) => ({ x: props.sourceX + dx * t, y: props.sourceY + dy * t });
  const label = point(
    containerId === props.source ? Math.min(0.22, 50 / length) : 1 - Math.min(0.22, 50 / length),
  );
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: props.selected
            ? '#1772b4'
            : topology.nodes.find((n) => n.id === networkId)?.data.bridge?.color || '#303538',
          strokeWidth: props.selected ? 2.3 : 1.5,
        }}
      />
      {[0.1, 0.9].map((t) => {
        const p = point(t);
        return (
          <path
            key={t}
            d="M-4-3.5 4 0-4 3.5Z"
            transform={`translate(${p.x} ${p.y}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + (t > 0.5 ? 180 : 0)})`}
            fill={online ? '#41a43a' : live ? '#c95547' : '#a4a7a9'}
          />
        );
      })}
      {showPorts && iface?.name && (
        <text x={label.x} y={label.y - 7} textAnchor="middle" className="interface-label">
          {iface.name}
        </text>
      )}
      {events
        .filter((p) => !paused || p.replay)
        .slice(-8)
        .map((p) => (
          <PacketDot key={`${p.id}-${p.received}`} packet={p} path={path} />
        ))}
    </>
  );
}
const nodeTypes = { device: Device },
  edgeTypes = { traffic: TrafficEdge };
function App({
  project,
  onOpenProject,
  initialInventory,
  initialSelection,
  onImportCompose,
  onWorkspaceStatus,
}) {
  const revision = useRef(project.revision),
    dirtyRef = useRef(false);
  const [projectInfo, setProjectInfo] = useState(project),
    [filesAvailable, setFilesAvailable] = useState(false),
    [startupAvailable, setStartupAvailable] = useState(false),
    [bridgesAvailable, setBridgesAvailable] = useState(false),
    [backupsAvailable, setBackupsAvailable] = useState(false),
    [deploymentRuns, setDeploymentRuns] = useState([]),
    [deploymentRun, setDeploymentRun] = useState(null),
    [showProjects, setShowProjects] = useState(false),
    [stale, setStale] = useState(false);
  const api = useCallback(
    async (path, body, method) => {
      const result = await requestApi(
        path,
        body,
        method,
        '/api/projects/' + project.id,
        body === undefined ? undefined : revision.current,
      );
      if (body !== undefined && result.project) {
        revision.current = result.project.revision;
        setProjectInfo(result.project);
      }
      return result;
    },
    [project.id],
  );
  const operationStarted = useRef(0);
  const [topology, setTopology] = useState(null),
    [runtime, setRuntime] = useState({
      connected: false,
      nodes: {},
      networks: [],
      deployed: false,
    }),
    [busy, setBusy] = useState(false),
    [capture, setCapture] = useState(false),
    [connection, setConnection] = useState(true);
  const [selected, setSelected] = useState(initialSelection || null),
    [packets, setPackets] = useState([]),
    [bursts, setBursts] = useState([]),
    [journal, setJournal] = useState([]),
    [paused, setPaused] = useState(false),
    [snapshot, setSnapshot] = useState([]),
    [tab, setTab] = useState('packets'),
    [filter, setFilter] = useState('ALL'),
    [search, setSearch] = useState(''),
    [packet, setPacket] = useState(null);
  const [toast, setToast] = useState(null),
    [modal, setModal] = useState(null),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState(true),
    [panelTab, setPanelTab] = useState('config'),
    [logs, setLogs] = useState(''),
    [terminalNode, setTerminalNode] = useState(null);
  const [probeSource, setProbeSource] = useState('client'),
    [probeTarget, setProbeTarget] = useState('web'),
    [probeProtocol, setProbeProtocol] = useState('ICMP'),
    [total, setTotal] = useState(0),
    [packetRate, setPacketRate] = useState(0),
    [showInspector, setShowInspector] = useState(!!initialSelection);
  const [showInventory, setShowInventory] = useState(initialInventory && !initialSelection);
  const [addContainerHost, setAddContainerHost] = useState(null),
    [imagePicker, setImagePicker] = useState(false),
    [workbench, setWorkbench] = useState(null);
  const [customModels, setCustomModels] = useState(() => BROWSER_MODE ? [] : loadEquipmentTemplates(localStorage)),
    [templateSeed, setTemplateSeed] = useState(null);
  const [testResults, setTestResults] = useState([]),
    [testResult, setTestResult] = useState(null),
    [probeDraft, setProbeDraft] = useState(null);
  const [animationSpeed, setAnimationSpeed] = useState(1);
  const [changePlan, setChangePlan] = useState(null);
  const baseline = useRef(null);
  useEffect(() => {
    onWorkspaceStatus?.({ dirty, busy });
  }, [dirty, busy, onWorkspaceStatus]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);
  const inspectPacket = useCallback((p) => setPacket(p), []);
  const equipmentTemplates = [
    ...templates,
    ...customModels.map((m) => ({
      key: m.id,
      label: m.title,
      description: m.data.image,
      icon: m.data.icon,
      kind: 'container',
      custom: true,
    })),
  ];
  const saveModel = (model) => {
    const next = [...customModels.filter((m) => m.id !== model.id), model];
    if (next.length > 50) throw Error('La bibliothèque est limitée à 50 modèles.');
    if (!BROWSER_MODE) localStorage.setItem(templateStorageKey, JSON.stringify(next));
    setCustomModels(next);
  };
  const deleteModel = (id) => {
    const next = customModels.filter((m) => m.id !== id);
    if (!BROWSER_MODE) localStorage.setItem(templateStorageKey, JSON.stringify(next));
    setCustomModels(next);
  };
  const closeInventory = useCallback(() => setShowInventory(false), []);
  const openInventoryLabNode = useCallback((id) => {
    setShowInventory(false);
    setSelected(id);
    setShowInspector(true);
    setPanelTab('config');
  }, []);
  const [tool, setTool] = useState('select'),
    [category, setCategory] = useState('all'),
    [showPorts, setShowPorts] = useState(true),
    [showGrid, setShowGrid] = useState(false),
    [dockOpen, setDockOpen] = useState(true),
    [connectFrom, setConnectFrom] = useState(null),
    [zoom, setZoom] = useState(1);
  const graphRef = useRef(null),
    legacyTerminal = useRef(null),
    fileInput = useRef(),
    packetBuffer = useRef([]),
    rateCounter = useRef(0),
    localBusy = useRef(false),
    initialized = useRef(false);
  const flow = useReactFlow();
  useEffect(() => {
    const closeMenus = (e) => {
      if (!e.target.closest?.('.menu'))
        document.querySelectorAll('.menu[open]').forEach((m) => {
          m.open = false;
        });
    };
    const escape = (e) => {
      if (e.key !== 'Escape') return;
      if (e.target.closest?.('.xterm')) return;
      if (document.querySelector('.inventory-screen')) return;
      document.querySelectorAll('.menu[open]').forEach((m) => {
        m.open = false;
      });
      setModal(null);
      setPacket(null);
      setShowInspector(false);
      setConnectFrom(null);
      setTool('select');
    };
    document.addEventListener('pointerdown', closeMenus);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeMenus);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  graphRef.current = topology;
  dirtyRef.current = dirty;
  const notify = (message, error = false) => setToast({ message, error });
  const loadState = useCallback(async () => {
    try {
      const s = await api('/state');
      setFilesAvailable(s.capabilities?.applicationFiles === true);
      setStartupAvailable(s.capabilities?.startupChecks === true);
      setBridgesAvailable(s.capabilities?.advancedBridges === true);
      setBackupsAvailable(s.capabilities?.volumeBackups === true);
      setDeploymentRuns(s.deployments || []);
      setRuntime(s.runtime);
      setCapture(s.capture);
      if (!localBusy.current) setBusy(s.busy);
      setConnection(true);
      if (s.project) {
        setProjectInfo(s.project);
        if (dirtyRef.current && s.project.revision !== revision.current) setStale(true);
      }
      if (
        !initialized.current ||
        (!dirtyRef.current && !localBusy.current && s.project?.revision !== revision.current)
      ) {
        initialized.current = true;
        setTopology((previous) => withMeasurements(previous, s.topology));
        revision.current = s.project.revision;
        setTestResults(s.tests || []);
        setStale(false);
        baseline.current = s.topology;
        setJournal(s.journal);
      }
      return s;
    } catch {
      setConnection(false);
    }
  }, []);
  useEffect(() => {
    loadState();
    if (BROWSER_MODE) return undefined;
    const timer = setInterval(loadState, 3000);
    return () => clearInterval(timer);
  }, [loadState]);
  useEffect(() => {
    if (BROWSER_MODE) return undefined;
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.projectId !== project.id) return;
      if (event.type === 'packet') {
        packetBuffer.current.push(event.packet);
        if (packetBuffer.current.length > 1000) packetBuffer.current.shift();
        rateCounter.current++;
        return;
      }
      if (event.type === 'capture') setCapture(event.active);
      if (event.type === 'busy' && !localBusy.current) setBusy(event.busy);
      if (event.message)
        setJournal((prev) => [{ ...event, time: Date.now() }, ...prev].slice(0, 100));
    };
    const timer = setInterval(() => {
      const incoming = packetBuffer.current.splice(0);
      if (incoming.length) {
        setPackets((prev) => [...incoming.reverse(), ...prev].slice(0, 600));
        setTotal((n) => n + incoming.length);
      }
      setBursts((prev) =>
        [
          ...prev.filter((p) => Date.now() - p.received < (p.replay ? 14000 : 6000)),
          ...incoming.slice(0, 24).map((p) => ({ ...p, received: Date.now() })),
        ].slice(-48),
      );
    }, 150);
    const rate = setInterval(() => {
      setPacketRate(rateCounter.current);
      rateCounter.current = 0;
    }, 1000);
    return () => {
      es.close();
      clearInterval(timer);
      clearInterval(rate);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (BROWSER_MODE) return undefined;
    if (!selected || !runtime.nodes[selected] || panelTab !== 'logs') return;
    let active = true;
    const read = () =>
      api(`/nodes/${selected}/logs`)
        .then((r) => active && setLogs(r.output || 'Aucun log pour le moment.'))
        .catch((e) => active && setLogs(e.message));
    read();
    const timer = setInterval(read, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, panelTab, runtime.nodes[selected]?.state]);
  const change = (fn) => {
    dirtyRef.current = true;
    setTopology((t) => fn(t));
    setDirty(true);
    setSaved(false);
  };
  const previewChanges = async () => {
    const plan = await api('/lab/preview', topologySchema.parse(graphRef.current));
    setChangePlan(plan);
    setModal('changes');
  };
  const save = async () => {
    const next = topologySchema.parse(graphRef.current);
    if (runtime.deployed && deploymentSignature(next) !== deploymentSignature(baseline.current)) {
      await previewChanges();
      return;
    }
    const r = await api('/topology', next, 'PUT');
    baseline.current = r.topology;
    setTopology((previous) => withMeasurements(previous, r.topology));
    setDirty(false);
    dirtyRef.current = false;
    setSaved(true);
    return r;
  };
  const action = async (fn) => {
    if (localBusy.current) return;
    let failedRun;
    localBusy.current = true;
    operationStarted.current = Date.now();
    setBusy(true);
    try {
      await fn();
      await loadState();
    } catch (e) {
      failedRun = e.deploymentRun;
      notify(
        e.issues ? [...new Set(e.issues.map((i) => i.message))].slice(0, 3).join(' ') : e.message,
        true,
      );
    } finally {
      localBusy.current = false;
      const state = await loadState();
      const report = state?.deployments?.find((r) => r.id === failedRun);
      if (report) {
        setDeploymentRun(report);
        setModal('deployment-result');
      }
      setBusy(false);
    }
  };
  const addDevice = (key, position) => {
    if (busy) return;
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    const node = newNode(
      key,
      id,
      position ||
        flow.screenToFlowPosition({ x: window.innerWidth * 0.5, y: window.innerHeight * 0.4 }),
    );
    const model = customModels.find((m) => m.id === key);
    if (model) node.data = { ...structuredClone(model.data), label: `custom-${id.slice(-4)}` };
    change((t) => ({ ...t, nodes: [...t.nodes, node] }));
    setSelected(id);
    setShowInspector(true);
    setPanelTab('config');
  };
  const onConnect = useCallback(
    (c) => {
      if (busy) return;
      const t = graphRef.current,
        a = t.nodes.find((n) => n.id === c.source),
        b = t.nodes.find((n) => n.id === c.target);
      if (a?.data.kind === b?.data.kind) {
        notify('Relie un conteneur à un réseau bridge.', true);
        return;
      }
      if (
        t.edges.some(
          (e) => [e.source, e.target].sort().join() === [c.source, c.target].sort().join(),
        )
      )
        return;
      change((t) => ({
        ...t,
        edges: [...t.edges, { ...c, id: `e-${crypto.randomUUID().slice(0, 8)}`, type: 'traffic' }],
      }));
    },
    [busy],
  );
  const selectNode = (_, n) => {
    setSelected(n.id);
    setShowInspector(true);
    setPanelTab('config');
  };
  const removeNode = (id) => {
    if (locked) return;
    change((t) => ({
      ...t,
      nodes: t.nodes.filter((n) => n.id !== id),
      edges: t.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    setSelected(null);
    setShowInspector(false);
  };
  const clickNode = (_, n) => {
    if (tool === 'delete') return removeNode(n.id);
    if (tool === 'connect' && !locked) {
      if (!connectFrom) {
        setConnectFrom(n.id);
        setSelected(n.id);
        return;
      }
      if (connectFrom !== n.id) {
        const from = topology.nodes.find((x) => x.id === connectFrom);
        const right = from.position.x < n.position.x;
        onConnect({
          source: from.id,
          target: n.id,
          sourceHandle: right ? 'right' : 'left',
          targetHandle: right ? 'left' : 'right',
        });
      }
      setConnectFrom(null);
      return;
    }
    selectNode(_, n);
  };
  const togglePause = () => {
    if (!paused) setSnapshot(packets);
    setPaused((v) => !v);
  };
  const updateData = (key, value) =>
    change((t) => ({
      ...t,
      nodes: t.nodes.map((n) =>
        n.id === selected ? { ...n, data: { ...n.data, [key]: value } } : n,
      ),
    }));
  const current = topology?.nodes.find((n) => n.id === selected),
    live = runtime.nodes[selected];
  const liveWorkbenchContainer =
    workbench &&
    (project.hostId || 'local') === (workbench.container.hostId || 'local') &&
    Object.values(runtime.nodes).find(
      (c) => (c.dockerId || c.id) === (workbench.container.dockerId || workbench.container.id),
    );
  const workbenchContainer = workbench
    ? liveWorkbenchContainer && runtime.connected
      ? { ...workbench.container, ...liveWorkbenchContainer, hostId: project.hostId || 'local' }
      : { ...workbench.container, state: 'unknown', stale: true }
    : null;
  const containers = topology?.nodes.filter((n) => n.data.kind === 'container') || [],
    networks = topology?.nodes.filter((n) => n.data.kind === 'network') || [];
  const running = Object.values(runtime.nodes).filter((n) => n.state === 'running').length;
  const locked = busy;
  const validation = topology ? topologySchema.safeParse(topology) : null;
  const displayed = (paused ? snapshot : packets).filter(
    (p) =>
      (filter === 'ALL' || p.protocol === filter) &&
      (!search ||
        `${p.source} ${p.target} ${p.info} ${p.protocol}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const runProbe = (options) =>
    action(async () => {
      setProbeDraft(options);
      setModal(null);
      setShowInspector(false);
      setPacket(null);
      setTab('packets');
      const startedAt = Date.now();
      let result;
      try {
        if (options.autoCapture && !capture) await api('/capture', { enabled: true });
        result = await api('/probe', options);
      } catch (e) {
        result = {
          startedAt,
          finishedAt: Date.now(),
          exitCode: -1,
          output: e.message,
          summary: e.message,
        };
      }
      const record = {
        ...result,
        id: result.id || crypto.randomUUID(),
        protocol: options.protocol,
        source: options.source,
        target: options.target,
        options,
        sourceLabel:
          topology.nodes.find((n) => n.id === options.source)?.data.label || options.source,
        targetLabel:
          topology.nodes.find((n) => n.id === options.target)?.data.label || options.target,
      };
      setTestResults((prev) => [record, ...prev].slice(0, 30));
      setSelected(options.source);
      setTab('tests');
      notify(result.summary, result.exitCode !== 0);
    });
  const replayPacket = (p) => {
    setPacket(null);
    setBursts((prev) => [...prev, { ...p, received: Date.now(), replay: true }]);
  };
  const importTopology = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (f.size > PROJECT_JSON_LIMIT) throw Error('Fichier trop volumineux (8 Mio maximum).');
      const parsed = topologySchema.parse(JSON.parse(await f.text()));
      if (locked) throw Error('Attends la fin de l’opération avant d’importer une topologie.');
      change((previous) => withMeasurements(previous, { ...parsed, id: graphRef.current.id }));
      setSelected(null);
      setTimeout(() => flow.fitView({ padding: 0.2 }), 100);
      notify(BROWSER_MODE
        ? 'Topologie importée. Enregistre et exporte-la pour la conserver.'
        : 'Topologie importée. Enregistre puis déploie le laboratoire.');
    } catch (e) {
      notify(e.message, true);
    }
    e.target.value = '';
  };
  if (!topology)
    return (
      <div className="loading">
        <Network size={38} />
        <h2>Docker Tracer</h2>
        <p>
          {connection ? 'Ouverture de l’atelier…' : 'Serveur inaccessible. Relance l’application.'}
        </p>
        <button onClick={loadState}>Réessayer</button>
      </div>
    );
  return (
    <LiveContext.Provider
      value={{ runtime, bursts, paused, topology, showPorts, inspectPacket, animationSpeed }}
    >
      <div className={`app${BROWSER_MODE ? ' browser-mode' : ''}`}>
        {imagePicker && (
          <WorkspaceModal
            title="Choisir une image Docker"
            wide
            onClose={() => setImagePicker(false)}
          >
            <DockerImagePicker
              embedded
              hostId={project.hostId}
              onClose={() => setImagePicker(false)}
              onSelect={({ image }) => {
                const id = 'n-' + crypto.randomUUID().slice(0, 8),
                  node = newNode(
                    'custom',
                    id,
                    flow.screenToFlowPosition({
                      x: window.innerWidth * 0.5,
                      y: window.innerHeight * 0.4,
                    }),
                  );
                node.data.image = image;
                node.data.command = '';
                node.data.label =
                  image
                    .split('@')[0]
                    .split('/')
                    .at(-1)
                    .split(':')[0]
                    .replace(/[^a-zA-Z0-9_.-]/g, '-')
                    .slice(0, 35) +
                  '-' +
                  id.slice(-4);
                change((t) => ({ ...t, nodes: [...t.nodes, node] }));
                setSelected(id);
                setShowInspector(true);
                setPanelTab('config');
                setImagePicker(false);
              }}
            />
          </WorkspaceModal>
        )}
        {addContainerHost && (
          <AddContainer
            hostId={addContainerHost}
            onClose={() => setAddContainerHost(null)}
            onOpen={onOpenProject}
          />
        )}
        {workbench && (
          <ContainerWorkbench
            container={workbenchContainer}
            initialTab={workbench.tab}
            onClose={() => setWorkbench(null)}
            onChanged={loadState}
            onEditConfiguration={() => {
              setWorkbench(null);
              setShowInspector(true);
              setPanelTab('config');
            }}
          />
        )}

        {showProjects && (
          <Projects
            initialPage={showProjects === 'import' ? 'import' : 'projects'}
            current={projectInfo}
            dirty={dirty}
            onOpen={onOpenProject}
            onClose={() => setShowProjects(false)}
          />
        )}

        {showInventory && (
          <Inventory
            onClose={closeInventory}
            onOpenLab={openInventoryLabNode}
            onOpenProject={(next, nodeId, section) => {
              if (next.id === project.id) openInventoryLabNode(nodeId);
              else if (dirtyRef.current) {
                notify(
                  'Enregistre les modifications du projet actuel avant d’ouvrir un autre projet.',
                  true,
                );
              } else onOpenProject(next, nodeId, section);
            }}
            currentLab={topology.id}
            currentHost={project.hostId}
            projectsOpen={showProjects}
            onProjects={(mode) => setShowProjects(mode === 'import' ? 'import' : true)}
            onAddContainer={(hostId) => {
              if (dirtyRef.current)
                notify('Enregistre ton brouillon avant de modifier un autre projet.', true);
              else setAddContainerHost(hostId);
            }}
          />
        )}
        <div
          className="lab-surface"
          inert={!!(showInventory || showProjects || imagePicker || addContainerHost || workbench)}
          aria-hidden={!!(showInventory || showProjects) || undefined}
        >
          <header className="desktop-header">
            <div className="window-title">
              <Network size={15} />
              <strong>Docker Tracer</strong>
              <span>
                · {topology.name}
                {saved ? '' : ' *'}
              </span>
              <span className="local-label">
                {BROWSER_MODE ? 'Atelier navigateur' : `Cible : ${projectInfo.host.name}`}
                {!BROWSER_MODE && projectInfo.host.kind === 'ssh'
                  ? ' · ' + projectInfo.host.username + '@' + projectInfo.host.address
                  : !BROWSER_MODE ? ' · Docker local' : ''}
              </span>
            </div>
            {BROWSER_MODE && (
              <div className="browser-header-links">
                <a className="autodocker-brand-link" href="/essai/"><span className="autodocker-logo" aria-hidden="true"><img src={AUTODOCKER_LOGO_URL} alt="" draggable={false} /></span>AutoDocker</a>
                <BrowserDownloads />
              </div>
            )}
            <nav className="menubar" aria-label="Menu principal">
              {[
                [
                  'Fichier',
                  [
                    ['Mes infrastructures…', () => setShowProjects(true), busy],
                    ['Enregistrer', () => action(save), busy],
                    ['Importer une topologie…', () => fileInput.current.click(), locked],
                    ['Exporter JSON / Compose…', () => setModal('export')],
                  ],
                ],
                [
                  'Édition',
                  [
                    ['Configurer la sélection…', () => selectNode(null, current), !current],
                    ['Supprimer la sélection', () => removeNode(selected), !current || locked],
                  ],
                ],
                [
                  'Affichage',
                  [
                    [
                      'Centrer le réseau',
                      () => flow.fitView({ padding: 0.25, maxZoom: 1, duration: 200 }),
                    ],
                    [
                      showPorts ? 'Masquer les interfaces' : 'Afficher les interfaces',
                      () => setShowPorts((v) => !v),
                    ],
                    [
                      showGrid ? 'Masquer la grille' : 'Afficher la grille',
                      () => setShowGrid((v) => !v),
                    ],
                    [
                      dockOpen
                        ? 'Masquer la palette et les événements'
                        : 'Afficher la palette et les événements',
                      () => setDockOpen((v) => !v),
                    ],
                  ],
                ],
                [
                  'Réseau',
                  [
                    ['Actualiser Docker', () => action(() => api('/refresh', {})), BROWSER_MODE || busy],
                    ['Envoyer un test…', () => setModal('probe'), BROWSER_MODE || busy || !running],
                    [
                      'Libérer le laboratoire…',
                      () => setModal('remove'),
                      BROWSER_MODE || !runtime.deployed || busy,
                    ],
                  ],
                ],
                [
                  'Capture',
                  [
                    [
                      capture ? 'Arrêter la capture' : 'Démarrer la capture',
                      () => action(() => api('/capture', { enabled: !capture })),
                      BROWSER_MODE || busy || !running,
                    ],
                    [paused ? 'Reprendre l’affichage' : 'Figer l’affichage', togglePause],
                    [
                      'Exporter les paquets JSON',
                      () =>
                        download('docker-tracer-paquets.json', JSON.stringify(packets, null, 2)),
                      !packets.length,
                    ],
                  ],
                ],
                ['Aide', [['Guide de Docker Tracer', () => setModal('help')]]],
              ].filter(([name]) => !BROWSER_MODE || !['Réseau', 'Capture'].includes(name)).map(([name, items]) => (
                <details key={name} name="main-menu" className="menu">
                  <summary>{name}</summary>
                  <div className="menu-popover">
                    {items.map(([label, fn, disabled]) => (
                      <button
                        key={label}
                        aria-label={label}
                        disabled={disabled}
                        onClick={(e) => {
                          e.currentTarget.closest('details').open = false;
                          fn();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </nav>
            <div className="main-toolbar" role="toolbar" aria-label="Outils du laboratoire">
              <button className="toolbar-command" disabled={locked} onClick={onImportCompose}>
                <Upload size={15} /> Importer un Compose
              </button>
              <button
                className="tool-button"
                title="Importer une topologie"
                disabled={locked}
                onClick={() => fileInput.current.click()}
              >
                <FolderOpen />
              </button>
              <button
                className="tool-button"
                title="Enregistrer"
                disabled={busy}
                onClick={() => action(save)}
              >
                <Save />
              </button>
              <button
                className="tool-button"
                title="Exporter JSON / Compose"
                onClick={() => setModal('export')}
              >
                <ArrowUpFromLine />
              </button>
              <span className="tool-separator" />
              <button
                className="tool-button"
                title="Zoom avant"
                onClick={() => flow.zoomIn({ duration: 150 })}
              >
                <ZoomIn />
              </button>
              <button
                className="tool-button"
                title="Zoom arrière"
                onClick={() => flow.zoomOut({ duration: 150 })}
              >
                <ZoomOut />
              </button>
              <button
                className="tool-button"
                title="Centrer le réseau"
                onClick={() => flow.fitView({ padding: 0.25, maxZoom: 1, duration: 200 })}
              >
                <Scan />
              </button>
              <span className="tool-separator" />
              {!BROWSER_MODE && <button
                className="tool-button"
                title="Actualiser Docker"
                disabled={busy}
                onClick={() => action(() => api('/refresh', {}))}
              >
                <RefreshCw />
              </button>}
              <button
                className="tool-button"
                title="Guide de l’atelier"
                onClick={() => setModal('help')}
              >
                <CircleHelp />
              </button>
              <span className="toolbar-spacer" />
              <input
                className="project-name"
                aria-label="Nom du laboratoire"
                disabled={busy}
                value={topology.name}
                maxLength={80}
                onChange={(e) => change((t) => ({ ...t, name: e.target.value }))}
              />
              <span
                className="save-state"
                title={saved ? 'Enregistré' : 'Modifications à enregistrer'}
              >
                {saved ? <Check size={13} /> : '*'}
              </span>
              <span className="tool-separator" />
              {BROWSER_MODE ? (
                <span className="toolbar-command browser-local-action">
                  <Download size={13} /><BrowserDownloads label="Déployer avec l’application locale" />
                </span>
              ) : runtime.deployed ? (
                <>
                  <button
                    className="toolbar-command deploy-button"
                    disabled={busy || !runtime.connected || !dirty}
                    onClick={() => action(previewChanges)}
                  >
                    <Check size={13} />
                    Vérifier les changements
                  </button>
                  <button
                    className="toolbar-command"
                    disabled={busy || !dirty}
                    onClick={() => {
                      setTopology((previous) =>
                        withMeasurements(previous, structuredClone(baseline.current)),
                      );
                      setDirty(false);
                      setSaved(true);
                    }}
                  >
                    Annuler les modifications
                  </button>
                  <button
                    className="toolbar-command"
                    disabled={busy || !runtime.connected}
                    onClick={() =>
                      action(() => api('/lab/action', { action: running ? 'stop' : 'start' }))
                    }
                  >
                    {running ? <Square size={13} /> : <Play size={13} />}{' '}
                    {running ? 'Arrêter' : 'Démarrer'}
                  </button>
                  <button
                    className="toolbar-command"
                    disabled={busy || !runtime.connected}
                    onClick={() => setModal('remove')}
                  >
                    <Layers size={14} />
                    Libérer le labo
                  </button>
                </>
              ) : (
                <button
                  className="toolbar-command deploy-button"
                  disabled={busy || !runtime.connected || !containers.length}
                  onClick={() =>
                    action(async () => {
                      await save();
                      await api('/deploy', {});
                    })
                  }
                >
                  <Play size={13} />
                  Déployer le labo
                </button>
              )}
            </div>
            <div className="drawing-toolbar" role="toolbar" aria-label="Outils de dessin">
              {[
                ['select', MousePointer2, 'Sélectionner'],
                ['pan', Hand, 'Déplacer le canevas'],
                ['connect', Cable, 'Connecter deux équipements'],
                ['delete', X, 'Supprimer un équipement'],
              ].map(([key, Icon, title]) => (
                <button
                  key={key}
                  className={`tool-button ${tool === key ? 'active' : ''}`}
                  title={title}
                  disabled={locked && ['connect', 'delete'].includes(key)}
                  onClick={() => {
                    setTool(key);
                    setConnectFrom(null);
                  }}
                >
                  <Icon size={17} />
                </button>
              ))}
              <span className="tool-separator" />
              <button
                className="tool-button pdu-tool"
                title="Envoyer un test"
                disabled={busy || !runtime.connected || !running}
                onClick={() => setModal('probe')}
              >
                <Mail size={19} />
                <span>+</span>
              </button>
              <button
                className="tool-button"
                title="Configurer la sélection"
                disabled={!current}
                onClick={() => selectNode(null, current)}
              >
                <Settings2 size={18} />
              </button>
              <span className="tool-hint">
                {tool === 'connect'
                  ? connectFrom
                    ? 'Clique sur le second équipement.'
                    : 'Clique sur un conteneur puis sur un réseau bridge.'
                  : tool === 'delete'
                    ? 'Clique sur un équipement pour le retirer.'
                    : 'Clic : configurer · Glisser : déplacer · Molette : zoomer'}
              </span>
            </div>
          </header>
          <input
            type="file"
            accept="application/json,.json"
            ref={fileInput}
            hidden
            onChange={importTopology}
          />
          {BROWSER_MODE ? (
            <div className="connection-banner browser-workshop-banner" role="status">
              <Network size={16} />
              <span>Atelier navigateur · dessine, configure et exporte ton infrastructure. Le déploiement et les outils Docker sont dans l’application locale.</span>
            </div>
          ) : (!runtime.connected || !connection) && (
            <div className="connection-banner">
              <WifiOff size={16} />
              <span>
                {!connection
                  ? 'Connexion à l’application perdue.'
                  : runtime.message ||
                    'Démarre Docker Desktop en mode Linux pour déployer ton réseau.'}{' '}
                Tu peux préparer ton schéma.
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api('/refresh', {});
                  })
                }
              >
                <RefreshCw size={13} />
                Actualiser
              </button>
            </div>
          )}
          <main className={`workbench tool-${tool} ${dockOpen ? '' : 'dock-hidden'}`}>
            <div className="workspace-strip">
              <button
                className="create-infrastructure-button"
                disabled={busy}
                onClick={() => setImagePicker(true)}
              >
                <Plus size={16} /> Ajouter un conteneur
              </button>
              <button
                className="inventory-open"
                disabled={busy}
                onClick={() => setShowProjects(true)}
              >
                <FolderOpen size={13} /> Mes projets
              </button>
              {!BROWSER_MODE && <button
                className="inventory-open"
                title="Découvrir tous les conteneurs et réseaux du Docker local"
                onClick={() => setShowInventory(true)}
              >
                <Network size={13} />
                Tout Docker
              </button>}
              {!BROWSER_MODE && <button
                className="inventory-open"
                disabled={busy}
                onClick={() => setModal('volumes')}
              >
                Volumes & sauvegardes
              </button>}
              <span className="logical-tab">
                <Network size={14} /> Logique
              </span>
              <span>
                {containers.length} conteneurs · {networks.length} réseaux
              </span>
              {dirty && (
                <span className="draft-label">
                  {runtime.deployed
                    ? 'Brouillon · changements non appliqués'
                    : 'Brouillon non enregistré'}
                </span>
              )}
              <span className="toolbar-spacer" />
              <span className={`engine-status ${!BROWSER_MODE && runtime.connected && connection ? 'online' : ''}`}>
                <i className="tiny-dot" />
                {BROWSER_MODE ? 'Atelier navigateur' : runtime.connected && connection
                  ? `Docker connecté · ${running} en ligne`
                  : 'Docker hors ligne'}
              </span>
            </div>
            {stale && (
              <div className="project-error" role="alert">
                Ce projet a changé dans une autre fenêtre. Ton brouillon est conservé ici.{' '}
                <button
                  onClick={async () => {
                    dirtyRef.current = false;
                    setDirty(false);
                    setSaved(true);
                    initialized.current = false;
                    await loadState();
                  }}
                >
                  Abandonner le brouillon et recharger
                </button>
              </div>
            )}
            <section className="canvas-shell">
              <div
                className="flow-area"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const key = e.dataTransfer.getData('application/dockertracer');
                  if (key)
                    addDevice(
                      key,
                      flow.screenToFlowPosition({ x: e.clientX - 44, y: e.clientY - 25 }),
                    );
                }}
              >
                <ReactFlow
                  nodes={topology.nodes.map((n) => ({
                    ...n,
                    selected: n.id === selected,
                    ariaLabel: n.data.label,
                  }))}
                  edges={topology.edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onConnect={onConnect}
                  connectionMode={ConnectionMode.Loose}
                  nodesConnectable={!locked && tool === 'connect'}
                  nodesDraggable={!busy && tool === 'select'}
                  panOnDrag={tool === 'pan' || tool === 'select'}
                  onMove={(_, viewport) => setZoom(viewport.zoom)}
                  onNodeClick={clickNode}
                  onNodeDoubleClick={selectNode}
                  onEdgeClick={(_, edge) => {
                    if (tool === 'delete' && !locked)
                      change((t) => ({ ...t, edges: t.edges.filter((e) => e.id !== edge.id) }));
                  }}
                  onNodeContextMenu={(e, n) => {
                    e.preventDefault();
                    selectNode(e, n);
                    const c = runtime.nodes[n.id];
                    if (n.data.kind === 'container' && c?.id)
                      setWorkbench({
                        container: {
                          ...c,
                          hostId: project.hostId,
                          name: c.name || 'dtr-' + topology.id + '-' + n.id,
                        },
                        tab: 'terminal',
                      });
                  }}
                  onPaneClick={() => {
                    setSelected(null);
                    setConnectFrom(null);
                    setShowInspector(false);
                  }}
                  onNodesChange={(changes) => {
                    const allowed = changes.filter(
                      (c) =>
                        c.type === 'position' ||
                        c.type === 'dimensions' ||
                        (!locked && c.type === 'remove'),
                    );
                    if (!allowed.length) return;
                    setTopology((t) => {
                      const nodes = applyNodeChanges(allowed, t.nodes);
                      return {
                        ...t,
                        nodes,
                        edges: t.edges.filter(
                          (e) =>
                            nodes.some((n) => n.id === e.source) &&
                            nodes.some((n) => n.id === e.target),
                        ),
                      };
                    });
                    if (allowed.some((c) => c.type !== 'dimensions')) {
                      dirtyRef.current = true;
                      setDirty(true);
                      setSaved(false);
                    }
                  }}
                  onEdgesChange={(changes) => {
                    const allowed = changes.filter((c) => !locked || c.type !== 'remove');
                    setTopology((t) => ({ ...t, edges: applyEdgeChanges(allowed, t.edges) }));
                    if (allowed.some((c) => c.type === 'remove')) {
                      dirtyRef.current = true;
                      setDirty(true);
                      setSaved(false);
                    }
                  }}
                  fitView
                  fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                  minZoom={0.35}
                  maxZoom={2}
                  deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
                  snapToGrid
                  snapGrid={[10, 10]}
                  colorMode="light"
                >
                  {showGrid && <Background bgColor="#ffffff" color="#cbd1d6" gap={20} size={1} />}
                </ReactFlow>
              </div>
              <div className="canvas-coordinate">{Math.round(zoom * 100)} %</div>
            </section>
            <div className="mode-strip">
              <button title="Afficher ou masquer la palette" onClick={() => setDockOpen((v) => !v)}>
                <Layers size={15} />
                <ChevronRight
                  size={13}
                  style={{ transform: dockOpen ? 'rotate(90deg)' : 'rotate(-90deg)' }}
                />
              </button>
              <span className="mode-note">
                {BROWSER_MODE ? 'Conception dans le navigateur' : runtime.deployed ? 'Laboratoire déployé' : 'Conception du réseau'}
                {capture && ' · Capture active'}
                {paused && ' · Affichage figé'}
              </span>
              <span className="toolbar-spacer" />
              {!BROWSER_MODE && <button
                className={`mode-tab ${!paused ? 'active' : ''}`}
                onClick={() => setPaused(false)}
              >
                <Activity size={15} />
                Temps réel
              </button>}
              {!BROWSER_MODE && <button
                className={`mode-tab ${paused ? 'active' : ''}`}
                title="Figer les événements ; le trafic Docker continue"
                onClick={() => {
                  if (!paused) togglePause();
                }}
              >
                <Pause size={14} />
                Inspection
              </button>}
            </div>
            <div className="bottom-dock">
              <aside className="equipment-library" aria-label="Palette d’équipements">
                <div className="library-title">
                  Équipements{' '}
                  <span>
                    {locked
                      ? 'Opération en cours…'
                      : runtime.deployed
                        ? 'Modifie puis vérifie les changements'
                        : 'Glisse un modèle dans le réseau'}
                  </span>
                  <button
                    className="template-entry"
                    title="Mes modèles Docker personnalisés"
                    onClick={() => {
                      setTemplateSeed(null);
                      setModal('templates');
                    }}
                  >
                    <Plus size={12} />
                    Mes modèles
                  </button>
                </div>
                <button
                  className="inventory-open"
                  disabled={locked}
                  onClick={() => setImagePicker(true)}
                >
                  <Search size={15} /> {BROWSER_MODE ? 'Choisir une image' : 'Rechercher une image Docker Hub'}
                </button>
                <div className="equipment-browser">
                  <div className="device-categories">
                    {[
                      ['all', Box, 'Tous'],
                      ['terminal', Monitor, 'Terminaux'],
                      ['server', Server, 'Serveurs'],
                      ['network', Network, 'Réseaux'],
                    ].map(([key, Icon, label]) => (
                      <button
                        key={key}
                        title={label}
                        className={category === key ? 'active' : ''}
                        onClick={() => setCategory(key)}
                      >
                        <Icon size={21} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="palette">
                    {equipmentTemplates
                      .filter(
                        (t) =>
                          category === 'all' ||
                          (category === 'server'
                            ? ['globe', 'database', 'server'].includes(t.icon)
                            : t.icon === category),
                      )
                      .map((t) => (
                        <button
                          key={t.key}
                          className={`palette-item ${t.custom ? 'custom-template' : ''}`}
                          disabled={locked}
                          draggable={!locked}
                          title={`${t.label} · ${t.description}${locked ? ' · Opération en cours' : ''}`}
                          onDragStart={(e) =>
                            e.dataTransfer.setData('application/dockertracer', t.key)
                          }
                          onClick={() => addDevice(t.key)}
                        >
                          <EquipmentIcon kind={t.icon} />
                          <span>
                            {t.custom
                              ? t.label
                              : t.key === 'client'
                                ? 'PC Linux'
                                : t.key === 'nginx'
                                  ? 'Nginx'
                                  : t.key === 'redis'
                                    ? 'Redis'
                                    : t.key === 'network'
                                      ? 'Bridge'
                                      : 'Docker'}
                          </span>
                        </button>
                      ))}
                  </div>
                </div>
                <div className="library-footer">
                  <Cable size={13} />
                  <span>Ethernet · conteneur ↔ réseau bridge</span>
                </div>
              </aside>
              <section className="traffic-panel">
                <div className="traffic-toolbar">
                  <div className="traffic-tabs">
                    <button
                      className={tab === 'tests' ? 'active' : ''}
                      onClick={() => setTab('tests')}
                    >
                      Tests <span>({testResults.length})</span>
                    </button>
                    <button
                      className={tab === 'packets' ? 'active' : ''}
                      onClick={() => setTab('packets')}
                    >
                      Liste des événements <span>({total})</span>
                    </button>
                    <button
                      className={tab === 'journal' ? 'active' : ''}
                      onClick={() => setTab('journal')}
                    >
                      Journal
                    </button>
                    <button
                      className={tab === 'deployments' ? 'active' : ''}
                      onClick={() => setTab('deployments')}
                    >
                      Déploiements <span>({deploymentRuns.length})</span>
                    </button>
                  </div>
                  <span className="toolbar-spacer" />
                  <span className="rate">{packetRate} paq/s</span>
                  <button
                    className="text-btn"
                    title="Envoyer un test"
                    disabled={busy || !runtime.connected || !running}
                    onClick={() => setModal('probe')}
                  >
                    <Mail size={14} />
                    Test PDU
                  </button>
                  <button
                    className={`capture-button ${capture ? 'capturing' : ''}`}
                    disabled={busy || !runtime.connected || !running}
                    onClick={() => action(() => api('/capture', { enabled: !capture }))}
                  >
                    {capture ? <Square size={10} /> : <Radio size={13} />}{' '}
                    {capture ? 'Arrêter la capture' : 'Capturer'}
                  </button>
                </div>
                {tab === 'packets' ? (
                  <>
                    <div className="traffic-filters">
                      <label className="protocol-filters">
                        Filtre :{' '}
                        <select
                          aria-label="Filtrer par protocole"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        >
                          {['ALL', 'ICMP', 'TCP', 'UDP', 'DNS', 'HTTP', 'TLS', 'ARP'].map((p) => (
                            <option key={p} value={p}>
                              {p === 'ALL' ? 'Tous les protocoles' : p}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="packet-search">
                        <Search size={13} />
                        <input
                          aria-label="Filtrer le trafic"
                          placeholder="IP, protocole, contenu…"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <button
                        className="icon-btn"
                        title={
                          paused
                            ? 'Reprendre l’affichage'
                            : 'Figer l’affichage, la capture continue'
                        }
                        onClick={() => {
                          if (!paused) setSnapshot(packets);
                          setPaused((v) => !v);
                        }}
                      >
                        {paused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                      <button
                        className="icon-btn"
                        title="Exporter les paquets en JSON"
                        disabled={!packets.length}
                        onClick={() =>
                          download('docker-tracer-paquets.json', JSON.stringify(packets, null, 2))
                        }
                      >
                        <ArrowDownToLine size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="Effacer l’affichage des paquets"
                        onClick={() => {
                          setPackets([]);
                          setSnapshot([]);
                          setTotal(0);
                          setPacket(null);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="packet-table-scroll">
                      <table className="packet-table">
                        <thead>
                          <tr>
                            <th>Heure</th>
                            <th>Source</th>
                            <th>Destination</th>
                            <th>Type</th>
                            <th>Taille</th>
                            <th>Information</th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayed.map((p) => (
                            <tr
                              key={p.id}
                              tabIndex={0}
                              onClick={() => setPacket(p)}
                              onKeyDown={(e) => e.key === 'Enter' && setPacket(p)}
                            >
                              <td>
                                {new Date(p.time).toLocaleTimeString('fr-FR', { hour12: false })}
                                <span className="milliseconds">
                                  .{String(Math.floor(p.time % 1000)).padStart(3, '0')}
                                </span>
                              </td>
                              <td>
                                {topology.nodes.find((n) => n.id === p.sourceNode)?.data.label ||
                                  p.source}
                              </td>
                              <td>
                                {topology.nodes.find((n) => n.id === p.targetNode)?.data.label ||
                                  p.target}
                              </td>
                              <td>
                                <span
                                  className="protocol-tag"
                                  style={{ color: colors[p.protocol] || colors.OTHER }}
                                >
                                  {p.protocol}
                                </span>
                              </td>
                              <td>{p.bytes} B</td>
                              <td>{p.info}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!displayed.length && (
                        <div className="empty-traffic">
                          <span className="empty-wave">
                            <Activity size={27} strokeWidth={1.2} />
                          </span>
                          <div>
                            <strong>
                              {packets.length
                                ? 'Aucun paquet ne correspond au filtre'
                                : capture
                                  ? 'À l’écoute de ton réseau'
                                  : 'Observe ce qui circule'}
                            </strong>
                            <p>
                              {packets.length
                                ? 'Modifie le protocole ou ta recherche.'
                                : capture
                                  ? 'Lance un test ou génère du trafic dans tes conteneurs.'
                                  : 'Déploie le laboratoire, puis active la capture pour voir les vrais paquets.'}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : tab === 'deployments' ? (
                  <DeploymentHistory
                    runs={deploymentRuns}
                    onSelect={(r) => {
                      setDeploymentRun(r);
                      setModal('deployment-result');
                    }}
                  />
                ) : tab === 'tests' ? (
                  <ProbeHistory
                    results={testResults}
                    busy={busy}
                    onInspect={(r) => {
                      setTestResult(r);
                      setModal('test-result');
                    }}
                    onRepeat={runProbe}
                  />
                ) : (
                  <div className="journal">
                    {journal.length ? (
                      journal.map((j, i) => (
                        <div key={i} className={j.type === 'error' ? 'journal-error' : ''}>
                          <time>{new Date(j.time).toLocaleTimeString('fr-FR')}</time>
                          <span>
                            {j.message ||
                              (j.type === 'capture'
                                ? j.active
                                  ? 'Capture démarrée.'
                                  : 'Capture arrêtée.'
                                : 'Opération terminée.')}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="journal-empty">
                        Les opérations du laboratoire apparaîtront ici.
                      </div>
                    )}
                  </div>
                )}
                <div className="traffic-footer">
                  <span>
                    <i className={`tiny-dot ${capture ? 'green' : ''}`} />
                    {paused
                      ? 'Affichage figé · collecte maintenue'
                      : capture
                        ? 'Capture réelle · interfaces des conteneurs'
                        : 'Capture inactive'}
                  </span>
                  <label className="animation-speed">
                    Animation
                    <select
                      aria-label="Vitesse des enveloppes"
                      value={animationSpeed}
                      onChange={(e) => {
                        setBursts([]);
                        setAnimationSpeed(Number(e.target.value));
                      }}
                    >
                      <option value="0.25">× 0,25</option>
                      <option value="0.5">× 0,5</option>
                      <option value="1">× 1</option>
                      <option value="2">× 2</option>
                    </select>
                  </label>
                </div>
              </section>
            </div>
            {showInspector && current && (
              <aside
                className={`inspector${panelTab === 'console' ? ' inspector-terminal' : ''}`}
                role="dialog"
                aria-label={`Configuration de ${current.data.label}`}
              >
                <div className="aside-heading">
                  <span>
                    <Server size={13} /> {current.data.label} · Configuration
                  </span>
                  <button
                    className="icon-btn"
                    title="Fermer l’inspecteur"
                    onClick={() => setShowInspector(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {current ? (
                  <>
                    <div className="inspector-identity">
                      <span className="inspector-symbol">
                        {React.createElement(iconMap[current.data.icon] || Server, {
                          size: 26,
                          strokeWidth: 1.4,
                        })}
                      </span>
                      <h2>{current.data.label}</h2>
                      <span className={`badge ${live?.state === 'running' ? 'green-badge' : ''}`}>
                        {current.data.kind === 'network'
                          ? 'RÉSEAU BRIDGE'
                          : live?.state === 'running'
                            ? 'EN LIGNE'
                            : live
                              ? 'ARRÊTÉ'
                              : 'NON DÉPLOYÉ'}
                      </span>
                    </div>
                    <div className="panel-tabs">
                      <button
                        className={panelTab === 'config' ? 'active' : ''}
                        onClick={() => setPanelTab('config')}
                      >
                        Réglages
                      </button>
                      {current.data.kind === 'container' && (
                        <>
                          <button
                            className={panelTab === 'logs' ? 'active' : ''}
                            onClick={() => setPanelTab('logs')}
                          >
                            Logs
                          </button>
                          <button
                            className={panelTab === 'console' ? 'active' : ''}
                            onClick={() => {
                              setTerminalNode(current.id);
                              setPanelTab('console');
                            }}
                          >
                            Terminal
                          </button>
                        </>
                      )}
                    </div>
                    <div
                      className={`inspector-scroll${panelTab === 'console' ? ' inspector-console-scroll' : ''}`}
                    >
                      {panelTab === 'config' ? (
                        <>
                          {live && (
                            <>
                              <div className="metric-grid">
                                <div>
                                  <small>MÉMOIRE</small>
                                  <strong>
                                    {live.metrics ? formatBytes(live.metrics.memory) : 'N/D'}
                                  </strong>
                                </div>
                                <div>
                                  <small>CPU</small>
                                  <strong>
                                    {live.metrics ? `${live.metrics.cpu.toFixed(1)} %` : 'N/D'}
                                  </strong>
                                </div>
                              </div>
                              <div className="address-list">
                                {live.addresses.map((a) => (
                                  <code key={a}>{a}</code>
                                ))}
                              </div>
                              <div className="node-actions">
                                <button
                                  disabled={busy || !runtime.connected}
                                  title={
                                    live.state === 'running'
                                      ? 'Arrêter ce conteneur'
                                      : 'Démarrer ce conteneur'
                                  }
                                  onClick={() =>
                                    action(async () => {
                                      if (live.state === 'running')
                                        await legacyTerminal.current?.close();
                                      return api(`/nodes/${selected}/action`, {
                                        action: live.state === 'running' ? 'stop' : 'start',
                                      });
                                    })
                                  }
                                >
                                  {live.state === 'running' ? (
                                    <Square size={13} />
                                  ) : (
                                    <Play size={13} />
                                  )}
                                  {live.state === 'running' ? 'Arrêter' : 'Démarrer'}
                                </button>
                                <button
                                  disabled={busy || !runtime.connected}
                                  onClick={() =>
                                    action(async () => {
                                      await legacyTerminal.current?.close();
                                      return api(`/nodes/${selected}/action`, {
                                        action: 'restart',
                                      });
                                    })
                                  }
                                >
                                  <RefreshCw size={13} />
                                  Relancer
                                </button>
                              </div>
                            </>
                          )}
                          <DeviceSettings
                            key={current.id}
                            topology={topology}
                            node={current}
                            onTopologyChange={change}
                            filesAvailable={filesAvailable}
                            startupAvailable={startupAvailable}
                            bridgesAvailable={bridgesAvailable}
                            data={current.data}
                            onChange={updateData}
                            disabled={locked}
                          />
                          <NetworkConnections
                            topology={topology}
                            node={current}
                            onChange={change}
                            disabled={locked}
                          />
                          {!validation?.success && (
                            <p className="pdu-error" role="alert">
                              {[...new Set(validation?.error.issues.map((i) => i.message))]
                                .slice(0, 2)
                                .join(' ')}
                            </p>
                          )}
                          <button
                            className="outline-btn full"
                            disabled={locked || topology.nodes.length >= 32}
                            onClick={() => {
                              const id = `n-${crypto.randomUUID().slice(0, 8)}`;
                              change((t) => duplicateDevice(t, current.id, id));
                              setSelected(id);
                              notify(
                                'Copie créée avec des IP automatiques et sans ports publiés. Ses volumes sont indépendants.',
                              );
                            }}
                          >
                            <Plus size={13} />
                            Dupliquer cet équipement
                          </button>
                          {current.data.kind === 'container' && (
                            <button
                              className="outline-btn full"
                              onClick={() => {
                                setTemplateSeed(current.data);
                                setModal('templates');
                              }}
                            >
                              <Save size={13} />
                              Créer un modèle de cet équipement
                            </button>
                          )}
                          {locked ? (
                            <p className="lock-hint">
                              Attends la fin de l’opération pour modifier la configuration.
                            </p>
                          ) : (
                            <button
                              className="danger-text"
                              onClick={() => {
                                change((t) => ({
                                  ...t,
                                  nodes: t.nodes.filter((n) => n.id !== selected),
                                  edges: t.edges.filter(
                                    (e) => e.source !== selected && e.target !== selected,
                                  ),
                                }));
                                setSelected(null);
                              }}
                            >
                              <Trash2 size={14} />
                              Retirer du schéma
                            </button>
                          )}
                        </>
                      ) : panelTab === 'logs' ? (
                        <>
                          <p className="field-hint">Actualisation toutes les 3 secondes.</p>
                          <pre className="console-output">
                            {live ? logs : 'Déploie ce conteneur pour consulter ses logs.'}
                          </pre>
                        </>
                      ) : null}
                      {terminalNode === current.id && (
                        <div className="inspector-terminal-content" hidden={panelTab !== 'console'}>
                          {live?.id && live?.name ? (
                            <DockerTerminal
                              ref={legacyTerminal}
                              key={`${project.hostId}:${live.id}`}
                              container={{
                                ...live,
                                hostId: project.hostId || 'local',
                                image: current.data.image,
                              }}
                              active={
                                panelTab === 'console' &&
                                runtime.connected &&
                                !showInventory &&
                                !workbench
                              }
                            />
                          ) : (
                            <p className="field-hint">
                              Le terminal sera disponible lorsque ce conteneur sera déployé et
                              Docker connecté.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </aside>
            )}
          </main>
          <footer className="statusbar">
            <span>
              <span className="tiny-dot green" />
              Docker Tracer <span className="statusbar-muted">v0.12</span>
            </span>
            <span>
              {BROWSER_MODE
                ? dirty ? 'Modifications à enregistrer' : 'Projet en mémoire · exporter pour conserver'
                : busy
                ? 'Opération Docker en cours…'
                : dirty
                  ? 'Modifications à enregistrer'
                  : runtime.deployed
                    ? 'Laboratoire déployé'
                    : 'Prêt à construire'}
              <span className="statusbar-muted">
                {BROWSER_MODE ? 'Fichier et carte dans cet onglet' : runtime.connected ? `Docker ${runtime.version}` : 'Éditeur disponible hors ligne'}
              </span>
            </span>
          </footer>
          {toast && (
            <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
              {toast.error ? <WifiOff size={17} /> : <Check size={17} />}
              <span>{toast.message}</span>
              <button className="icon-btn" title="Fermer le message" onClick={() => setToast(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          {busy && (
            <div className="operation-indicator">
              <RefreshCw size={14} className="spin" />
              {journal.find((j) => j.message && j.time >= operationStarted.current)?.message ||
                'Opération en cours…'}
            </div>
          )}
          {(modal || packet) && (
            <div
              className="modal-backdrop"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setModal(null);
                  setPacket(null);
                }
              }}
            >
              <section
                className={`modal ${['export', 'templates', 'changes', 'volumes'].includes(modal) ? 'wide-modal' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label={packet ? 'Détail du paquet' : 'Options du laboratoire'}
              >
                <button
                  className="modal-close icon-btn"
                  title="Fermer"
                  onClick={() => {
                    setModal(null);
                    setPacket(null);
                  }}
                >
                  <X size={20} />
                </button>
                {packet ? (
                  <PacketInspector
                    packet={packet}
                    packets={paused ? snapshot : packets}
                    onSelect={setPacket}
                    onReplay={replayPacket}
                  />
                ) : modal === 'volumes' ? (
                  <Volumes
                    api={api}
                    project={projectInfo}
                    available={backupsAvailable}
                    dirty={dirty}
                    onRefreshState={loadState}
                    onRestored={(next) => {
                      baseline.current = next;
                      setTopology((previous) => withMeasurements(previous, next));
                      dirtyRef.current = false;
                      setDirty(false);
                      setSaved(true);
                      notify(
                        'Données restaurées dans un nouveau volume. L’ancien volume est conservé.',
                      );
                    }}
                  />
                ) : modal === 'changes' && changePlan ? (
                  <LabPreview
                    plan={changePlan}
                    busy={busy}
                    onRefresh={() => action(previewChanges)}
                    onMigrate={() =>
                      action(async () => {
                        const result = await api('/lab/apply', {
                          token: changePlan.migration.token,
                        });
                        baseline.current = result.topology;
                        const s = await loadState();
                        revision.current = s.project.revision;
                        setStale(false);
                        await previewChanges();
                        notify(
                          'Services mis à niveau. Vérifie maintenant les changements du bridge.',
                        );
                      })
                    }
                    onApply={() =>
                      action(async () => {
                        const result = await api('/lab/apply', { token: changePlan.token });
                        baseline.current = result.topology;
                        setTopology((previous) => withMeasurements(previous, result.topology));
                        setDirty(false);
                        setSaved(true);
                        setModal(null);
                        notify(
                          result.warnings.length
                            ? result.warnings.join(' ')
                            : 'Changements appliqués. Les autres services ont été conservés.',
                          !!result.warnings.length,
                        );
                      })
                    }
                  />
                ) : modal === 'deployment-result' && deploymentRun ? (
                  <DeploymentResult
                    run={deploymentRuns.find((r) => r.id === deploymentRun.id) || deploymentRun}
                  />
                ) : modal === 'templates' ? (
                  <EquipmentTemplates
                    models={customModels}
                    onSave={saveModel}
                    onDelete={deleteModel}
                    seed={templateSeed}
                  />
                ) : modal === 'test-result' && testResult ? (
                  <>
                    <span className="eyebrow">RÉSULTAT DU TEST</span>
                    <h2>
                      {testResult.protocol} · {testResult.sourceLabel} → {testResult.targetLabel}
                    </h2>
                    <p
                      className={`probe-result-summary ${testResult.exitCode === 0 ? '' : 'failed'}`}
                    >
                      {testResult.summary}
                    </p>
                    <p className="field-hint">
                      {new Date(testResult.startedAt).toLocaleTimeString('fr-FR')} ·{' '}
                      {((testResult.finishedAt - testResult.startedAt) / 1000).toFixed(2)} s · Code
                      de sortie {testResult.exitCode}
                    </p>
                    <pre className="probe-result-output">
                      {testResult.output || 'Aucune sortie texte.'}
                    </pre>
                    <button
                      className="outline-btn full"
                      onClick={() => {
                        setProbeDraft(testResult.options);
                        setModal('probe');
                      }}
                    >
                      Modifier ce test
                    </button>
                    <p className="field-hint">
                      Les échanges se consultent dans la liste des événements. Plusieurs
                      applications peuvent générer du trafic simultanément.
                    </p>
                  </>
                ) : modal === 'probe' ? (
                  <PacketComposer
                    containers={containers}
                    runtime={runtime}
                    busy={busy}
                    capture={capture}
                    initial={
                      probeDraft || {
                        source: probeSource,
                        target: probeTarget,
                        protocol: probeProtocol,
                      }
                    }
                    onRun={runProbe}
                  />
                ) : modal === 'remove' ? (
                  <>
                    <span className="eyebrow">MODIFIER LE LABORATOIRE</span>
                    <h2>Libérer le déploiement</h2>
                    <p>
                      Les conteneurs et les réseaux de <strong>{topology.name}</strong> seront
                      supprimés. Le schéma et les volumes persistants seront conservés.
                    </p>
                    <p>Tu pourras modifier le réseau puis le déployer à nouveau.</p>
                    <button
                      className="deploy-button full"
                      disabled={busy}
                      onClick={() => {
                        setModal(null);
                        action(() => api('/lab/action', { action: 'remove' }));
                      }}
                    >
                      <Layers size={16} />
                      Libérer les ressources du labo
                    </button>
                  </>
                ) : modal === 'export' ? (
                  <>
                    <span className="eyebrow">EMPORTER TON RÉSEAU</span>
                    <h2>Du schéma à Docker.</h2>
                    <p>
                      La topologie JSON conserve le placement des équipements. Le fichier Compose
                      déploie leurs services et réseaux sans l’interface de capture. Les fichiers
                      applicatifs sont inclus comme configurations Compose (version 2.23.1+),
                      montées en lecture seule. Les contrôles de démarrage sont conservés en
                      annotations ; Compose ne les exécute pas et ne restaure pas une ancienne
                      version comme Docker Tracer.
                    </p>
                    <pre className="compose-preview">
                      {validation?.success
                        ? YAML.stringify(composeObject(topology))
                        : 'Corrige les réglages invalides avant l’export : ' +
                          validation?.error.issues.map((i) => i.message).join(' ')}
                    </pre>
                    <div className="modal-actions">
                      <button
                        className="outline-btn"
                        onClick={() =>
                          download('topologie.json', JSON.stringify(topology, null, 2))
                        }
                      >
                        <Braces size={16} />
                        Topologie JSON
                      </button>
                      <button
                        className="deploy-button"
                        onClick={() =>
                          validation?.success &&
                          download(
                            'compose.yaml',
                            YAML.stringify(composeObject(topology)),
                            'text/yaml',
                          )
                        }
                      >
                        <Download size={16} />
                        Docker Compose
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="eyebrow">BIENVENUE DANS L’ATELIER</span>
                    <h2>Dessine. Déploie. Observe.</h2>
                    <div className="help-steps">
                      {[
                        [
                          '01',
                          'Construis ton schéma',
                          'Glisse des conteneurs et des réseaux depuis la bibliothèque. Relie leurs points de connexion. Un réseau bridge relie tous ses conteneurs.',
                        ],
                        [
                          '02',
                          'Lance de vrais services',
                          'Clique sur un équipement pour régler les images, commandes et ports. Déploie le labo. Docker doit être démarré en mode Linux.',
                        ],
                        [
                          '03',
                          'Regarde les échanges',
                          'Active la capture, puis « Envoyer un test ». Clique sur un paquet pour l’inspecter. Les enveloppes animées représentent des observations réelles, ralenties pour être lisibles.',
                        ],
                      ].map(([n, title, body]) => (
                        <div key={n}>
                          <span>{n}</span>
                          <div>
                            <h3>{title}</h3>
                            <p>{body}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="help-note">
                      Cette version gère plusieurs projets avec réseaux bridge, sur Docker local ou
                      un serveur Linux SSH. Les routeurs, VLAN, pare-feu et la simulation pas à pas
                      ne sont pas encore inclus. Figer l’affichage ne suspend pas le trafic réel.
                    </p>
                    <button className="deploy-button full" onClick={() => setModal(null)}>
                      Ouvrir l’atelier
                      <ChevronRight size={16} />
                    </button>
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </LiveContext.Provider>
  );
}
function WorkspaceApp() {
  const [selected, setSelected] = useState(null),
    [error, setError] = useState(''),
    [initialSelection, setInitialSelection] = useState(null),
    [initialSection, setInitialSection] = useState('image'),
    [initialInventory, setInitialInventory] = useState(!BROWSER_MODE),
    [initialImportPreview, setInitialImportPreview] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [workspaceStatus, setWorkspaceStatus] = useState({ dirty: false, busy: false });
  const load = useCallback(async () => {
    try {
      const data = await projectRequest('/projects');
      let preferred;
      if (!BROWSER_MODE) {
        try {
          preferred = localStorage.getItem('docker-tracer-project');
        } catch {}
      }
      setSelected(
        data.projects.find((p) => p.id === preferred && !p.archivedAt) ||
          data.projects.find((p) => p.id === data.defaultId),
      );
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const open = (p, nodeId = null, section = 'image', options = {}) => {
    if (!BROWSER_MODE) {
      try {
        localStorage.setItem('docker-tracer-project', p.id);
      } catch {}
    }
    setInitialInventory(false);
    setInitialSelection(nodeId);
    setInitialSection(section);
    setInitialImportPreview(options.previewImport === true);
    setWorkspaceStatus({ dirty: false, busy: false });
    setSelected(p);
  };
  if (!selected)
    return (
      <div className="loading">
        <Network size={38} />
        <h2>Docker Tracer</h2>
        <p>{error || 'Ouverture des projets…'}</p>
        {error && <button onClick={load}>Réessayer</button>}
      </div>
    );
  return (
    <>
      <ComposeDropImport
        openRequest={importOpen}
        defaultHostId={selected.hostId || 'local'}
        blocked={
          workspaceStatus.busy
            ? 'Attends la fin de l’opération en cours.'
            : workspaceStatus.dirty
              ? 'Enregistre le projet ouvert avant d’en importer un autre.'
              : ''
        }
        onImported={(project, options) => open(project, null, 'image', options)}
        onClose={() => setImportOpen(false)}
      />
      <ReactFlowProvider key={selected.id}>
        {selected.kind === 'compose' ? (
          <ComposeWorkspace
            project={selected}
            onOpenProject={open}
            initialSelection={initialSelection}
            initialSection={initialSection}
            initialInventory={initialInventory}
            initialImportPreview={initialImportPreview}
            onImportCompose={() => setImportOpen(true)}
            onWorkspaceStatus={setWorkspaceStatus}
          />
        ) : (
          <App
            project={selected}
            onOpenProject={open}
            initialInventory={initialInventory}
            initialSelection={initialSelection}
            onImportCompose={() => setImportOpen(true)}
            onWorkspaceStatus={setWorkspaceStatus}
          />
        )}
      </ReactFlowProvider>
    </>
  );
}
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WorkspaceApp />
  </React.StrictMode>,
);
