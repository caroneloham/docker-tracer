import React, { useEffect, useRef, useState } from 'react';
import { Plus, Play, X, Server, ShieldCheck, Activity, Download, RefreshCw } from 'lucide-react';
import { resourceRef, resultLabels } from '../shared/workspace.mjs';
import { PacketInspector } from './Packets.jsx';
import './workspace.css';

export async function workspaceApi(url, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Opération impossible.');
  return result;
}
export function WorkspaceModal({ title, children, onClose, wide = false }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e) => {
      if (e.target.closest?.('.xterm')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === 'Tab') {
        const focusable = [
          ...(panel.current?.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) || []),
        ].filter((node) => node.offsetParent !== null);
        const first = focusable[0],
          last = focusable.at(-1);
        if (!first) {
          e.preventDefault();
          panel.current?.focus();
        } else if (!panel.current?.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === panel.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      className="workspace-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        tabIndex={-1}
        className={`workspace-dialog ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="aside-heading">
          <strong>{title}</strong>
          <button title="Fermer la fenêtre" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="workspace-dialog-body">{children}</div>
      </section>
    </div>
  );
}
const blankHost = {
  name: '',
  kind: 'ssh',
  address: '',
  username: '',
  port: 22,
  auth: 'agent',
  identityFile: '',
};
export function HostManager({ onChanged }) {
  const [hosts, setHosts] = useState([]),
    [draft, setDraft] = useState(blankHost),
    [result, setResult] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => setHosts(await workspaceApi('/api/hosts'));
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  const action = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k, v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setResult(null);
  };
  return (
    <>
      <p>
        Connecte les moteurs Docker Linux de ton PC, de ton NAS ou de tes serveurs. Les clés privées
        restent sur cet ordinateur.
      </p>
      <div className="host-list">
        {hosts.map((h) => (
          <button
            key={h.id}
            className={draft.id === h.id ? 'active' : ''}
            onClick={() => {
              setDraft(h);
              setResult(h.connection);
            }}
          >
            <Server size={16} />
            <span>
              <strong>{h.name}</strong>
              <small>
                {h.kind === 'local' ? 'Moteur local' : `${h.username}@${h.address}:${h.port}`}
              </small>
            </span>
            <span className={`result-state ${h.connection.state === 'connected' ? 'passed' : ''}`}>
              {
                {
                  connected: 'Connecté',
                  offline: 'Inaccessible',
                  untrusted: 'À vérifier',
                  'changed-key': 'Clé modifiée',
                  unknown: 'Non testé',
                }[h.connection.state]
              }
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={() => {
          setDraft(blankHost);
          setResult(null);
        }}
      >
        <Plus size={13} /> Ajouter un serveur SSH
      </button>
      <form
        className="workspace-form"
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const h = await workspaceApi(
              draft.id ? `/api/hosts/${draft.id}` : '/api/hosts',
              draft,
              draft.id ? 'PUT' : 'POST',
            );
            setDraft(h);
            setResult(await workspaceApi(`/api/hosts/${h.id}/test`, {}));
          });
        }}
      >
        <label>
          Nom du serveur
          <input
            required
            maxLength={60}
            value={draft.name}
            onChange={(e) => field('name', e.target.value)}
          />
        </label>
        {draft.kind === 'ssh' && (
          <>
            <div className="pdu-form-row">
              <label>
                Adresse DNS ou IP
                <input
                  required
                  value={draft.address}
                  placeholder="192.168.1.50"
                  onChange={(e) => field('address', e.target.value)}
                />
              </label>
              <label>
                Port SSH
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => field('port', Number(e.target.value))}
                />
              </label>
            </div>
            <div className="pdu-form-row">
              <label>
                Utilisateur
                <input
                  required
                  value={draft.username}
                  onChange={(e) => field('username', e.target.value)}
                />
              </label>
              <label>
                Authentification
                <select value={draft.auth} onChange={(e) => field('auth', e.target.value)}>
                  <option value="agent">Agent SSH de cet ordinateur</option>
                  <option value="key">Fichier de clé locale</option>
                </select>
              </label>
            </div>
            {draft.auth === 'key' && (
              <label>
                Chemin absolu de la clé
                <input
                  required
                  value={draft.identityFile}
                  placeholder="C:\Users\…\.ssh\id_ed25519"
                  onChange={(e) => field('identityFile', e.target.value)}
                />
                <small>
                  Pour une clé chiffrée, utilise l’agent SSH qui la déverrouille. Les alias
                  ~/.ssh/config ne sont pas importés.
                </small>
              </label>
            )}
          </>
        )}
        <div className="workspace-actions">
          <button className="deploy-button" disabled={busy}>
            Enregistrer et tester
          </button>
          {draft.id && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                action(async () => setResult(await workspaceApi(`/api/hosts/${draft.id}/test`, {})))
              }
            >
              Tester la connexion
            </button>
          )}
        </div>
      </form>
      {result && (
        <div
          className={`workspace-notice ${result.state === 'connected' ? 'passed' : 'inconclusive'}`}
        >
          <strong>
            {result.state === 'connected'
              ? `Docker ${result.version} · ${result.name}`
              : result.message}
          </strong>
          {result.fingerprint && (
            <>
              <p>
                Empreinte présentée : <code>{result.fingerprint}</code>
              </p>
              {result.previousFingerprint && (
                <p>
                  Ancienne empreinte : <code>{result.previousFingerprint}</code>
                </p>
              )}
              <p>Compare cette empreinte avec celle affichée par l’administrateur du serveur.</p>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () =>
                    setResult(
                      await workspaceApi(`/api/hosts/${draft.id}/trust`, {
                        fingerprint: result.fingerprint,
                      }),
                    ),
                  )
                }
              >
                <ShieldCheck size={14} /> Confirmer cette empreinte SSH
              </button>
            </>
          )}
        </div>
      )}
      {draft.id && (
        <div className="workspace-actions">
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const r = await workspaceApi(`/api/hosts/${draft.id}/recover`, {});
                setResult({ message: `${r.removed} sonde(s) interrompue(s) nettoyée(s).` });
              })
            }
          >
            Nettoyer les sondes interrompues
          </button>
          {draft.id !== 'local' && (
            <button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await workspaceApi(`/api/hosts/${draft.id}`, {}, 'DELETE');
                  setDraft(blankHost);
                  setResult(null);
                })
              }
            >
              Retirer ce profil
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="pdu-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
export const toRef = (c) =>
  resourceRef(c.hostId || 'local', { ...c, projectKey: c.originalProjectKey || c.projectKey });
const refKey = (r) => `${r.hostId}:${r.containerId}`;
export function CheckEditor({ inventory, initial, selected, onSaved }) {
  const containers = inventory.containers.filter((c) => !c.isProbe);
  const first = containers.find((c) => c.id === selected?.slice(2)) || containers[0];
  const second = containers.find((c) => c.id !== first?.id);
  const [draft, setDraft] = useState(
    () =>
      initial || {
        name: '',
        source: first ? toRef(first) : null,
        target: second ? toRef(second) : null,
        protocol: 'TCP',
        hostname: '',
        address: '',
        port: 80,
        path: '/',
        expectedStatus: 200,
      },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const field = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const endpoint = (side) => (
    <label>
      {side === 'source' ? 'Depuis le conteneur' : 'Vers le conteneur'}
      <select
        required
        value={draft[side] ? refKey(draft[side]) : ''}
        onChange={(e) => {
          const c = containers.find((c) => c.id === e.target.value);
          field(side, toRef(c));
        }}
      >
        <option value="" disabled>
          Choisir un équipement
        </option>
        {containers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.hostName} / {c.name}
            {c.state !== 'running' ? ' · arrêté' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="workspace-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const c = await workspaceApi(
            initial ? `/api/checks/${initial.id}` : '/api/checks',
            draft,
            initial ? 'PUT' : 'POST',
          );
          onSaved(c);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        Enregistre une connexion qui doit fonctionner. Tu pourras la diagnostiquer puis refaire le
        même contrôle après une modification.
      </p>
      <label>
        Nom du contrôle
        <input
          required
          value={draft.name}
          maxLength={100}
          placeholder="WordPress doit joindre MySQL"
          onChange={(e) => field('name', e.target.value)}
        />
      </label>
      {endpoint('source')}
      {endpoint('target')}
      <div className="pdu-form-row">
        <label>
          Test applicatif
          <select
            value={draft.protocol}
            onChange={(e) => {
              field('protocol', e.target.value);
              if (e.target.value === 'HTTPS') field('port', 443);
            }}
          >
            <option>TCP</option>
            <option>HTTP</option>
            <option>HTTPS</option>
            <option>ICMP</option>
          </select>
        </label>
        {draft.protocol !== 'ICMP' && (
          <label>
            Port depuis la source
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(e) => field('port', Number(e.target.value))}
            />
          </label>
        )}
      </div>
      <label>
        Nom DNS à vérifier (facultatif)
        <input
          value={draft.hostname}
          placeholder="mysql"
          onChange={(e) => field('hostname', e.target.value)}
        />
      </label>
      <label>
        Adresse joignable depuis la source
        <input
          value={draft.address}
          placeholder="Automatique sur un même moteur ; à préciser entre serveurs"
          onChange={(e) => field('address', e.target.value)}
        />
        <small>
          Entre deux serveurs, utilise l’adresse et le port réellement exposés. Le logiciel ne
          suppose pas que les IP privées Docker sont routables.
        </small>
      </label>
      {['HTTP', 'HTTPS'].includes(draft.protocol) && (
        <div className="pdu-form-row">
          <label>
            Chemin HTTP
            <input required value={draft.path} onChange={(e) => field('path', e.target.value)} />
          </label>
          <label>
            Statut attendu
            <input
              type="number"
              min={100}
              max={599}
              value={draft.expectedStatus}
              onChange={(e) => field('expectedStatus', Number(e.target.value))}
            />
          </label>
        </div>
      )}
      {error && (
        <p className="pdu-error" role="alert">
          {error}
        </p>
      )}
      <button className="deploy-button full" disabled={busy || !draft.source || !draft.target}>
        Enregistrer la connexion attendue
      </button>
    </form>
  );
}
export function DiagnosticsPanel({ inventory, onEdit, onRun, onInspect, onDelete }) {
  return (
    <div className="workspace-table-scroll">
      <table className="packet-table">
        <thead>
          <tr>
            <th>Connexion attendue</th>
            <th>Source → destination</th>
            <th>Dernier résultat</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {inventory.checks?.map((c) => {
            const run = inventory.runs?.find((r) => r.checkId === c.id);
            return (
              <tr key={c.id}>
                <td>
                  {c.name}
                  <small>
                    {c.protocol} {c.hostname || c.address || 'Adresse Docker'}{' '}
                    {c.protocol !== 'ICMP' ? `:${c.port}` : ''}
                  </small>
                </td>
                <td>
                  {c.source.name} → {c.target.name}
                </td>
                <td>
                  <span className={`result-state ${run?.status}`}>
                    {resultLabels[run?.status] || 'Jamais testé'}
                  </span>
                  {run && <small>{new Date(run.startedAt).toLocaleString('fr-FR')}</small>}
                </td>
                <td>
                  <button disabled={run?.status === 'running'} onClick={() => onRun(c)}>
                    Diagnostiquer
                  </button>
                  <button onClick={() => onEdit(c)}>Modifier</button>
                  {run && <button onClick={() => onInspect(run)}>Preuves</button>}
                  <button disabled={run?.status === 'running'} onClick={() => onDelete(c)}>
                    Retirer
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!inventory.checks?.length && (
        <div className="empty-traffic">
          Ajoute une connexion attendue depuis « Nouveau contrôle ».
        </div>
      )}
    </div>
  );
}
export function RunDetails({ run: initial, runs, onRun, onCapture }) {
  const [run, setRun] = useState(initial),
    [error, setError] = useState('');
  useEffect(() => {
    setRun(initial);
    let active = true;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await workspaceApi(`/api/diagnostics/${initial.id}`);
        if (active) setRun(r);
        if (r.status !== 'running') clearInterval(timer);
      } catch (e) {
        if (active) setError(e.message);
      }
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [initial.id]);
  const previous = runs.find((r) => r.id === run.previousRunId);
  return (
    <>
      <div className="run-heading">
        <span className={`result-state ${run.status}`}>{resultLabels[run.status]}</span>
        <strong>{run.check.name}</strong>
      </div>
      <p>{run.summary}</p>
      <p className="field-hint">
        {run.check.source.name} → {run.check.target.name} ·{' '}
        {new Date(run.startedAt).toLocaleString('fr-FR')}
      </p>
      {previous && (
        <div className="run-comparison">
          <strong>Avant / après</strong>
          <span>
            {resultLabels[previous.status]} → {resultLabels[run.status]}
          </span>
          <small>{previous.summary}</small>
        </div>
      )}
      <div className="diagnostic-steps">
        {run.steps.map((s, i) => (
          <details key={i} open={s.status === 'failed' || s.status === 'inconclusive'}>
            <summary>
              <span className={`result-state ${s.status}`}>
                {resultLabels[s.status] || 'Observation'}
              </span>
              {s.message}
            </summary>
            <pre>{JSON.stringify(s.evidence, null, 2)}</pre>
            {previous?.steps.find((p) => p.kind === s.kind) && (
              <small>
                Avant :{' '}
                {resultLabels[previous.steps.find((p) => p.kind === s.kind).status] ||
                  'Observation'}
              </small>
            )}
          </details>
        ))}
      </div>
      {run.context && <p className="field-hint">{run.context}</p>}
      {run.suggestion && (
        <div className="workspace-notice">
          <strong>{run.suggestion.title}</strong>
          <p>{run.suggestion.text}</p>
        </div>
      )}
      <div className="workspace-actions">
        <button disabled={run.status === 'running'} onClick={() => onRun(run.check)}>
          <RefreshCw size={14} /> Refaire ce contrôle
        </button>
        {run.captureId && <button onClick={() => onCapture(run.captureId)}>Paquets et PCAP</button>}
        <button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
            );
            const a = document.createElement('a');
            a.href = url;
            a.download = `${run.id}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} /> Exporter le diagnostic
        </button>
      </div>
      {error && (
        <p role="alert" className="pdu-error">
          {error}
        </p>
      )}
    </>
  );
}
export function CaptureDetails({ id, onReplay }) {
  const [capture, setCapture] = useState(null),
    [packet, setPacket] = useState(null),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  useEffect(() => {
    let active = true;
    const read = () =>
      workspaceApi(`/api/captures/${id}`)
        .then((c) => {
          if (active) setCapture(c);
          if (c.status !== 'running') clearInterval(timer);
        })
        .catch((e) => active && setError(e.message));
    const timer = setInterval(read, 1500);
    read();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  if (!capture) return <p>{error || 'Lecture de la capture…'}</p>;
  if (packet)
    return (
      <>
        <button onClick={() => setPacket(null)}>Retour aux échanges</button>
        <PacketInspector
          packet={packet}
          packets={capture.packets.slice().reverse()}
          onSelect={setPacket}
          onReplay={onReplay}
        />
      </>
    );
  const packets = capture.packets
    .filter(
      (p) =>
        !filter ||
        `${p.source} ${p.target} ${p.protocol} ${p.info}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    )
    .slice()
    .reverse();
  return (
    <>
      <p>
        <strong>
          {capture.status === 'running'
            ? 'Capture active'
            : capture.status === 'completed'
              ? 'Capture terminée'
              : 'Capture interrompue'}
        </strong>{' '}
        · {capture.count} observations · {capture.targets.length} espace(s) réseau
      </p>
      <p className="field-hint">
        Durée maximale {capture.duration} s · Taille maximale 20 Mo · 600 dernières observations
        détaillées. Les observations des deux interfaces peuvent contenir des doublons.
      </p>
      {capture.runId && (
        <div className="workspace-notice">
          Les paquets compatibles avec les adresses, ports et dates du test restent des
          correspondances possibles : un trafic simultané peut utiliser la même connexion.
        </div>
      )}
      <div className="workspace-actions">
        {capture.status === 'running' && (
          <button
            onClick={async () => {
              try {
                setCapture(await workspaceApi(`/api/captures/${id}/stop`, {}));
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Arrêter la capture
          </button>
        )}
        {capture.files.map((f) => (
          <a className="outline-btn" href={`/api/captures/${id}/files/${f.index}`} key={f.index}>
            Télécharger PCAP · {capture.targets[f.index]?.name || f.hostId}
          </a>
        ))}
      </div>
      {capture.truncated && (
        <p className="pdu-error">Limite atteinte : cette capture n’est pas exhaustive.</p>
      )}
      {capture.errors.map((e, i) => (
        <p className="pdu-error" key={i}>
          {e}
        </p>
      ))}
      <input
        aria-label="Filtrer les observations"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="IP, protocole, contenu…"
      />
      <div className="capture-packets">
        <table className="packet-table">
          <thead>
            <tr>
              <th>Heure</th>
              <th>Source → destination</th>
              <th>Type</th>
              <th>Information</th>
            </tr>
          </thead>
          <tbody>
            {packets.map((p) => (
              <tr
                key={p.id}
                tabIndex={0}
                onClick={() => setPacket(p)}
                onKeyDown={(e) => e.key === 'Enter' && setPacket(p)}
              >
                <td>{new Date(p.time).toLocaleTimeString('fr-FR')}</td>
                <td>
                  {p.source} → {p.target}
                </td>
                <td>{p.protocol}</td>
                <td>
                  {p.info}
                  <small>
                    {p.association === 'compatible-ambiguous'
                      ? 'Compatible avec le test · attribution ambiguë'
                      : ''}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="pdu-error">{error}</p>}
    </>
  );
}
export function ContainerActions({
  container,
  onChanged,
  onCheck,
  onCapture,
  onReplayChecks,
  compact = false,
}) {
  const [logs, setLogs] = useState(null),
    [action, setAction] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const base = `/api/hosts/${container.hostId || 'local'}/containers/${container.dockerId || container.id}`;
  return (
    <div className="container-workspace-actions">
      {!compact && (
        <div className="workspace-actions">
          <button onClick={onCheck}>Créer un contrôle depuis ici</button>
          <button disabled={container.state !== 'running'} onClick={onCapture}>
            Capturer 30 s
          </button>
          <button
            onClick={async () => {
              try {
                setLogs((await workspaceApi(base + '/logs')).output);
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Logs
          </button>
        </div>
      )}
      <div className="workspace-actions">
        {['start', 'stop', 'restart'].map((a) => (
          <button
            disabled={
              busy ||
              container.stale ||
              (a === 'start' ? container.state === 'running' : container.state !== 'running')
            }
            key={a}
            onClick={() => setAction(a)}
          >
            {{ start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' }[a]}
          </button>
        ))}
      </div>
      {action && (
        <div className="workspace-notice">
          <strong>
            {{ start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' }[action]} {container.name}{' '}
            sur {container.hostName} ?
          </strong>
          <p>
            {action === 'start'
              ? 'Le conteneur existant sera démarré.'
              : 'Les connexions actives de ce conteneur seront interrompues.'}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await workspaceApi(base + '/action', {
                  action,
                  expectedName: container.name,
                });
                setAction(null);
                onChanged();
                onReplayChecks(r.checks);
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Appliquer à cet équipement
          </button>
          <button onClick={() => setAction(null)}>Annuler</button>
        </div>
      )}
      {logs !== null && (
        <details open>
          <summary>Derniers logs</summary>
          <pre className="container-logs">{logs || 'Aucun log.'}</pre>
        </details>
      )}
      {error && (
        <p className="pdu-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
