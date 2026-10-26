import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  BaseEdge,
  getStraightPath,
  useReactFlow,
  applyNodeChanges,
} from '@xyflow/react';
import {
  ArrowLeft,
  Terminal,
  FolderOpen,
  FileText,
  SlidersHorizontal,
  Activity,
  Network,
  RefreshCw,
  Search,
  Scan,
  ZoomIn,
  ZoomOut,
  X,
  Focus,
  Download,
  AlertTriangle,
  Server,
  Layers,
  Plus,
  Cpu,
} from 'lucide-react';
import EquipmentIcon from './EquipmentIcon.jsx';
import { inventoryView, layoutInventory } from '../shared/inventory.mjs';
import { reconcileFlowNodes } from '../shared/flow-nodes.mjs';
import { findEditableProject } from '../shared/inventory-editing.mjs';
import { capturesForContainer } from '../shared/inventory-observations.mjs';
import {
  advanceObservationActivity,
  captureCoversTargets,
  captureObservationSummary,
  captureSelection,
  groupedInventoryObservations,
  observationLanes,
  observationEdgePath,
} from '../shared/inventory-live.mjs';
import {
  CapturePlan,
  ObservationStatus,
  ObservedEnvelope,
  ObservedFlowDetails,
} from './InventoryFlows.jsx';
import ContainerWorkbench from './ContainerWorkbench.jsx';
import './inventory.css';
import {
  WorkspaceModal,
  HostManager,
  CheckEditor,
  DiagnosticsPanel,
  RunDetails,
  CaptureDetails,
  ContainerActions,
  workspaceApi,
  toRef,
} from './WorkspacePanels.jsx';
import { PacketInspector } from './Packets.jsx';
import { resultLabels, currentResourceKey } from '../shared/workspace.mjs';

const states = {
  running: 'En marche',
  exited: 'Arrêté',
  created: 'Créé',
  paused: 'En pause',
  restarting: 'Redémarrage',
  dead: 'En erreur',
  removing: 'Suppression',
};
const formatBytes = (n) =>
  n == null
    ? 'N/D'
    : n >= 1073741824
      ? `${(n / 1073741824).toFixed(1)} Go`
      : n >= 1048576
        ? `${(n / 1048576).toFixed(1)} Mo`
        : n >= 1024
          ? `${(n / 1024).toFixed(1)} Ko`
          : `${n} o`;
const networkType = (n) =>
  n.driver === 'host'
    ? 'Réseau hôte'
    : n.driver === 'null'
      ? 'Sans réseau'
      : n.driver === 'unknown'
        ? 'Réseau à confirmer'
        : `${n.driver} Docker`;
const portText = (p) =>
  p.host
    ? `${p.hostIp || '*'}:${p.host} → ${p.container}/${p.protocol}`
    : `${p.container}/${p.protocol} (non publié)`;
const iconFor = (c) =>
  /redis|postgres|mysql|maria|mongo/i.test(c.image)
    ? 'database'
    : /nginx|httpd|wordpress|webui/i.test(c.image)
      ? 'globe'
      : /alpine|ubuntu|debian/i.test(c.image)
        ? 'terminal'
        : 'server';
async function read(path, signal) {
  const response = await fetch(path, { signal });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Impossible de lire Docker.');
  return result;
}
const InventoryNode = memo(function InventoryNode({ data, selected }) {
  const c = data.container,
    n = data.network;
  return (
    <div
      className={`device inventory-device ${selected ? 'selected' : ''} ${c?.attention ? 'needs-attention' : ''} ${c?.stale ? 'is-stale' : ''}`}
      title={
        c
          ? `${c.name}\n${c.image}\n${states[c.state] || c.state}${c.health ? ` · ${c.health}` : ''}`
          : `${n.name}\n${networkType(n)}`
      }
    >
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <div className="device-picture">
        <EquipmentIcon kind={n ? 'network' : iconFor(c)} image={c?.image} />
        <span
          className={`device-led ${data.online ? (n || c.state === 'running' ? 'live' : 'stopped') : ''}`}
        />
        {c?.attention && <AlertTriangle size={12} className="node-alert" />}
      </div>
      <div className="device-type">
        {n ? networkType(n) : c.isProbe ? 'Sonde de capture' : states[c.state] || c.state}
      </div>
      <div className="device-name">{n ? n.name : c.service || c.name}</div>
      <div className="device-detail">
        {n
          ? n.subnets.join(' · ')
          : c.attachments
              .map((a) => a.ip || a.ipv6)
              .filter(Boolean)
              .join(' / ') ||
            (c.networkMode === 'none'
              ? 'Sans réseau'
              : c.networkMode === 'host'
                ? 'Réseau de l’hôte'
                : c.networkMode.startsWith('container:')
                  ? 'Réseau partagé'
                  : '')}
      </div>
    </div>
  );
});
const InventoryEdge = memo(function InventoryEdge(props) {
  const shared = props.data?.kind === 'shared';
  const expected = props.data?.kind === 'expected',
    observed = props.data?.kind === 'observed';
  const [path, labelX, labelY] = observed
    ? observationEdgePath(props, props.data.lane)
    : getStraightPath(props);
  const live = props.data?.live;
  const burst = props.data?.burst;
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: expected
            ? '#407db8'
            : observed
              ? burst
                ? '#408647'
                : '#7a917e'
              : props.selected
                ? '#217bb6'
                : shared
                  ? '#8a7ea0'
                  : '#596368',
          strokeWidth: observed ? 2 : 1.2,
          strokeDasharray: expected ? '7 5' : shared || (observed && !live) ? '4 3' : undefined,
        }}
      />
      {observed && (
        <ObservedEnvelope
          path={path}
          x={labelX}
          y={labelY}
          flow={props.data.flow}
          burst={burst}
          replay={props.data.replay}
          direction={
            Math.abs(props.targetX - props.sourceX) >= Math.abs(props.targetY - props.sourceY)
              ? props.targetX >= props.sourceX
                ? '→'
                : '←'
              : props.targetY >= props.sourceY
                ? '↓'
                : '↑'
          }
          onInspect={props.data.onInspect}
        />
      )}
    </>
  );
});
const nodeTypes = { inventory: InventoryNode },
  edgeTypes = { inventory: InventoryEdge };

function InventoryCanvas({
  onClose,
  onOpenLab,
  onOpenProject,
  currentLab,
  currentHost,
  onProjects,
  onAddContainer,
  projectsOpen,
}) {
  const [modal, setModal] = useState(null),
    [listTab, setListTab] = useState('equipment'),
    [operationError, setOperationError] = useState(''),
    [showExpected, setShowExpected] = useState(true),
    [showObserved, setShowObserved] = useState(true),
    [hostFilter, setHostFilter] = useState('all'),
    [replay, setReplay] = useState(null),
    [recheck, setRecheck] = useState([]),
    [contextMenu, setContextMenu] = useState(null),
    [workbench, setWorkbench] = useState(null),
    [capturePending, setCapturePending] = useState(null),
    [captureStopping, setCaptureStopping] = useState(null),
    [eventStream, setEventStream] = useState('connecting');
  const [snapshot, setSnapshot] = useState(null),
    [managedProjects, setManagedProjects] = useState([]),
    [flowNodes, setFlowNodes] = useState([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(''),
    [project, setProject] = useState('all'),
    [state, setState] = useState('all'),
    [showProbes, setShowProbes] = useState(false),
    [showUnused, setShowUnused] = useState(false),
    [focus, setFocus] = useState(null);
  const [selected, setSelected] = useState(null),
    [panel, setPanel] = useState(false),
    [details, setDetails] = useState(null),
    [detailsError, setDetailsError] = useState(''),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(0);
  const [observationActivity, setObservationActivity] = useState({ seen: new Map(), bursts: [] });
  const flow = useReactFlow(),
    positions = useRef(new Map()),
    controller = useRef(null),
    firstFit = useRef(false),
    menuRef = useRef(null),
    menuOrigin = useRef(null);
  useEffect(() => {
    if (projectsOpen) return;
    const ac = new AbortController();
    read('/api/projects', ac.signal)
      .then((result) => {
        if (!ac.signal.aborted) setManagedProjects(result.projects || []);
      })
      .catch(() => {
        if (!ac.signal.aborted) setManagedProjects([]);
      });
    return () => ac.abort();
  }, [projectsOpen]);
  const refresh = useCallback(async () => {
    if (controller.current) return;
    const ac = new AbortController();
    controller.current = ac;
    setLoading(true);
    const timeout = setTimeout(() => ac.abort(), 15000);
    try {
      const result = await read('/api/workspace/inventory', ac.signal);
      if (!ac.signal.aborted) {
        setSnapshot(result);
        setError('');
      }
    } catch (e) {
      if (controller.current === ac) {
        if (!ac.signal.aborted) setError(e.message);
        else setError('Docker met trop de temps à répondre. Réessaie.');
      }
    } finally {
      clearTimeout(timeout);
      if (controller.current === ac) {
        controller.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setEventStream('connected');
    es.onerror = () => setEventStream('reconnecting');
    es.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === 'diagnostic')
        setSnapshot((s) =>
          s
            ? {
                ...s,
                runs: [event.run, ...(s.runs || []).filter((r) => r.id !== event.runId)].slice(
                  0,
                  100,
                ),
              }
            : s,
        );
      if (event.type === 'workspace-capture')
        setSnapshot((s) =>
          s
            ? {
                ...s,
                captures: (s.captures || []).map((c) =>
                  c.id === event.captureId
                    ? {
                        ...c,
                        flows: event.flows || c.flows,
                        count: event.count,
                        status: event.status || c.status,
                      }
                    : c,
                ),
              }
            : s,
        );
    };
    return () => es.close();
  }, []);
  const visibleSnapshot = useMemo(
    () =>
      !snapshot || hostFilter === 'all'
        ? snapshot
        : {
            ...snapshot,
            containers: snapshot.containers.filter((c) => c.hostId === hostFilter),
            networks: snapshot.networks.filter((n) => n.hostId === hostFilter),
            links: snapshot.links.filter((l) => l.source.startsWith(`c:${hostFilter}:`)),
          },
    [snapshot, hostFilter],
  );
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
      controller.current = null;
    };
  }, [refresh]);
  const view = useMemo(
    () =>
      inventoryView(visibleSnapshot, {
        search: query,
        project,
        state,
        showProbes,
        showUnused,
        focus,
      }),
    [visibleSnapshot, query, project, state, showProbes, showUnused, focus],
  );
  const signature =
    view.containers.map((c) => c.id).join() +
    ':' +
    view.networks.map((n) => n.id).join() +
    ':' +
    view.links.map((l) => l.id).join();
  const layout = useMemo(() => layoutInventory(view), [signature]);
  const observations = useMemo(
    () => groupedInventoryObservations(snapshot?.captures),
    [snapshot?.captures],
  );
  const observationSummary = useMemo(
    () =>
      captureObservationSummary(
        snapshot?.captures,
        view.containers.map((c) => c.id),
      ),
    [snapshot?.captures, view.containers],
  );
  useEffect(() => {
    setObservationActivity((previous) =>
      advanceObservationActivity(previous, observations, Date.now(), eventStream === 'connected'),
    );
  }, [observations, eventStream]);
  useEffect(() => {
    if (!observationActivity.bursts.length) return;
    const expiresAt = Math.min(...observationActivity.bursts.map((burst) => burst.expiresAt));
    const timer = setTimeout(
      () =>
        setObservationActivity((previous) => ({
          ...previous,
          bursts: previous.bursts.filter((burst) => burst.expiresAt > Date.now()),
        })),
      Math.max(1, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [observationActivity.bursts]);
  const graph = useMemo(() => {
    const nodes = [
      ...view.networks.map((n) => ({
        id: `n:${n.id}`,
        ariaLabel: n.name,
        data: { network: n, online: !error && !n.stale },
      })),
      ...view.containers.map((c) => ({
        id: `c:${c.id}`,
        ariaLabel: c.name,
        data: { container: c, online: !error && !c.stale },
      })),
    ].map((n) => ({
      ...n,
      type: 'inventory',
      position: positions.current.get(n.id) || layout.get(n.id),
      selected: n.id === selected,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = view.links.map((l) => {
      const above = byId.get(l.source).position.y > byId.get(l.target).position.y;
      return {
        ...l,
        type: 'inventory',
        sourceHandle: above ? 'top' : 'bottom',
        targetHandle: above ? 'bottom' : 'top',
        data: { kind: l.kind },
        ariaLabel: l.kind === 'shared' ? 'Espace réseau partagé' : 'Appartenance au réseau Docker',
      };
    });
    if (showExpected)
      for (const c of snapshot?.checks || []) {
        const source = `c:${currentResourceKey(c.source, snapshot)}`,
          target = `c:${currentResourceKey(c.target, snapshot)}`;
        if (byId.has(source) && byId.has(target))
          edges.push({
            id: `expected:${c.id}`,
            source,
            target,
            type: 'inventory',
            data: { kind: 'expected', check: c },
            ariaLabel: `Connexion attendue : ${c.name}`,
            sourceHandle: 'bottom',
            targetHandle: 'top',
          });
      }
    if (showObserved) {
      const flows = new Map(observations.map((f) => [f.key, f]));
      if (replay) {
        const existing = [...flows.values()].find(
          (f) =>
            f.source === replay.sourceNode &&
            f.target === replay.targetNode &&
            f.packet?.protocol === replay.protocol,
        );
        const key = existing?.key || `replay:${replay.id}`;
        flows.set(key, {
          ...existing,
          key,
          source: replay.sourceNode,
          target: replay.targetNode,
          packet: replay,
          count: 1,
          replay: replay.replayAt,
        });
      }
      const lanes = observationLanes([...flows.values()]);
      for (const f of [...flows.values()]
        .sort((a, b) => (a.lastAt || Infinity) - (b.lastAt || Infinity))
        .slice(-150)) {
        const source = `c:${f.source}`,
          target = `c:${f.target}`;
        if (byId.has(source) && byId.has(target))
          edges.push({
            id: `observed:${f.key}`,
            source,
            target,
            type: 'inventory',
            sourceHandle: 'bottom',
            targetHandle: 'top',
            data: {
              kind: 'observed',
              packet: f.packet,
              flow: f,
              lane: lanes.get(f.key),
              count: f.count,
              burst: observationActivity.bursts.find((burst) => burst.key === f.key),
              replay: f.replay,
              live: f.live && eventStream === 'connected',
              onInspect: (flow) => setModal({ type: 'flow', data: flow }),
            },
            ariaLabel: `Échange observé : ${f.packet?.protocol}`,
          });
      }
    }
    return { nodes, edges };
  }, [
    view,
    selected,
    error,
    revision,
    layout,
    snapshot?.checks,
    snapshot?.captures,
    showExpected,
    showObserved,
    replay,
    eventStream,
    observations,
    observationActivity.bursts,
  ]);
  useEffect(() => {
    setFlowNodes((previous) => reconcileFlowNodes(previous, graph.nodes));
  }, [graph.nodes]);
  useEffect(() => {
    if (!snapshot) return;
    const timer = setTimeout(() => {
      flow.fitView({ padding: 0.22, maxZoom: 1, duration: firstFit.current ? 200 : 0 });
      firstFit.current = true;
    }, 80);
    return () => clearTimeout(timer);
  }, [signature]);
  useEffect(() => {
    setPage(0);
  }, [query, project, state, showProbes, focus]);
  const currentContainer = snapshot?.containers.find((c) => `c:${c.id}` === selected);
  const currentNetwork = snapshot?.networks.find((n) => `n:${n.id}` === selected);
  const editable = findEditableProject(currentContainer, managedProjects);
  const canOpenCurrentLab =
    currentContainer &&
    !currentContainer.isProbe &&
    currentContainer.labId === currentLab &&
    currentContainer.hostId === currentHost &&
    onOpenLab;
  const selectedCaptures = capturesForContainer(snapshot?.captures, currentContainer);
  const activeSelectedCapture = selectedCaptures.find((c) => c.status === 'running');
  const menuContainer = contextMenu && snapshot?.containers.find((c) => c.id === contextMenu.id);
  const liveWorkbenchContainer =
    workbench &&
    snapshot?.containers.find(
      (c) =>
        (c.hostId || 'local') === (workbench.container.hostId || 'local') &&
        (c.dockerId || c.id) === (workbench.container.dockerId || workbench.container.id),
    );
  const workbenchContainer = workbench
    ? liveWorkbenchContainer || { ...workbench.container, state: 'unknown', stale: true }
    : null;
  const defaultAddHost =
    hostFilter !== 'all' ? hostFilter : currentContainer?.hostId || currentHost || 'local';
  const openWorkbench = (container, tab) => {
    setContextMenu(null);
    setWorkbench({ container: { ...container, id: container.dockerId || container.id }, tab });
  };
  const editConfiguration = (container, tab = 'configuration') => {
    const mapping = findEditableProject(container, managedProjects);
    setContextMenu(null);
    setWorkbench(null);
    if (mapping && onOpenProject) onOpenProject(mapping.project, mapping.nodeId, tab);
    else if (container.labId === currentLab && container.hostId === currentHost && onOpenLab)
      onOpenLab(container.service, tab);
    else onProjects('import');
  };
  const openContextMenu = (event, container, keyboard = false) => {
    event.preventDefault();
    event.stopPropagation();
    menuOrigin.current = event.target.closest?.('[data-id], tr') || document.activeElement;
    const rect = menuOrigin.current?.getBoundingClientRect();
    const x = keyboard ? (rect?.left || 20) + 30 : event.clientX;
    const y = keyboard ? (rect?.top || 20) + 30 : event.clientY;
    setSelected(`c:${container.id}`);
    setContextMenu({
      id: container.id,
      x: Math.max(8, Math.min(x, window.innerWidth - 286)),
      y: Math.max(8, Math.min(y, window.innerHeight - 390)),
    });
  };
  useEffect(() => {
    if (!contextMenu) return;
    menuRef.current?.querySelector('button:not(:disabled)')?.focus();
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target)) setContextMenu(null);
    };
    const dismiss = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setContextMenu(null);
      menuOrigin.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', dismiss, true);
    };
  }, [contextMenu]);
  useEffect(() => {
    setDetails(null);
    setDetailsError('');
    if (!panel || !currentContainer) return;
    let active = true,
      pending = false;
    const ac = new AbortController();
    const update = async () => {
      if (pending || !active) return;
      pending = true;
      try {
        const d = await read(
          `/api/hosts/${currentContainer.hostId}/containers/${currentContainer.dockerId}`,
          ac.signal,
        );
        if (active) {
          setDetails(d);
          setDetailsError('');
        }
      } catch (e) {
        if (active) setDetailsError(e.message);
      } finally {
        pending = false;
      }
    };
    update();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') update();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      ac.abort();
    };
  }, [currentContainer?.id, panel]);
  const projects = useMemo(
    () =>
      [
        ...new Map(
          (snapshot?.containers || [])
            .filter((c) => !c.isProbe)
            .map((c) => [c.projectKey, c.project]),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1])),
    [snapshot],
  );
  useEffect(() => {
    const escape = (e) => {
      if (e.key === 'Escape') {
        if (contextMenu || modal || workbench) return;
        if (panel) setPanel(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [panel, onClose, contextMenu, modal, workbench]);
  const all = snapshot?.containers.filter((c) => !c.isProbe) || [],
    attention = all.filter((c) => c.attention).length;
  const choose = (id, open = false) => {
    setSelected(id);
    setPanel(open);
    const n = graph.nodes.find((n) => n.id === id);
    if (n)
      flow.setCenter(n.position.x + 47, n.position.y + 45, {
        zoom: Math.max(0.8, flow.getZoom()),
        duration: 200,
      });
  };
  const reset = () => {
    setQuery('');
    setProject('all');
    setState('all');
    setFocus(null);
    setHostFilter('all');
  };
  const runCheck = async (c) => {
    setOperationError('');
    try {
      const run = await workspaceApi(`/api/hosts/${c.source.hostId}/diagnostics`, {
        checkId: c.id,
        capture: true,
      });
      setModal({ type: 'run', data: run });
      setListTab('checks');
      refresh();
    } catch (e) {
      setOperationError(e.message);
    }
  };
  const openCapturePlan = (containers = [], networkId) => {
    setContextMenu(null);
    setOperationError('');
    const fallback =
      currentContainer ||
      view.containers.find((c) => !c.isProbe && !c.stale && c.state === 'running');
    setModal({
      type: 'capture-plan',
      data: {
        ids: (containers.length ? containers : fallback ? [fallback] : []).map((c) => c.id),
        networkId,
      },
    });
  };
  const startCapture = async (input) => {
    if (capturePending) return;
    const selection = captureSelection(
      snapshot?.containers,
      (Array.isArray(input) ? input : [input]).map((c) => c.id),
    );
    if (selection.error) {
      setOperationError(selection.error);
      return;
    }
    const targets = selection.targets;
    const c = targets[0];
    const existing = (snapshot?.captures || []).find((capture) =>
      captureCoversTargets(capture, targets),
    );
    if (existing) {
      setModal({ type: 'capture', data: existing.id });
      return;
    }
    setContextMenu(null);
    setOperationError('');
    setCapturePending(c.id);
    try {
      const cap = await workspaceApi(`/api/hosts/${c.hostId}/captures`, {
        targets: targets.map(toRef),
        duration: 30,
      });
      setSnapshot((s) =>
        s
          ? {
              ...s,
              captures: [cap, ...(s.captures || []).filter((capture) => capture.id !== cap.id)],
            }
          : s,
      );
      setShowObserved(true);
      setModal(null);
      setPanel(false);
      setListTab('captures');
      refresh();
    } catch (e) {
      setOperationError(e.message);
    } finally {
      setCapturePending(null);
    }
  };
  const stopCapture = async (capture) => {
    setCaptureStopping(capture.id);
    try {
      const ended = await workspaceApi(`/api/captures/${capture.id}/stop`, {});
      setSnapshot((s) =>
        s ? { ...s, captures: (s.captures || []).map((c) => (c.id === ended.id ? ended : c)) } : s,
      );
      refresh();
    } catch (e) {
      setOperationError(e.message);
    } finally {
      setCaptureStopping(null);
    }
  };
  const replayPacket = (p) => {
    setModal(null);
    setShowObserved(true);
    setQuery('');
    setProject('all');
    setState('all');
    setHostFilter('all');
    setFocus(`c:${p.sourceNode}`);
    setSelected(`c:${p.sourceNode}`);
    setReplay({ ...p, replayAt: Date.now() });
  };
  useEffect(() => {
    if (!replay) return;
    const timer = setTimeout(() => setReplay(null), 1800);
    return () => clearTimeout(timer);
  }, [replay]);
  const exportInventory = () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventaire-docker.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const pages = Math.max(1, Math.ceil(view.containers.length / 50)),
    currentPage = Math.min(page, pages - 1);
  return (
    <section className="inventory-screen" aria-label="Tout Docker" inert={!!projectsOpen}>
      <header className="desktop-header">
        <div className="window-title">
          <Network size={15} />
          <strong>Docker Tracer</strong>
          <span>· Tout Docker</span>
          <span className="local-label">
            {snapshot?.engine.name || 'Moteur local'} · Découverte automatique
          </span>
        </div>
        <div className="inventory-toolbar">
          <button
            className="create-infrastructure-button"
            disabled={!onAddContainer}
            onClick={() => onAddContainer(defaultAddHost)}
          >
            <Plus size={16} />
            Ajouter un conteneur
          </button>
          <button onClick={() => onProjects()}>Mes infrastructures</button>
          <button onClick={() => onProjects('import')}>
            <FolderOpen size={14} /> Importer un Compose
          </button>
          <button onClick={onClose}>
            <ArrowLeft size={14} />
            Éditeur du projet
          </button>
          <span className="tool-separator" />
          <button disabled={loading} onClick={refresh}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Lecture…' : 'Actualiser'}
          </button>
          <button
            className="tool-button"
            title="Centrer tout le réseau"
            onClick={() => flow.fitView({ padding: 0.22, maxZoom: 1, duration: 200 })}
          >
            <Scan />
          </button>
          <button className="tool-button" title="Zoom avant" onClick={() => flow.zoomIn()}>
            <ZoomIn />
          </button>
          <button className="tool-button" title="Zoom arrière" onClick={() => flow.zoomOut()}>
            <ZoomOut />
          </button>
          <button
            title="Recalculer la disposition automatique"
            onClick={() => {
              positions.current.clear();
              setRevision((n) => n + 1);
              setTimeout(() => flow.fitView({ padding: 0.22, maxZoom: 1, duration: 200 }), 60);
            }}
          >
            Réorganiser
          </button>
          <span className="toolbar-spacer" />
          <button onClick={() => setModal({ type: 'hosts' })}>
            <Server size={13} /> Mes serveurs
          </button>
          <button
            disabled={!snapshot || all.length < 2}
            onClick={() => setModal({ type: 'check' })}
          >
            Nouveau contrôle
          </button>
          <button disabled={!snapshot} onClick={exportInventory}>
            <Download size={13} />
            Exporter l’inventaire
          </button>
        </div>
        <div className="inventory-filters">
          <select
            aria-label="Filtrer par serveur"
            value={hostFilter}
            onChange={(e) => {
              setHostFilter(e.target.value);
              setProject('all');
            }}
          >
            <option value="all">Tous les serveurs</option>
            {snapshot?.hosts?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <div className="inventory-search">
            <Search size={14} />
            <input
              aria-label="Rechercher dans tout Docker"
              placeholder="Nom, image, IP, réseau…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-btn"
                title="Effacer la recherche"
                onClick={() => setQuery('')}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <select
            aria-label="Filtrer par projet"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="all">Tous les projets ({projects.length})</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrer par état"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="all">Tous les états</option>
            <option value="running">En marche</option>
            <option value="stopped">Hors marche</option>
            <option value="attention">À examiner ({attention})</option>
          </select>
          <button
            disabled={!selected && !focus}
            className={focus ? 'active' : ''}
            onClick={() => {
              setFocus(focus ? null : selected);
              if (!focus) {
                setQuery('');
                setProject('all');
                setState('all');
              }
            }}
          >
            <Focus size={13} />
            {focus ? 'Quitter le focus' : 'Voir le voisinage'}
          </button>
          {(query || project !== 'all' || state !== 'all' || focus) && (
            <button onClick={reset}>Tout afficher</button>
          )}
        </div>
      </header>
      <div className="workspace-strip inventory-summary">
        <span className="logical-tab">
          <Network size={14} />
          Tout Docker
        </span>
        <span>
          {all.length} conteneurs · {all.filter((c) => c.state === 'running').length} en marche ·{' '}
          {snapshot?.networks.length || 0} réseaux
        </span>
        <span className="toolbar-spacer" />
        {attention > 0 && (
          <button onClick={() => setState('attention')}>
            <AlertTriangle size={12} />
            {attention} à examiner
          </button>
        )}
        <span>
          {error
            ? 'Connexion perdue'
            : loading && !snapshot
              ? 'Découverte…'
              : 'État des machines · toutes les 5 s'}
        </span>
      </div>
      {error && (
        <div className="connection-banner">
          <AlertTriangle size={14} />
          {error}
          {snapshot && ' La carte montre le dernier état connu.'}
        </div>
      )}
      {operationError && (
        <div className="connection-banner" role="alert">
          {operationError}
          <button onClick={() => setOperationError('')}>Fermer</button>
        </div>
      )}
      {snapshot?.hosts?.some((h) => h.connection.state !== 'connected') && (
        <div className="connection-banner">
          <AlertTriangle size={14} />
          {snapshot.hosts
            .filter((h) => h.connection.state !== 'connected')
            .map((h) => h.name)
            .join(', ')}{' '}
          : connexion indisponible ou identité à vérifier. Les équipements déjà connus restent
          affichés comme périmés.
          <button onClick={() => setModal({ type: 'hosts' })}>Vérifier les serveurs</button>
        </div>
      )}
      <ObservationStatus
        summary={observationSummary}
        connected={eventStream === 'connected'}
        pending={!!capturePending}
        stopping={captureStopping}
        showObserved={showObserved}
        onShow={() => setShowObserved(true)}
        onStart={() => openCapturePlan()}
        onInspect={(id) => setModal({ type: 'capture', data: id })}
        onStop={stopCapture}
      />
      <div
        className="inventory-canvas with-host-tree"
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          const nodeId = event.target.closest?.('.react-flow__node')?.getAttribute('data-id');
          const container = snapshot?.containers.find((c) => `c:${c.id}` === nodeId);
          if (container && !container.isProbe) openContextMenu(event, container, true);
        }}
      >
        <nav className="host-tree" aria-label="Serveurs et projets">
          {snapshot?.hosts?.map((h) => (
            <details open key={h.id}>
              <summary>
                {h.name}
                <span className={`host-state ${h.connection.state}`}>
                  {
                    {
                      connected: 'Connecté',
                      offline: 'Inaccessible',
                      untrusted: 'Identité à vérifier',
                      'changed-key': 'Clé SSH modifiée',
                      unknown: 'Non testé',
                    }[h.connection.state]
                  }
                </span>
              </summary>
              {onAddContainer && (
                <button className="host-add-container" onClick={() => onAddContainer(h.id)}>
                  <Plus size={13} /> Ajouter un conteneur
                </button>
              )}
              {projects
                .filter(([id]) => id.startsWith(`${h.id}/`))
                .map(([id, name]) => (
                  <button
                    key={id}
                    title={name}
                    onClick={() => {
                      setHostFilter(h.id);
                      setProject(id);
                      setFocus(null);
                      setQuery('');
                    }}
                  >
                    {name.slice(h.name.length + 3)}
                  </button>
                ))}
              {h.connection.state !== 'connected' && (
                <button onClick={() => setModal({ type: 'hosts' })}>Connexion et identité</button>
              )}
            </details>
          ))}
        </nav>
        <ReactFlow
          nodes={flowNodes}
          onNodesChange={(changes) => {
            for (const change of changes) {
              if (change.type === 'position' && change.position)
                positions.current.set(change.id, change.position);
            }
            setFlowNodes((previous) => applyNodeChanges(changes, previous));
          }}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode="loose"
          nodesConnectable={false}
          deleteKeyCode={null}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements={graph.nodes.length > 100}
          onNodeClick={(_, n) => {
            setContextMenu(null);
            setSelected(n.id);
            setPanel(true);
          }}
          onNodeContextMenu={(event, node) => {
            if (node.data.container && !node.data.container.isProbe)
              openContextMenu(event, node.data.container);
          }}
          onNodeDoubleClick={(_, n) => {
            setSelected(n.id);
            setPanel(true);
          }}
          onPaneClick={() => {
            setContextMenu(null);
            setSelected(null);
            setPanel(false);
          }}
          onEdgeClick={(_, edge) => {
            if (edge.data?.check) setModal({ type: 'check', data: edge.data.check });
            else if (edge.data?.flow) setModal({ type: 'flow', data: edge.data.flow });
            else {
              const containers = (snapshot?.containers || []).filter((c) =>
                [edge.source, edge.target].includes(`c:${c.id}`),
              );
              const networkId = [edge.source, edge.target]
                .find((id) => id.startsWith('n:'))
                ?.slice(2);
              if (containers.length) openCapturePlan(containers, networkId);
            }
          }}
          onNodeDrag={(_, n) => {
            positions.current.set(n.id, n.position);
          }}
          onNodeDragStop={(_, n) => {
            positions.current.set(n.id, n.position);
            setRevision((v) => v + 1);
          }}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
          colorMode="light"
        />
        {!graph.nodes.length && !loading && (
          <div className="inventory-empty">
            <Network size={28} />
            <strong>
              {snapshot?.containers.length
                ? 'Aucun équipement ne correspond aux filtres.'
                : error || snapshot?.hosts?.every((h) => h.connection.state !== 'connected')
                  ? 'Connecte un moteur Docker pour découvrir ses équipements.'
                  : 'Aucun conteneur découvert sur les serveurs connectés.'}
            </strong>
            {snapshot?.containers.length > 0 && (
              <button onClick={reset}>Réinitialiser les filtres</button>
            )}
          </div>
        )}
        <div className="inventory-map-note">
          Gris : réseau configuré · Bleu : attendu · Vert : capturé · Pointillé vert : historique.
          Enveloppe mobile : nouveaux paquets groupés. Clique sur un lien pour observer ou
          inspecter.
        </div>
      </div>
      <div className="mode-strip">
        <span className="mode-note">
          {view.containers.length} conteneurs et {view.networks.length} réseaux affichés
        </span>
        <span className="toolbar-spacer" />
        <div className="inventory-layers">
          <label>
            <input
              type="checkbox"
              checked={showExpected}
              onChange={(e) => setShowExpected(e.target.checked)}
            />
            Attendu
          </label>
          <label>
            <input
              type="checkbox"
              checked={showObserved}
              onChange={(e) => setShowObserved(e.target.checked)}
            />
            Observé
          </label>
        </div>
        <label>
          <input
            type="checkbox"
            checked={showProbes}
            onChange={(e) => setShowProbes(e.target.checked)}
          />
          Sondes de capture
        </label>
        <label>
          <input
            type="checkbox"
            checked={showUnused}
            onChange={(e) => setShowUnused(e.target.checked)}
          />
          Réseaux sans conteneur affiché
        </label>
      </div>
      <section className="inventory-list">
        <div className="workspace-tabs">
          {[
            ['equipment', 'Équipements'],
            ['checks', `Connexions attendues (${snapshot?.checks?.length || 0})`],
            ['history', 'Historique des diagnostics'],
            ['captures', `Flux et captures (${snapshot?.captures?.length || 0})`],
          ].map(([id, label]) => (
            <button
              key={id}
              className={listTab === id ? 'active' : ''}
              onClick={() => setListTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {recheck.length > 0 && (
          <div className="workspace-suggest-checks">
            Action effectuée. Vérifier les connexions concernées :{' '}
            {recheck.map((c) => (
              <button key={c.id} onClick={() => runCheck(c)}>
                {c.name}
              </button>
            ))}
            <button onClick={() => setRecheck([])}>Masquer</button>
          </div>
        )}
        {listTab === 'checks' ? (
          <DiagnosticsPanel
            inventory={snapshot || {}}
            onRun={runCheck}
            onEdit={(c) => setModal({ type: 'check', data: c })}
            onInspect={(r) => setModal({ type: 'run', data: r })}
            onDelete={async (c) => {
              try {
                await workspaceApi(`/api/checks/${c.id}`, {}, 'DELETE');
                refresh();
              } catch (e) {
                setOperationError(e.message);
              }
            }}
          />
        ) : listTab === 'history' ? (
          <div className="workspace-history">
            {snapshot?.runs?.map((r) => (
              <button key={r.id} onClick={() => setModal({ type: 'run', data: r })}>
                <span className={`result-state ${r.status}`}>{resultLabels[r.status]}</span>
                {r.check.name} · {new Date(r.startedAt).toLocaleString('fr-FR')}
              </button>
            ))}
            {!snapshot?.runs?.length && <p>Aucun diagnostic enregistré.</p>}
          </div>
        ) : listTab === 'captures' ? (
          <div className="workspace-history">
            {snapshot?.captures?.map((c) => (
              <button key={c.id} onClick={() => setModal({ type: 'capture', data: c.id })}>
                <span className={`inventory-capture-state ${c.status}`}>
                  {c.status === 'running'
                    ? '● Capture active'
                    : c.status === 'completed'
                      ? 'Capture terminée'
                      : 'Capture interrompue'}
                </span>{' '}
                · {c.targets.map((t) => t.name).join(' ↔ ')} · {c.count} observations ·{' '}
                {new Date(c.startedAt).toLocaleString('fr-FR')}
              </button>
            ))}
            {!snapshot?.captures?.length && (
              <p>
                Sélectionne une machine puis « Observer les flux ». Capture ciblée de 30 s, limitée
                à 20 Mo. Les enveloppes regroupent les échanges ; clique dessus pour inspecter un
                paquet.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="library-title">
              <Server size={13} />
              Équipements découverts
              <span>Choisis une ligne pour retrouver l’équipement sur la carte.</span>
              <button disabled={currentPage === 0} onClick={() => setPage((p) => p - 1)}>
                ‹
              </button>
              <span className="inventory-page">
                {currentPage + 1} / {pages}
              </span>
              <button disabled={currentPage >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                ›
              </button>
            </div>
            <div className="inventory-table-scroll">
              <table className="packet-table">
                <thead>
                  <tr>
                    <th>Équipement</th>
                    <th>État</th>
                    <th>Projet</th>
                    <th>Image</th>
                    <th>Adresses IP</th>
                    <th>Ports publiés</th>
                  </tr>
                </thead>
                <tbody>
                  {view.containers.slice(currentPage * 50, (currentPage + 1) * 50).map((c) => (
                    <tr
                      key={c.id}
                      className={selected === `c:${c.id}` ? 'active' : ''}
                      tabIndex={0}
                      onClick={() => choose(`c:${c.id}`, true)}
                      onContextMenu={(e) => !c.isProbe && openContextMenu(e, c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') choose(`c:${c.id}`, true);
                        if (
                          !c.isProbe &&
                          (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
                        )
                          openContextMenu(e, c, true);
                      }}
                    >
                      <td title={c.name}>{c.name}</td>
                      <td>
                        <span
                          className={`inventory-state ${c.attention ? 'alert' : c.state === 'running' ? 'running' : ''}`}
                        />
                        {states[c.state] || c.state}
                        {c.health === 'unhealthy' ? ' · Santé en échec' : ''}
                      </td>
                      <td>{c.project}</td>
                      <td>{c.image}</td>
                      <td>
                        {c.attachments
                          .map((a) => a.ip || a.ipv6)
                          .filter(Boolean)
                          .join(' / ') || 'N/D'}
                      </td>
                      <td>
                        {c.ports
                          .filter((p) => p.host)
                          .map(portText)
                          .join(', ') || 'Aucun'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <footer className="statusbar">
        <span>
          Docker Tracer v0.12 · {snapshot?.hosts?.length || 1} serveur(s) · Vue d’ensemble
        </span>
        <span>
          {snapshot
            ? `Dernière lecture : ${new Date(snapshot.observedAt).toLocaleTimeString('fr-FR')}`
            : 'En attente de Docker'}
          <span className="statusbar-muted">Docker {snapshot?.engine.version || 'N/D'}</span>
        </span>
      </footer>
      {panel && (currentContainer || currentNetwork) && (
        <aside
          className="inspector inventory-inspector"
          role="dialog"
          aria-label="Détails de l’équipement"
        >
          <div className="aside-heading">
            <span>
              <Server size={13} />
              {currentContainer?.name || currentNetwork.name}
            </span>
            <button className="icon-btn" title="Fermer les détails" onClick={() => setPanel(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="inspector-scroll">
            {currentContainer ? (
              <>
                <h2>{currentContainer.name}</h2>
                <p className="inventory-detail-state">
                  <span
                    className={`inventory-state ${currentContainer.state === 'running' ? 'running' : ''}`}
                  />
                  {states[currentContainer.state] || currentContainer.state}
                  {currentContainer.health === 'healthy' ? ' · Bonne santé' : ''}
                </p>
                {!currentContainer.isProbe && (
                  <div className="inventory-control-grid" aria-label="Gérer ce conteneur">
                    <button
                      disabled={currentContainer.stale || currentContainer.state !== 'running'}
                      title={
                        currentContainer.state !== 'running'
                          ? 'Démarre ce conteneur pour ouvrir un terminal.'
                          : 'Ouvrir le terminal du conteneur'
                      }
                      onClick={() => openWorkbench(currentContainer, 'terminal')}
                    >
                      <Terminal size={17} /> Terminal
                    </button>
                    <button
                      disabled={currentContainer.stale}
                      onClick={() => openWorkbench(currentContainer, 'files')}
                    >
                      <FolderOpen size={17} /> Fichiers
                    </button>
                    <button
                      disabled={currentContainer.stale}
                      onClick={() => openWorkbench(currentContainer, 'logs')}
                    >
                      <FileText size={17} /> Logs
                    </button>
                    <button
                      disabled={currentContainer.stale}
                      onClick={() => editConfiguration(currentContainer, 'ports')}
                    >
                      <SlidersHorizontal size={17} /> Ports et réglages
                    </button>
                    <button
                      disabled={currentContainer.stale}
                      onClick={() => openWorkbench(currentContainer, 'resources')}
                    >
                      <Cpu size={17} /> Matériel
                    </button>
                    <button
                      disabled={currentContainer.stale}
                      onClick={() => setModal({ type: 'check' })}
                    >
                      <Network size={17} /> Tester une connexion
                    </button>
                  </div>
                )}
                {!currentContainer.isProbe && (
                  <div className="inventory-observe-card">
                    <div>
                      <Activity size={17} />
                      <strong>Trafic réseau</strong>
                    </div>
                    <button
                      className="deploy-button"
                      disabled={
                        !!capturePending ||
                        currentContainer.stale ||
                        currentContainer.state !== 'running'
                      }
                      onClick={() => startCapture(currentContainer)}
                    >
                      <Activity size={14} />
                      {capturePending === currentContainer.id
                        ? 'Démarrage…'
                        : activeSelectedCapture
                          ? `Voir le direct · ${activeSelectedCapture.count || 0} observations`
                          : 'Observer pendant 30 s'}
                    </button>
                    {!activeSelectedCapture && selectedCaptures.length > 0 && (
                      <button
                        onClick={() => setModal({ type: 'capture', data: selectedCaptures[0].id })}
                      >
                        Dernière capture · {selectedCaptures[0].count || 0} observations
                      </button>
                    )}
                    <button
                      disabled={
                        !!capturePending ||
                        currentContainer.stale ||
                        currentContainer.state !== 'running'
                      }
                      onClick={() => openCapturePlan([currentContainer])}
                    >
                      Choisir une relation à observer
                    </button>
                    <details className="inventory-help">
                      <summary>À propos de la capture</summary>
                      <p>
                        Capture limitée à 30 s et 20 Mio. La carte regroupe jusqu’à 150 relations ;
                        les 600 dernières observations et l’export PCAP restent consultables. Une
                        animation regroupe les nouveaux paquets reçus, avec 24 enveloppes mobiles
                        maximum.
                      </p>
                    </details>
                  </div>
                )}
                {!currentContainer.isProbe && (
                  <ContainerActions
                    compact
                    key={currentContainer.id}
                    container={currentContainer}
                    onChanged={refresh}
                    onCheck={() => setModal({ type: 'check' })}
                    onCapture={() => startCapture(currentContainer)}
                    onReplayChecks={(checks) => {
                      setRecheck(checks);
                      setListTab('checks');
                    }}
                  />
                )}
                {currentContainer.attention && (
                  <div className="inventory-alert">
                    <AlertTriangle size={15} />
                    {currentContainer.health === 'unhealthy'
                      ? 'Le contrôle de santé Docker échoue. Consulte les logs de ce service.'
                      : currentContainer.state === 'restarting'
                        ? 'Ce conteneur redémarre. Vérifie sa configuration et ses logs.'
                        : 'Docker signale un conteneur en erreur.'}
                  </div>
                )}
                <details className="inventory-technical">
                  <summary>Détails techniques</summary>
                  <dl className="packet-details">
                    <dt>Image</dt>
                    <dd>{currentContainer.image}</dd>
                    <dt>Projet</dt>
                    <dd>{currentContainer.project}</dd>
                    <dt>ID</dt>
                    <dd>
                      <code>{currentContainer.id.slice(0, 12)}</code>
                    </dd>
                    <dt>Mode réseau</dt>
                    <dd>{currentContainer.networkMode}</dd>
                    {details && (
                      <>
                        <dt>Redémarrages</dt>
                        <dd>{details.restartCount}</dd>
                        <dt>Santé</dt>
                        <dd>{details.health || 'Aucun contrôle défini'}</dd>
                        {currentContainer.state !== 'running' && (
                          <>
                            <dt>Code de sortie</dt>
                            <dd>{details.exitCode}</dd>
                          </>
                        )}
                      </>
                    )}
                  </dl>
                </details>
                <div className="metric-grid">
                  <div>
                    <small>CPU</small>
                    <strong>
                      {details?.metrics ? `${details.metrics.cpu.toFixed(1)} %` : 'N/D'}
                    </strong>
                  </div>
                  <div>
                    <small>MÉMOIRE</small>
                    <strong>{formatBytes(details?.metrics?.memory)}</strong>
                  </div>
                </div>
                <details className="inventory-help">
                  <summary>Compteurs réseau</summary>
                  <p className="field-hint">
                    Reçu : {formatBytes(details?.metrics?.rx)} · Envoyé :{' '}
                    {formatBytes(details?.metrics?.tx)} · compteurs cumulés
                  </p>
                </details>
                {detailsError && <p className="inventory-alert">{detailsError}</p>}
                {details?.error && <p className="inventory-alert">{details.error}</p>}
                <h3>Connexions</h3>
                {!currentContainer.isProbe && (
                  <button
                    className="inventory-port-edit"
                    onClick={() => editConfiguration(currentContainer, 'networks')}
                  >
                    <Network size={13} />
                    {editable || canOpenCurrentLab
                      ? 'Modifier les connexions'
                      : 'Rattacher le Compose pour modifier les connexions'}
                  </button>
                )}
                {!currentContainer.isProbe && !editable && !canOpenCurrentLab && (
                  <p className="field-hint">
                    Importe le fichier Compose d’origine sur ce serveur pour retrouver ces
                    connexions dans une carte modifiable.
                  </p>
                )}
                {currentContainer.attachments.length ? (
                  currentContainer.attachments.map((a) => (
                    <button
                      className="inventory-connection"
                      key={a.networkId}
                      onClick={() => choose(`n:${a.networkId}`, true)}
                    >
                      <Network size={13} />
                      <span>
                        {snapshot.networks.find((n) => n.id === a.networkId)?.name}
                        <small>
                          {a.ip ||
                            a.ipv6 ||
                            (currentContainer.networkMode === 'host'
                              ? 'Adresse partagée avec l’hôte'
                              : 'Aucune IP attribuée')}
                        </small>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="field-hint">
                    {currentContainer.networkMode.startsWith('container:')
                      ? 'Espace réseau partagé avec un autre conteneur.'
                      : 'Aucun réseau Docker dédié.'}
                  </p>
                )}
                <h3>Ports</h3>
                {!currentContainer.isProbe && (
                  <button
                    className="inventory-port-edit"
                    onClick={() => editConfiguration(currentContainer, 'ports')}
                  >
                    <SlidersHorizontal size={13} />
                    {editable || canOpenCurrentLab
                      ? 'Modifier les ports'
                      : 'Importer le Compose pour modifier'}
                  </button>
                )}
                {currentContainer.ports.length ? (
                  currentContainer.ports.map((p, i) => (
                    <div className="inventory-port" key={i}>
                      {portText(p)}
                    </div>
                  ))
                ) : (
                  <p className="field-hint">Aucun port déclaré.</p>
                )}
              </>
            ) : (
              <>
                <h2>{currentNetwork.name}</h2>
                <dl className="packet-details">
                  <dt>Type</dt>
                  <dd>{networkType(currentNetwork)}</dd>
                  <dt>Portée</dt>
                  <dd>{currentNetwork.scope}</dd>
                  <dt>Sous-réseaux</dt>
                  <dd>{currentNetwork.subnets.join(', ') || 'Non défini'}</dd>
                  <dt>Accès externe</dt>
                  <dd>
                    {currentNetwork.internal
                      ? 'Réseau interne isolé'
                      : 'Selon le pilote et le routage de l’hôte'}
                  </dd>
                </dl>
                <h3>Conteneurs connectés</h3>
                {snapshot.containers
                  .filter((c) => c.attachments.some((a) => a.networkId === currentNetwork.id))
                  .map((c) => (
                    <button
                      className="inventory-connection"
                      key={c.id}
                      onClick={() => choose(`c:${c.id}`, true)}
                    >
                      <Server size={13} />
                      {c.name}
                    </button>
                  ))}
              </>
            )}
          </div>
        </aside>
      )}
      {contextMenu && menuContainer && (
        <div
          className="inventory-context-menu"
          role="menu"
          aria-label={`Actions sur ${menuContainer.name}`}
          ref={menuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              setContextMenu(null);
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
            const current = buttons.indexOf(document.activeElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          <strong>{menuContainer.name}</strong>
          <span>
            {menuContainer.hostName} · {states[menuContainer.state] || menuContainer.state}
          </span>
          <button
            role="menuitem"
            disabled={menuContainer.stale || menuContainer.state !== 'running'}
            onClick={() => openWorkbench(menuContainer, 'terminal')}
          >
            <Terminal size={15} /> Terminal Docker
          </button>
          <button
            role="menuitem"
            disabled={menuContainer.stale}
            onClick={() => openWorkbench(menuContainer, 'files')}
          >
            <FolderOpen size={15} /> Parcourir et éditer les fichiers
          </button>
          <button
            role="menuitem"
            disabled={menuContainer.stale}
            onClick={() => openWorkbench(menuContainer, 'logs')}
          >
            <FileText size={15} /> Consulter les logs
          </button>
          <button role="menuitem" onClick={() => editConfiguration(menuContainer, 'ports')}>
            <SlidersHorizontal size={15} />
            {findEditableProject(menuContainer, managedProjects) ||
            (menuContainer.labId === currentLab && menuContainer.hostId === currentHost)
              ? 'Modifier les ports et la configuration'
              : 'Importer le Compose pour modifier'}
          </button>
          <button role="menuitem" onClick={() => editConfiguration(menuContainer, 'networks')}>
            <Network size={15} />
            {findEditableProject(menuContainer, managedProjects) ||
            (menuContainer.labId === currentLab && menuContainer.hostId === currentHost)
              ? 'Modifier les connexions'
              : 'Rattacher le Compose pour les connexions'}
          </button>
          <button
            role="menuitem"
            disabled={!!capturePending || menuContainer.stale || menuContainer.state !== 'running'}
            onClick={() => startCapture(menuContainer)}
          >
            <Activity size={15} /> Observer les flux · 30 s
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              setPanel(true);
            }}
          >
            <Server size={15} /> État, démarrage et arrêt
          </button>
        </div>
      )}
      {workbench && (
        <ContainerWorkbench
          container={workbenchContainer}
          initialTab={workbench.tab}
          onClose={() => setWorkbench(null)}
          onChanged={refresh}
          onEditConfiguration={(_container, section = 'ports') =>
            editConfiguration(workbenchContainer, section)
          }
        />
      )}
      {modal && (
        <WorkspaceModal
          title={
            {
              hosts: 'Mes serveurs Docker',
              check: 'Connexion attendue',
              run: 'Diagnostic de connexion',
              capture: 'Échanges capturés',
              'capture-plan': 'Observer une relation Docker',
              flow: 'Preuve du flux observé',
              packet: 'Enveloppe observée',
            }[modal.type]
          }
          wide={['run', 'capture', 'flow'].includes(modal.type)}
          onClose={() => setModal(null)}
        >
          {modal.type === 'hosts' ? (
            <HostManager onChanged={refresh} />
          ) : modal.type === 'check' ? (
            <CheckEditor
              inventory={snapshot}
              initial={modal.data}
              selected={selected}
              onSaved={() => {
                setModal(null);
                setListTab('checks');
                refresh();
              }}
            />
          ) : modal.type === 'run' ? (
            <RunDetails
              run={modal.data}
              runs={snapshot?.runs || []}
              onRun={runCheck}
              onCapture={(id) => setModal({ type: 'capture', data: id })}
            />
          ) : modal.type === 'capture-plan' ? (
            <CapturePlan
              containers={snapshot?.containers || []}
              initialIds={modal.data.ids}
              networkId={modal.data.networkId}
              pending={!!capturePending}
              error={operationError}
              onStart={startCapture}
            />
          ) : modal.type === 'flow' ? (
            <ObservedFlowDetails
              flow={modal.data}
              capture={snapshot?.captures?.find((capture) => capture.id === modal.data.captureId)}
              onCapture={(id) => setModal({ type: 'capture', data: id })}
              onReplay={replayPacket}
            />
          ) : modal.type === 'capture' ? (
            <CaptureDetails id={modal.data} onReplay={replayPacket} />
          ) : (
            <PacketInspector
              packet={modal.data}
              packets={[modal.data]}
              onSelect={() => {}}
              onReplay={replayPacket}
            />
          )}
        </WorkspaceModal>
      )}
    </section>
  );
}
export default memo(function Inventory(props) {
  return (
    <ReactFlowProvider>
      <InventoryCanvas {...props} />
    </ReactFlowProvider>
  );
});
