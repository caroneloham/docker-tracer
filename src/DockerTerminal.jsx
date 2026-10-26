import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Copy,
  ClipboardPaste,
  Eraser,
  Maximize2,
  Minimize2,
  RefreshCw,
  Square,
  CornerDownRight,
} from 'lucide-react';
import './docker-terminal.css';

const phases = {
  loading: 'Chargement du terminal…',
  idle: 'Prêt à ouvrir',
  connecting: 'Connexion…',
  connected: 'Connecté',
  closed: 'Session terminée',
  stopped: 'Conteneur arrêté',
  error: 'Connexion interrompue',
};
const MAX_INPUT = 8192;
const fallbackShells = [
  { path: '/bin/sh', label: 'Sh' },
  { path: '/bin/bash', label: 'Bash' },
];
const encoder = new TextEncoder();
const decodeOutput = (data) =>
  typeof data.dataBase64 === 'string'
    ? Uint8Array.from(atob(data.dataBase64), (character) => character.charCodeAt(0))
    : data.output || '';
function firstInputChunk(value) {
  let end = 0,
    bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (bytes + size > MAX_INPUT) break;
    bytes += size;
    end += character.length;
  }
  return [value.slice(0, end), value.slice(end)];
}
async function request(url, { method = 'GET', body, keepalive = false } = {}) {
  const response = await fetch(url, {
    method,
    keepalive,
    headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === 'DELETE' && response.status === 404) return {};
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('Le serveur Docker Tracer ne répond pas correctement.');
  }
  if (!response.ok) throw Error(data.error || 'Connexion au terminal impossible.');
  return data;
}

const DockerTerminal = forwardRef(function DockerTerminal(props, ref) {
  const id = props.container.dockerId || props.container.id;
  return (
    <DockerTerminalPanel key={`${props.container.hostId || 'local'}:${id}`} {...props} ref={ref} />
  );
});
export default DockerTerminal;

const DockerTerminalPanel = forwardRef(function DockerTerminalPanel(
  { container, active = true, autoConnect = true, compact = false },
  ref,
) {
  const id = container.dockerId || container.id,
    hostId = container.hostId || 'local';
  const api = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(id)}/workbench/terminal`;
  const viewport = useRef(null),
    controls = useRef(null),
    scopeRef = useRef(null);
  const current = useRef({ active, autoConnect, container });
  current.current = { active, autoConnect, container };
  const [phase, setPhase] = useState('loading'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [shell, setShell] = useState('/bin/sh'),
    [availableShells, setAvailableShells] = useState(fallbackShells),
    [expanded, setExpanded] = useState(false);
  const shellRef = useRef(shell);
  shellRef.current = shell;
  useImperativeHandle(
    ref,
    () => ({
      close: () => scopeRef.current?.close() || Promise.resolve(),
      focus: () => scopeRef.current?.terminal?.focus(),
    }),
    [],
  );

  useEffect(() => {
    const scope = {
      disposed: false,
      ready: false,
      autoAttempted: false,
      generation: 0,
      sessionId: null,
      knownSessions: new Set(),
      opening: null,
      terminal: null,
      fit: null,
      pollTimer: null,
      polling: false,
      inputTimer: null,
      input: '',
      sending: false,
      resizeTimer: null,
      resizing: false,
      pendingSize: null,
      observer: null,
      frame: null,
      cursor: 0,
      shellsLoaded: false,
    };
    scopeRef.current = scope;
    const update = (next, message = '') => {
      if (scope.disposed) return;
      setPhase(next);
      setError(message);
      if (scope.terminal) scope.terminal.options.disableStdin = next !== 'connected';
    };
    const info = (message) => {
      if (!scope.disposed) setNotice(message);
    };
    const deleteSession = async (sessionId, keepalive = false) => {
      await request(`${api}/${sessionId}`, { method: 'DELETE', keepalive });
      scope.knownSessions.delete(sessionId);
    };
    const stopTimers = () => {
      clearTimeout(scope.pollTimer);
      clearTimeout(scope.inputTimer);
      clearTimeout(scope.resizeTimer);
      scope.pollTimer = null;
      scope.inputTimer = null;
      scope.resizeTimer = null;
      scope.input = '';
      scope.pendingSize = null;
    };
    scope.close = async (keepalive = false) => {
      scope.generation++;
      scope.autoAttempted = true;
      scope.sessionId = null;
      stopTimers();
      update('closed');
      // An opening request is deliberately not aborted: its eventual ID is
      // needed to close the late session, including StrictMode cleanup races.
      const opening = scope.opening;
      const closed = await Promise.allSettled(
        [...scope.knownSessions].map((sessionId) => deleteSession(sessionId, keepalive)),
      );
      if (opening) await opening;
      const failure = closed.find((result) => result.status === 'rejected');
      if (failure) {
        update('error', failure.reason.message);
        throw failure.reason;
      }
    };
    const flushInput = async () => {
      if (scope.sending || scope.disposed || !scope.sessionId) return;
      scope.sending = true;
      const sessionId = scope.sessionId,
        generation = scope.generation;
      try {
        while (
          scope.input &&
          !scope.disposed &&
          scope.sessionId === sessionId &&
          scope.generation === generation
        ) {
          const [data, rest] = firstInputChunk(scope.input);
          scope.input = rest;
          await request(`${api}/${sessionId}/input`, { method: 'POST', body: { data } });
        }
      } catch (error) {
        if (!scope.disposed && scope.generation === generation) {
          scope.input = '';
          update(
            'error',
            `L’envoi n’a pas pu être confirmé. Vérifie la sortie avant de reconnecter : ${error.message}`,
          );
        }
      } finally {
        scope.sending = false;
        if (scope.input && scope.sessionId && !scope.disposed && !scope.inputTimer)
          scope.inputTimer = setTimeout(() => {
            scope.inputTimer = null;
            flushInput();
          }, 20);
      }
    };
    const enqueue = (data) => {
      if (scope.disposed || !scope.sessionId || scope.terminal?.options.disableStdin) return;
      if (scope.input.length + data.length > 256 * 1024) {
        info('Collage trop volumineux : limite de 256 Kio de texte en attente.');
        return;
      }
      scope.input += data;
      if (scope.inputTimer) return;
      scope.inputTimer = setTimeout(() => {
        scope.inputTimer = null;
        flushInput();
      }, 20);
    };
    scope.interrupt = () => {
      enqueue('\x03');
      scope.terminal?.focus();
    };
    scope.complete = () => {
      // Exactly the same byte as the physical Tab key. The real shell decides
      // what to complete, including paths, quoting, commands and current cwd.
      enqueue('\t');
      scope.terminal?.focus();
    };
    const flushResize = async () => {
      if (scope.resizing || scope.disposed || !scope.sessionId) return;
      scope.resizing = true;
      const sessionId = scope.sessionId,
        generation = scope.generation;
      try {
        while (
          scope.pendingSize &&
          scope.sessionId === sessionId &&
          scope.generation === generation &&
          !scope.disposed
        ) {
          const size = scope.pendingSize;
          scope.pendingSize = null;
          await request(`${api}/${sessionId}/resize`, { method: 'POST', body: size });
        }
      } catch (error) {
        if (!scope.disposed && scope.generation === generation)
          info(`Redimensionnement impossible : ${error.message}`);
      } finally {
        scope.resizing = false;
        if (scope.pendingSize && scope.sessionId && !scope.disposed)
          scope.resizeTimer = setTimeout(flushResize, 80);
      }
    };
    const resize = ({ cols, rows }) => {
      scope.pendingSize = { cols, rows };
      clearTimeout(scope.resizeTimer);
      scope.resizeTimer = setTimeout(flushResize, 80);
    };
    scope.fitNow = () => {
      if (
        scope.disposed ||
        !scope.ready ||
        !current.current.active ||
        !viewport.current?.clientWidth ||
        !viewport.current?.clientHeight
      )
        return;
      const dimensions = scope.fit.proposeDimensions();
      if (!dimensions) return;
      const cols = Math.max(20, Math.min(400, dimensions.cols)),
        rows = Math.max(5, Math.min(160, dimensions.rows));
      if (scope.terminal.cols !== cols || scope.terminal.rows !== rows)
        scope.terminal.resize(cols, rows);
    };
    const poll = async () => {
      if (scope.disposed || !scope.sessionId || scope.polling) return;
      scope.polling = true;
      const sessionId = scope.sessionId,
        generation = scope.generation;
      let repeat = true;
      try {
        const data = await request(`${api}/${sessionId}?cursor=${scope.cursor}`);
        if (scope.disposed || scope.sessionId !== sessionId || scope.generation !== generation)
          return;
        if (data.truncated) {
          scope.terminal.reset();
          info(
            'Une partie de la sortie a dépassé la mémoire du serveur. Les derniers 128 Kio restent disponibles.',
          );
        }
        const output = decodeOutput(data);
        if (output.length) await new Promise((resolve) => scope.terminal.write(output, resolve));
        if (scope.disposed || scope.generation !== generation) return;
        scope.cursor = data.cursor;
        if (data.closed) {
          repeat = false;
          scope.sessionId = null;
          scope.input = '';
          update('closed');
          info(data.reason || 'Le shell a quitté la session.');
          deleteSession(sessionId).catch(() => {});
        }
      } catch (error) {
        if (!scope.disposed && scope.generation === generation) {
          repeat = false;
          update('error', error.message);
        }
      } finally {
        scope.polling = false;
        if (
          !scope.disposed &&
          scope.sessionId &&
          (scope.sessionId !== sessionId || scope.generation !== generation)
        ) {
          scope.wakePoll();
          return;
        }
        if (
          repeat &&
          !scope.disposed &&
          scope.sessionId === sessionId &&
          scope.generation === generation
        )
          scope.pollTimer = setTimeout(
            poll,
            current.current.active && document.visibilityState === 'visible' ? 150 : 1000,
          );
      }
    };
    scope.wakePoll = () => {
      clearTimeout(scope.pollTimer);
      if (!scope.polling) scope.pollTimer = setTimeout(poll, 0);
    };
    scope.connect = () => {
      if (scope.disposed || !scope.ready || scope.opening) return scope.opening;
      if (current.current.container.state !== 'running') {
        update('stopped');
        return;
      }
      const generation = ++scope.generation;
      scope.autoAttempted = true;
      scope.sessionId = null;
      stopTimers();
      update('connecting');
      info('');
      const work = Promise.resolve().then(async () => {
        try {
          await Promise.all([...scope.knownSessions].map((sessionId) => deleteSession(sessionId)));
          if (scope.disposed || scope.generation !== generation) return;
          let discovered = null;
          try {
            discovered = await request(
              `${api}/shells?expectedName=${encodeURIComponent(current.current.container.name)}`,
            );
          } catch {
            info('Détection des shells indisponible. Essaie Sh ou Bash.');
          }
          if (scope.disposed || scope.generation !== generation) return;
          if (discovered) {
            setAvailableShells(discovered.shells);
            if (!discovered.shells.length)
              throw Error(
                'Aucun shell détecté dans cette image. Les fichiers restent accessibles.',
              );
            if (
              !scope.shellsLoaded ||
              !discovered.shells.some((choice) => choice.path === shellRef.current)
            ) {
              shellRef.current = discovered.preferred;
              setShell(discovered.preferred);
            }
            scope.shellsLoaded = true;
          }
          scope.fitNow();
          const next = await request(api, {
            method: 'POST',
            body: {
              expectedName: current.current.container.name,
              shell: shellRef.current,
              cols: scope.terminal.cols,
              rows: scope.terminal.rows,
            },
          });
          scope.knownSessions.add(next.id);
          if (
            scope.disposed ||
            scope.generation !== generation ||
            current.current.container.state !== 'running'
          ) {
            await deleteSession(next.id, true);
            return;
          }
          scope.sessionId = next.id;
          scope.cursor = 0;
          scope.terminal.reset();
          update('connected');
          resize({ cols: scope.terminal.cols, rows: scope.terminal.rows });
          scope.wakePoll();
          if (current.current.active) scope.terminal.focus();
        } catch (error) {
          if (!scope.disposed && scope.generation === generation) update('error', error.message);
        } finally {
          if (scope.opening === work) scope.opening = null;
        }
      });
      scope.opening = work;
      return work;
    };
    scope.maybeConnect = () => {
      if (
        scope.ready &&
        current.current.active &&
        current.current.autoConnect &&
        !scope.autoAttempted &&
        current.current.container.state === 'running'
      )
        scope.connect();
    };
    scope.copy = async () => {
      const text = scope.terminal?.getSelection();
      if (!text) {
        info('Sélectionne le texte du terminal à copier.');
        return;
      }
      if (!navigator.clipboard?.writeText) {
        info('Le presse-papiers n’est pas disponible dans ce navigateur.');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        info('Sélection copiée.');
      } catch {
        info('Le navigateur a refusé l’accès au presse-papiers.');
      }
    };
    scope.paste = async () => {
      if (!navigator.clipboard?.readText) {
        info('Le presse-papiers n’est pas disponible. Utilise le menu Coller du navigateur.');
        return;
      }
      const generation = scope.generation;
      try {
        const text = await navigator.clipboard.readText();
        if (
          !scope.disposed &&
          scope.generation === generation &&
          scope.sessionId &&
          !scope.terminal.options.disableStdin
        ) {
          scope.terminal.paste(text);
          scope.terminal.focus();
        }
      } catch {
        info('Le navigateur a refusé la lecture du presse-papiers. Utilise son menu Coller.');
      }
    };
    const visibility = () => {
      if (current.current.active && document.visibilityState === 'visible') {
        scope.fitNow();
        scope.wakePoll();
      }
    };
    const pagehide = () => {
      scope.close(true).catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    (async () => {
      try {
        const [terminalModule, fitModule] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/xterm/css/xterm.css'),
        ]);
        if (scope.disposed) return;
        const Terminal = terminalModule.Terminal || terminalModule.default?.Terminal,
          FitAddon = fitModule.FitAddon || fitModule.default?.FitAddon;
        const term = new Terminal({
          cols: 80,
          rows: 24,
          cursorBlink: true,
          cursorStyle: 'block',
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: compact ? 13 : 14,
          lineHeight: 1.15,
          scrollback: 3000,
          convertEol: false,
          disableStdin: true,
          allowProposedApi: false,
          screenReaderMode: true,
          theme: {
            background: '#102332',
            foreground: '#e2edf4',
            cursor: '#74e0c9',
            selectionBackground: '#3e687e',
            black: '#152c3c',
            red: '#ef7e83',
            green: '#7cd6a2',
            yellow: '#ecd18c',
            blue: '#74adf0',
            magenta: '#d7a7ec',
            cyan: '#7bd4dc',
            white: '#e2edf4',
          },
        });
        scope.terminal = term;
        scope.fit = new FitAddon();
        term.loadAddon(scope.fit);
        term.open(viewport.current);
        term.textarea?.setAttribute('aria-label', `Terminal Docker · ${container.name}`);
        term.onData(enqueue);
        term.onResize(resize);
        term.attachCustomKeyEventHandler((event) => {
          if (event.type !== 'keydown') return true;
          if (event.ctrlKey && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key.toLowerCase() === 'c') scope.copy();
            else scope.paste();
            return false;
          }
          event.stopPropagation();
          return true;
        });
        scope.ready = true;
        update(current.current.container.state === 'running' ? 'idle' : 'stopped');
        scope.observer = new ResizeObserver(() => {
          cancelAnimationFrame(scope.frame);
          scope.frame = requestAnimationFrame(scope.fitNow);
        });
        scope.observer.observe(viewport.current);
        scope.fitNow();
        scope.maybeConnect();
      } catch (error) {
        update('error', `Impossible de charger le terminal : ${error.message}`);
      }
    })();
    return () => {
      scope.disposed = true;
      scope.close(true).catch(() => {});
      scope.observer?.disconnect();
      cancelAnimationFrame(scope.frame);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      scope.terminal?.dispose();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [api]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    if (container.state !== 'running') {
      if (scope.sessionId || scope.opening) scope.close().catch(() => {});
      if (scope.ready) setPhase('stopped');
      return;
    }
    scope.maybeConnect();
    if (active) {
      const frame = requestAnimationFrame(() => {
        scope.fitNow();
        if (scope.sessionId) scope.terminal?.focus();
        scope.wakePoll();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [active, autoConnect, container.state, expanded]);

  const isConnected = phase === 'connected',
    isWorking = phase === 'loading' || phase === 'connecting';
  return (
    <section
      hidden={!active}
      className={`docker-terminal${compact ? ' docker-terminal-compact' : ''}${expanded ? ' docker-terminal-expanded' : ''}`}
      aria-label={`Terminal de ${container.name}`}
    >
      <div className="docker-terminal-toolbar" ref={controls}>
        <span className={`docker-terminal-status ${phase}`} role="status">
          <i />
          {phases[phase]}
        </span>
        <label>
          Shell{' '}
          <select
            aria-label="Shell du terminal"
            value={shell}
            disabled={isWorking || isConnected || !availableShells.length}
            title={
              isConnected
                ? 'Ferme la session pour choisir un autre shell.'
                : 'Shells présents dans le conteneur'
            }
            onChange={(event) => setShell(event.target.value)}
          >
            {!availableShells.length && <option value={shell}>Aucun shell détecté</option>}
            {availableShells.map((choice) => (
              <option key={choice.path} value={choice.path}>
                {choice.label} · {choice.path}
              </option>
            ))}
          </select>
        </label>
        <div className="docker-terminal-actions">
          <button
            type="button"
            disabled={!isConnected}
            onClick={() => scopeRef.current?.complete()}
            title="Envoyer Tab au shell pour compléter la commande ou le chemin"
            aria-label="Compléter avec Tab"
          >
            <CornerDownRight size={14} /> Tab
          </button>
          <button
            type="button"
            disabled={!isConnected}
            onClick={() => scopeRef.current?.interrupt()}
            title="Interrompre la commande en cours · Ctrl+C"
          >
            Interrompre
          </button>
          <button
            type="button"
            disabled={isWorking || container.state !== 'running'}
            onClick={() => scopeRef.current?.connect()}
            title="Ouvrir une nouvelle session shell"
          >
            <RefreshCw size={14} />
            {isConnected ? 'Reconnecter' : 'Ouvrir'}
          </button>
          <button
            type="button"
            disabled={!isConnected}
            onClick={() => scopeRef.current?.close().catch((error) => setError(error.message))}
            title="Fermer la session shell"
          >
            <Square size={13} />
            <span>Fermer</span>
          </button>
          <button
            type="button"
            onClick={() => {
              scopeRef.current?.terminal?.clear();
              scopeRef.current?.terminal?.focus();
            }}
            title="Effacer l’affichage du terminal"
            aria-label="Effacer l’affichage"
          >
            <Eraser size={15} />
          </button>
          <button
            type="button"
            onClick={() => scopeRef.current?.copy()}
            title="Copier la sélection · Ctrl+Maj+C"
            aria-label="Copier la sélection du terminal"
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            disabled={!isConnected}
            onClick={() => scopeRef.current?.paste()}
            title="Coller · Ctrl+Maj+V"
            aria-label="Coller dans le terminal"
          >
            <ClipboardPaste size={15} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? 'Réduire le terminal' : 'Agrandir le terminal'}
            aria-label={expanded ? 'Réduire le terminal' : 'Agrandir le terminal'}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>
      {error && (
        <p className="docker-terminal-message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="docker-terminal-message" role="status">
          {notice}
        </p>
      )}
      {phase === 'stopped' && (
        <p className="docker-terminal-message">Démarre le conteneur pour ouvrir son terminal.</p>
      )}
      <div
        ref={viewport}
        className="docker-terminal-screen"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) scopeRef.current?.terminal?.focus();
        }}
      />
      <div className="docker-terminal-footer">
        <span>Tab complète · ↑ ↓ historique · Ctrl+C interrompt</span>
        <span>Copier / coller : Ctrl+Maj+C / V · Session 15 min max.</span>
        <details className="docker-terminal-help">
          <summary>Aide Tab</summary>
          <p>
            Commence une commande ou un chemin, puis appuie sur Tab. Deux appuis affichent les choix
            si le shell le permet. La complétion dépend du shell installé et de sa configuration.
            Maj+Tab reste transmis tel quel.
          </p>
        </details>
      </div>
    </section>
  );
});
