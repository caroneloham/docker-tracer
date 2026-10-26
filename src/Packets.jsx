import React, { useState } from 'react';
import { Mail, Play, ChevronLeft, ChevronRight } from 'lucide-react';
import { probeSchema } from '../shared/probes.mjs';
import { packetChecks } from '../shared/packet-checks.mjs';
import './packets.css';

export function PacketComposer({ containers, runtime, busy, capture, initial, onRun }) {
  const [draft, setDraft] = useState({
    source: initial.source,
    target: initial.target,
    protocol: initial.protocol || 'ICMP',
    count: 3,
    size: 56,
    ttl: 64,
    port: 80,
    path: '/',
    method: 'GET',
    payload: '',
    headers: '',
    query: '',
    autoCapture: true,
    ...initial,
  });
  const [error, setError] = useState('');
  const field = (key, value) =>
    setDraft((d) => ({
      ...d,
      [key]: value,
      ...(key === 'source' && d.target === value
        ? { target: containers.find((c) => c.id !== value)?.id || '' }
        : {}),
    }));
  const source = containers.find((c) => c.id === draft.source),
    target = containers.find((c) => c.id === draft.target);
  return (
    <>
      <span className="eyebrow">PDU · TEST RÉSEAU PERSONNALISÉ</span>
      <h2>
        <Mail size={20} />
        Envoyer des paquets
      </h2>
      <p>
        {capture
          ? 'La capture est active : les échanges apparaîtront sur le schéma.'
          : 'Active la capture du labo pour observer les paquets. Le résultat du test reste disponible sans capture.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const p = probeSchema.parse(draft);
            setError('');
            onRun({ ...p, autoCapture: draft.autoCapture });
          } catch (e) {
            setError(e.issues?.map((i) => i.message).join(' ') || e.message);
          }
        }}
      >
        {!capture && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.autoCapture}
              onChange={(e) => field('autoCapture', e.target.checked)}
            />
            Activer la capture automatiquement
          </label>
        )}
        <div className="pdu-form-row">
          <label>
            Source
            <select value={draft.source} onChange={(e) => field('source', e.target.value)}>
              {containers.map((c) => (
                <option key={c.id} value={c.id} disabled={runtime.nodes[c.id]?.state !== 'running'}>
                  {c.data.label}
                  {runtime.nodes[c.id]?.state !== 'running' ? ' · arrêté' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select value={draft.target} onChange={(e) => field('target', e.target.value)}>
              {containers
                .filter((c) => c.id !== draft.source)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.data.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          Protocole
          <select value={draft.protocol} onChange={(e) => field('protocol', e.target.value)}>
            <option value="ICMP">ICMP · Ping</option>
            <option value="HTTP">HTTP · Requête web</option>
            <option value="DNS">DNS · Résolution de nom</option>
            <option value="TCP">TCP · Connexion et message</option>
            <option value="UDP">UDP · Envoi de datagramme</option>
          </select>
        </label>
        {draft.protocol === 'ICMP' && (
          <div className="pdu-form-row">
            <label>
              Nombre
              <input
                type="number"
                min="1"
                max="10"
                value={draft.count}
                onChange={(e) => field('count', Number(e.target.value))}
              />
            </label>
            <label>
              Données (octets)
              <input
                type="number"
                min="0"
                max="1400"
                value={draft.size}
                onChange={(e) => field('size', Number(e.target.value))}
              />
            </label>
            <label>
              TTL
              <input
                type="number"
                min="1"
                max="255"
                value={draft.ttl}
                onChange={(e) => field('ttl', Number(e.target.value))}
              />
            </label>
          </div>
        )}
        {['TCP', 'UDP', 'HTTP'].includes(draft.protocol) && (
          <label>
            Port de destination
            <input
              type="number"
              min="1"
              max="65535"
              value={draft.port}
              onChange={(e) => field('port', Number(e.target.value))}
            />
          </label>
        )}
        {draft.protocol === 'HTTP' && (
          <>
            <div className="pdu-form-row">
              <label>
                Méthode
                <select value={draft.method} onChange={(e) => field('method', e.target.value)}>
                  <option>GET</option>
                  <option>POST</option>
                </select>
              </label>
              <label>
                Chemin
                <input
                  value={draft.path}
                  onChange={(e) => field('path', e.target.value)}
                  placeholder="/"
                  maxLength={1000}
                />
              </label>
            </div>
            <label>
              En-têtes HTTP
              <textarea
                value={draft.headers}
                rows={2}
                placeholder={'Accept: application/json\nX-Lab: mon-test'}
                onChange={(e) => field('headers', e.target.value)}
                maxLength={2000}
              />
            </label>
          </>
        )}
        {(draft.protocol === 'TCP' ||
          draft.protocol === 'UDP' ||
          (draft.protocol === 'HTTP' && draft.method === 'POST')) && (
          <label>
            Message / données
            <textarea
              rows={3}
              value={draft.payload}
              maxLength={4096}
              onChange={(e) => field('payload', e.target.value)}
              placeholder={
                draft.protocol === 'TCP'
                  ? 'Laisse vide pour vérifier seulement la connexion.'
                  : 'Contenu à envoyer'
              }
            />
          </label>
        )}
        {draft.protocol === 'DNS' && (
          <label>
            Nom à résoudre
            <input
              value={draft.query}
              maxLength={253}
              placeholder={target?.data.label || 'Nom du conteneur cible'}
              onChange={(e) => field('query', e.target.value)}
            />
          </label>
        )}
        {draft.protocol === 'UDP' && (
          <p className="field-hint">
            UDP n’accuse pas réception. Un envoi réussi ne garantit pas que l’application a reçu le
            datagramme.
          </p>
        )}
        <p className="field-hint">
          Le test utilise ping, wget, nslookup ou nc dans{' '}
          {source?.data.label || 'le conteneur source'}. Le modèle PC Linux fournit ces outils.
        </p>
        {error && (
          <p className="pdu-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="deploy-button full"
          disabled={busy || !source || !target || runtime.nodes[draft.source]?.state !== 'running'}
        >
          <Mail size={15} />
          Lancer le test
        </button>
      </form>
    </>
  );
}

export function PacketInspector({ packet, packets, onSelect, onReplay }) {
  const [layer, setLayer] = useState('summary');
  const p = packet,
    l = p.layers || {},
    index = packets.findIndex((x) => x.id === p.id);
  const transport = l.transport || {},
    app = l.application || {};
  const rows =
    layer === 'summary'
      ? [
          ['Horodatage', new Date(p.time).toISOString()],
          ['Source', p.source],
          ['Destination', p.target],
          ['Taille', `${p.bytes} octets`],
          ['Protocole', p.protocol],
          [
            'Trajet',
            p.route.length
              ? 'Équipements reliés par le réseau identifié'
              : 'Trajet non déterminé sur ce schéma',
          ],
        ]
      : layer === 'ethernet'
        ? [
            ['MAC source', l.ethernet?.source],
            ['MAC destination', l.ethernet?.target],
          ]
        : layer === 'network'
          ? [
              ['Version', l.network?.version],
              ['IP source', p.source],
              ['IP destination', p.target],
              ['TTL / Hop limit', l.network?.ttl],
              ['Identification', l.network?.id],
            ]
          : layer === 'transport'
            ? [
                ['Port source', p.sourcePort],
                ['Port destination', p.targetPort],
                ['Drapeaux TCP', transport.flags],
                ['Séquence TCP', transport.sequence],
                ['ACK TCP', transport.ack],
                ['Fenêtre TCP', transport.window],
                ['Type ICMP', transport.icmpType],
                ['Code ICMP', transport.icmpCode],
                ['Séquence ICMP', transport.icmpSequence],
              ]
            : [
                ['Nom DNS', app.dnsQuery],
                [
                  'Réponse DNS',
                  /^(1|true)$/i.test(app.dnsResponse || '')
                    ? 'Oui'
                    : /^(0|false)$/i.test(app.dnsResponse || '') ? 'Non' : '',
                ],
                ['Méthode HTTP', app.method],
                ['URI HTTP', app.uri],
                ['Statut HTTP', app.status],
              ];
  const available = rows.filter(([, v]) => v !== undefined && v !== '');
  const checks = packetChecks(p);
  return (
    <>
      <span className="eyebrow">ENVELOPPE CAPTURÉE</span>
      <h2>
        {p.protocol} <span className="muted-title">· {p.bytes} octets</span>
      </h2>
      <div className="packet-layer-tabs">
        {[
          ['summary', 'Résumé'],
          ['ethernet', 'Liaison'],
          ['network', 'Internet'],
          ['transport', 'Transport'],
          ['application', 'Application'],
        ].map(([id, name]) => (
          <button key={id} className={layer === id ? 'active' : ''} onClick={() => setLayer(id)}>
            {name}
          </button>
        ))}
      </div>
      <dl className="packet-details">
        {available.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {!available.length && <p>Aucun champ de cette couche n’a été décodé pour ce paquet.</p>}
      <pre>{p.info}</pre>
      {layer === 'summary' && (
        <div className="packet-checks">
          <strong>Lecture du paquet</strong>
          {checks.map((c, i) => (
            <p key={i} className={c.level === 'alert' ? 'probe-failure' : ''}>
              {c.message}
            </p>
          ))}
        </div>
      )}
      <div className="packet-step-controls">
        <button
          disabled={index < 0 || index === packets.length - 1}
          onClick={() => onSelect(packets[index + 1])}
        >
          <ChevronLeft size={13} />
          Précédent
        </button>
        <span>
          {index < 0 ? 'Paquet sélectionné' : `${packets.length - index} / ${packets.length}`}
        </span>
        <button disabled={index <= 0} onClick={() => onSelect(packets[index - 1])}>
          Suivant
          <ChevronRight size={13} />
        </button>
      </div>
      <button className="outline-btn full" disabled={!p.route.length} onClick={() => onReplay(p)}>
        <Play size={13} />
        Rejouer l’animation sur le schéma
      </button>
      <p className="field-hint pdu-footnote">
        Navigation dans les observations capturées. Le trafic Docker continue pendant l’inspection.
      </p>
    </>
  );
}

export function ProbeHistory({ results, onInspect, onRepeat, busy }) {
  return (
    <div className="probe-history">
      <table className="packet-table">
        <thead>
          <tr>
            <th>Heure</th>
            <th>Test</th>
            <th>Source → destination</th>
            <th>Résultat</th>
            <th>Durée</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.finishedAt || r.startedAt).toLocaleTimeString('fr-FR')}</td>
              <td>{r.protocol}</td>
              <td>
                {r.sourceLabel} → {r.targetLabel}
              </td>
              <td className={r.exitCode === 0 ? 'probe-success' : 'probe-failure'}>{r.summary}</td>
              <td>{((r.finishedAt - r.startedAt) / 1000).toFixed(2)} s</td>
              <td>
                <button onClick={() => onInspect(r)}>Détails</button>
                <button disabled={busy} onClick={() => onRepeat(r.options)}>
                  Relancer
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!results.length && (
        <div className="empty-traffic">
          Les résultats de tes tests apparaîtront ici. Clique sur l’enveloppe pour commencer.
        </div>
      )}
    </div>
  );
}
