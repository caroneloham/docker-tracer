import React, { useEffect, useState } from 'react';
import { Activity, Mail, Square } from 'lucide-react';
import { EdgeLabelRenderer } from '@xyflow/react';
import { captureSelection, OBSERVATION_MOTION_MS } from '../shared/inventory-live.mjs';
import { PacketInspector } from './Packets.jsx';

const time = (value) => new Date(value).toLocaleTimeString('fr-FR');

export function ObservedEnvelope({ path, x, y, flow, burst, replay, direction, onInspect }) {
  const packet = flow.packet;
  if (!packet) return null;
  const open = (event) => {
    event.stopPropagation();
    onInspect(flow);
  };
  const envelope = (
    <>
      <rect x="-10" y="-7" width="20" height="14" rx="2" />
      <path d="m-10-7 10 8 10-8" />
    </>
  );
  return (
    <>
      <EdgeLabelRenderer>
        <button
          className="observed-flow-button nodrag nopan"
          type="button"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          data-flow-key={flow.key}
          data-packet-id={packet.id}
          aria-label={`Inspecter le flux ${packet.protocol}, ${flow.count} paquets, ${packet.source} vers ${packet.target}`}
          title={`${packet.protocol} · ${flow.count} paquets capturés · dernier à ${time(packet.time)} · ${packet.source} → ${packet.target}`}
          onClick={open}
        >
          <Mail size={21} aria-hidden="true" />
          <span>
            {packet.protocol} {direction} {flow.count}
          </span>
        </button>
      </EdgeLabelRenderer>
      {(burst || replay) && (
        <g
          key={replay || burst.id}
          className="observed-envelope observed-envelope-arrival"
          aria-hidden="true"
        >
          {envelope}
          {burst?.count > 1 && (
            <text y="-13" textAnchor="middle">
              +{burst.count}
            </text>
          )}
          <animateMotion
            dur={`${OBSERVATION_MOTION_MS / 1000}s`}
            path={path}
            rotate="0"
            repeatCount="1"
            fill="freeze"
          />
        </g>
      )}
    </>
  );
}

export function CapturePlan({ containers, initialIds = [], networkId, pending, error, onStart }) {
  const [sourceId, setSourceId] = useState(initialIds[0] || ''),
    [targetId, setTargetId] = useState(initialIds[1] || '');
  const source = containers.find((container) => container.id === sourceId);
  const eligible = containers.filter((container) => !container.isProbe);
  const peers = eligible
    .filter((container) => container.id !== sourceId && container.hostId === source?.hostId)
    .sort(
      (a, b) =>
        Number(b.attachments.some((item) => item.networkId === networkId)) -
          Number(a.attachments.some((item) => item.networkId === networkId)) ||
        a.name.localeCompare(b.name),
    );
  const selection = captureSelection(containers, [sourceId, targetId]);
  return (
    <form
      className="inventory-capture-plan"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selection.error) onStart(selection.targets);
      }}
    >
      <p>
        Observe les paquets qui passent dans un ou deux espaces réseau Docker. La capture s’arrête
        automatiquement après 30 s, avec un plafond de 20 Mio.
      </p>
      <label>
        Premier conteneur
        <select
          aria-label="Premier conteneur à observer"
          value={sourceId}
          disabled={pending}
          onChange={(event) => {
            setSourceId(event.target.value);
            setTargetId('');
          }}
        >
          <option value="">Choisir un conteneur</option>
          {eligible.map((container) => (
            <option
              key={container.id}
              value={container.id}
              disabled={container.stale || container.state !== 'running'}
            >
              {container.name} · {container.hostName || container.hostId}
              {container.state !== 'running'
                ? ' · arrêté'
                : container.stale
                  ? ' · état périmé'
                  : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Second conteneur, facultatif
        <select
          aria-label="Second conteneur à observer"
          value={targetId}
          disabled={pending || !source}
          onChange={(event) => setTargetId(event.target.value)}
        >
          <option value="">Un seul espace réseau</option>
          {peers.map((container) => (
            <option
              key={container.id}
              value={container.id}
              disabled={container.stale || container.state !== 'running'}
            >
              {container.name}
              {container.state !== 'running'
                ? ' · arrêté'
                : container.stale
                  ? ' · état périmé'
                  : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="workspace-notice">
        Utilise ton application pendant la capture pour produire du trafic. Aucun paquet de test
        n’est envoyé. Tous les échanges de ces espaces sont observés, y compris avec d’autres
        destinations.
      </p>
      <p>
        Deux conteneurs qui partagent le même espace réseau utilisent une seule sonde. Les paquets
        vers une adresse non identifiée restent consultables dans la capture.
      </p>
      {(error || selection.error) && (
        <p className="pdu-error" role="alert">
          {error || selection.error}
        </p>
      )}
      <button className="deploy-button" disabled={pending || !!selection.error}>
        <Activity size={14} />
        {pending
          ? 'Démarrage…'
          : `Observer ${selection.targets.length || 1} conteneur${selection.targets.length > 1 ? 's' : ''} pendant 30 s`}
      </button>
    </form>
  );
}

export function ObservationStatus({
  summary,
  connected,
  pending,
  stopping,
  showObserved,
  onShow,
  onStart,
  onInspect,
  onStop,
}) {
  const [now, setNow] = useState(Date.now());
  const active = summary.sessions.length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <section
      className={`inventory-live-strip ${active ? 'is-active' : 'is-idle'}`}
      aria-label="Observation du trafic réseau"
    >
      <Activity size={16} />
      <div className="inventory-live-copy">
        <strong>
          {pending
            ? 'Démarrage de l’observation…'
            : active
              ? connected
                ? 'Écoute active'
                : 'Direct interrompu, reconnexion…'
              : 'Observation du trafic à la demande'}
        </strong>
        <span>
          {active ? `${summary.packets} paquets reçus · ` : ''}
          {summary.mapped.length} flux sur la carte · 30 s par nouvelle capture · 20 Mio · 2 espaces
          maximum
        </span>
        <span>
          {!showObserved
            ? 'La couche des flux observés est masquée.'
            : summary.mapped.length
              ? 'Une enveloppe mobile signale de nouveaux paquets reçus. Clique sur un flux pour la preuve.'
              : active
                ? summary.packets
                  ? 'Paquets reçus, aucun échange identifié entre deux conteneurs visibles.'
                  : 'En attente de paquets. Utilise ton application pour générer du trafic.'
                : 'Sélectionne un conteneur ou un lien puis lance une observation.'}
        </span>
        {summary.hidden > 0 && <span>{summary.hidden} flux hors des filtres de la carte.</span>}
        {summary.unresolved > 0 && (
          <span>
            {summary.unresolved} paquets sans relation entre deux conteneurs identifiés : voir la
            capture.
          </span>
        )}
        {summary.warnings.map((warning) => (
          <span className="inventory-observation-warning" key={warning}>
            {warning}
          </span>
        ))}
      </div>
      {!showObserved && <button onClick={onShow}>Afficher les flux</button>}
      <button onClick={onStart} disabled={pending}>
        <Mail size={13} /> Observer des flux
      </button>
      {summary.sessions.map((capture) => {
        const remaining = Math.max(
          0,
          Math.ceil(((capture.startedAt || now) + (capture.duration || 30) * 1000 - now) / 1000),
        );
        return (
          <div className="inventory-live-session" key={capture.id}>
            <button
              onClick={() => onInspect(capture.id)}
              title="Ouvrir les paquets capturés et le PCAP"
            >
              {capture.targets.map((target) => target.name).join(' ↔ ')} · {capture.count || 0}{' '}
              paquets · {remaining ? `≤ ${remaining} s` : 'finalisation…'}
            </button>
            <button
              title={`Arrêter la capture ${capture.targets.map((target) => target.name).join(', ')}`}
              disabled={stopping === capture.id}
              onClick={() => onStop(capture)}
            >
              <Square size={12} /> Arrêter
            </button>
          </div>
        );
      })}
    </section>
  );
}

export function ObservedFlowDetails({ flow, capture, onCapture, onReplay }) {
  return (
    <div className="inventory-flow-proof">
      <p className="workspace-notice">
        Preuve : {flow.count} paquets dans cette relation, {flow.bytes || 0} octets. Dernier paquet
        reçu à {time(flow.packet.time)}.{' '}
        {capture?.status === 'running'
          ? 'La session est encore active.'
          : 'Cette observation est conservée dans l’historique.'}
      </p>
      <p>
        Une relation observée identifie les deux extrémités. Elle ne prouve pas à elle seule le
        trajet physique ni la réussite de la requête.
      </p>
      {flow.captureId && (
        <button onClick={() => onCapture(flow.captureId)}>
          Tous les paquets et PCAP de cette capture
        </button>
      )}
      <PacketInspector
        packet={flow.packet}
        packets={[flow.packet]}
        onSelect={() => {}}
        onReplay={onReplay}
      />
    </div>
  );
}
