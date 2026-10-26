import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { disableIdleTimeout, requestTimeout } from './streams.mjs';
import { randomUUID } from 'node:crypto';
import { LABEL, attachedNetworks } from '../shared/model.mjs';
import { parsePacket, packetRoute, tsharkFields } from './packets.mjs';
import { createLabContainer, createLabNetwork } from './lab-config.mjs';
import { prepareStartup, verifyStartup } from './startup.mjs';

function connection() {
  let host = process.env.DOCKER_HOST;
  if (!host) {
    try {
      host = JSON.parse(
        execFileSync(
          'docker',
          ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
          { encoding: 'utf8', timeout: 4000, windowsHide: true },
        ),
      );
    } catch {}
  }
  if (host?.startsWith('unix://')) return { socketPath: host.slice(7) };
  if (host?.startsWith('npipe://')) return { socketPath: host.slice(8).replaceAll('\\', '/') };
  if (host?.startsWith('tcp://') || host?.startsWith('ssh://'))
    throw Error(
      'Utilise un contexte local pour le laboratoire. Ajoute les moteurs distants dans « Mes serveurs » avec un profil SSH.',
    );
  return {
    socketPath:
      process.platform === 'win32' ? '//./pipe/dockerDesktopLinuxEngine' : '/var/run/docker.sock',
  };
}
export const docker = new Docker({ ...connection(), timeout: 12000 });
const originalBuildRequest = docker.modem.buildRequest;
docker.modem.buildRequest = function (options, context, data, callback) {
  const scoped = Object.assign(Object.create(this), { timeout: requestTimeout(options) });
  return originalBuildRequest.call(scoped, options, context, data, callback);
};
export const CAPTURE_IMAGE = 'nicolaka/netshoot:v0.14';
const projectLabel = `${LABEL}.project`,
  nodeLabel = `${LABEL}.node`,
  roleLabel = `${LABEL}.role`;
const labels = (t, node, role) => ({ [projectLabel]: t.id, [nodeLabel]: node, [roleLabel]: role });
const filters = (t) => ({ label: [`${projectLabel}=${t.id}`] });
const resourceName = (t, n) => `dtr-${t.id}-${n.id}`;
export function friendlyError(e) {
  const message = e.json?.message || e.message || String(e);
  if (/ENOENT|ECONNREFUSED|connect ENOENT|pipe.*not find|socket hang up/i.test(message))
    return 'Docker est indisponible. Démarre Docker Desktop en mode conteneurs Linux, puis actualise.';
  return message;
}
export async function resources(t, engine = docker) {
  return {
    containers: await engine.listContainers({ all: true, filters: filters(t) }),
    networks: await engine.listNetworks({ filters: filters(t) }),
  };
}
export async function ownedContainer(t, id, engine = docker) {
  const list = await engine.listContainers({
    all: true,
    filters: { label: [`${projectLabel}=${t.id}`, `${nodeLabel}=${id}`, `${roleLabel}=node`] },
  });
  if (list.length !== 1) throw Error('Ce conteneur n’est pas déployé.');
  return engine.getContainer(list[0].Id);
}
export async function ensureImage(image, notify, engine = docker) {
  try {
    await engine.getImage(image).inspect();
    return;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  notify(`Téléchargement de ${image}…`);
  const stream = await engine.pull(image);
  await new Promise((resolve, reject) =>
    engine.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())),
  );
}
export async function deploy(t, notify, engine = docker) {
  const existing = await resources(t, engine);
  if (existing.containers.length || existing.networks.length)
    throw Error('Libère le déploiement existant avant de modifier sa topologie.');
  if (!t.nodes.some((n) => n.data.kind === 'container'))
    throw Error('Ajoute au moins un conteneur.');
  const createdContainers = [],
    createdNetworks = [],
    started = [];
  try {
    const info = await engine.info();
    if (info.OSType !== 'linux') throw Error('Ce laboratoire nécessite des conteneurs Linux.');
    for (const image of new Set(
      t.nodes.filter((n) => n.data.kind === 'container').map((n) => n.data.image),
    ))
      await ensureImage(image, notify, engine);
    await prepareStartup(
      engine,
      t.nodes.filter((n) => n.data.kind === 'container'),
      notify,
    );
    const networks = new Map();
    for (const n of t.nodes.filter((n) => n.data.kind === 'network')) {
      notify(`Création du réseau ${n.data.label}…`);
      const network = await createLabNetwork(engine, t, n);
      createdNetworks.push(network);
      networks.set(n.id, network.id);
    }
    for (const n of t.nodes.filter((n) => n.data.kind === 'container')) {
      notify(`Création de ${n.data.label}…`);
      const c = await createLabContainer(engine, t, n, networks, (c) => createdContainers.push(c));
      await c.start();
      started.push({ node: n, container: c });
    }
    const startupChecks = await verifyStartup(engine, t, started, notify);
    notify('Laboratoire déployé. Les contrôles de démarrage demandés sont terminés.');
    return { startupChecks };
  } catch (error) {
    const failures = [];
    for (const c of createdContainers.reverse())
      try {
        await c.remove({ force: true, v: false });
      } catch (e) {
        failures.push(friendlyError(e));
      }
    for (const n of createdNetworks.reverse())
      try {
        await n.remove();
      } catch (e) {
        failures.push(friendlyError(e));
      }
    if (failures.length)
      throw Object.assign(
        Error(`${friendlyError(error)}. Nettoyage partiel : ${failures.join('; ')}`),
        { startupChecks: error.startupChecks || [], rollback: 'partial' },
      );
    error.rollback = 'cleaned';
    throw error;
  }
}
export async function labAction(t, action, engine = docker) {
  const r = await resources(t, engine);
  const nodes = r.containers.filter((c) => c.Labels[roleLabel] === 'node');
  for (const c of nodes) {
    const container = engine.getContainer(c.Id);
    if (action === 'remove') await container.remove({ force: true, v: false });
    if (action === 'start' && c.State !== 'running') await container.start();
    if (action === 'stop' && c.State === 'running') await container.stop({ t: 3 });
  }
  if (action === 'remove') for (const n of r.networks) await engine.getNetwork(n.Id).remove();
}
const interfaceCaches = new WeakMap();
async function interfaceNames(t, id, info, engine) {
  if (!info.State.Running) return new Map();
  if (!interfaceCaches.has(engine)) interfaceCaches.set(engine, new Map());
  const interfaceCache = interfaceCaches.get(engine);
  const key = `${info.Id}:${info.State.StartedAt}:${JSON.stringify(info.NetworkSettings.Networks)}`;
  if (!interfaceCache.has(key)) {
    // Match Linux interface names to Docker endpoints by MAC, never by array order.
    // Minimal/distroless images may lack a shell; their IPs remain visible without a guessed name.
    const pending = execute(
      t,
      id,
      [
        '/bin/sh',
        '-c',
        'for f in /sys/class/net/*/address; do [ -r "$f" ] || continue; read -r mac < "$f"; name=${f%/address}; printf "%s %s\\n" "${name##*/}" "$mac"; done',
      ],
      engine,
    )
      .then(
        (result) =>
          new Map(
            result.exitCode === 0
              ? result.output
                  .trim()
                  .split(/\r?\n/)
                  .map((line) => line.trim().split(/\s+/))
                  .filter((parts) => parts.length === 2 && /^[0-9a-f:]{17}$/i.test(parts[1]))
                  .map(([name, mac]) => [mac.toLowerCase(), name])
              : [],
          ),
      )
      .catch(() => new Map());
    interfaceCache.set(key, pending);
    if (interfaceCache.size > 128) interfaceCache.delete(interfaceCache.keys().next().value);
  }
  return interfaceCache.get(key);
}
export async function runtime(t, engine = docker) {
  const version = await engine.version(),
    r = await resources(t, engine);
  const nodes = {},
    addressMap = new Map();
  await Promise.all(
    r.containers
      .filter((c) => c.Labels[roleLabel] === 'node')
      .map(async (c) => {
        const id = c.Labels[nodeLabel],
          container = engine.getContainer(c.Id),
          info = await container.inspect();
        const addresses = Object.values(info.NetworkSettings.Networks)
          .flatMap((n) => [n.IPAddress, n.GlobalIPv6Address])
          .filter(Boolean);
        const names = await interfaceNames(t, id, info, engine),
          interfaces = [];
        for (const [name, network] of Object.entries(info.NetworkSettings.Networks)) {
          const networkId = t.nodes.find(
            (n) => n.data.kind === 'network' && resourceName(t, n) === name,
          )?.id;
          if (networkId)
            interfaces.push({
              networkId,
              name: names.get(network.MacAddress?.toLowerCase()) || '',
              ip: network.IPAddress || network.GlobalIPv6Address || '',
              mac: network.MacAddress || '',
            });
          for (const ip of [network.IPAddress, network.GlobalIPv6Address].filter(Boolean))
            addressMap.set(ip, { nodeId: id, networkId });
        }
        let metrics = null;
        if (c.State === 'running')
          try {
            const s = await container.stats({ stream: false });
            const cpuDelta =
                s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage || 0),
              systemDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
            metrics = {
              memory: Math.max(
                0,
                (s.memory_stats.usage || 0) - (s.memory_stats.stats?.inactive_file || 0),
              ),
              cpu:
                systemDelta > 0
                  ? (cpuDelta / systemDelta) * (s.cpu_stats.online_cpus || 1) * 100
                  : 0,
              rx: Object.values(s.networks || {}).reduce((a, n) => a + n.rx_bytes, 0),
              tx: Object.values(s.networks || {}).reduce((a, n) => a + n.tx_bytes, 0),
            };
          } catch {}
        nodes[id] = {
          state: c.State,
          status: c.Status,
          addresses,
          interfaces,
          metrics,
          containerId: c.Id.slice(0, 12),
          id: c.Id,
          name: info.Name.replace(/^\//, ''),
          error: info.State.Error || '',
          ports: (c.Ports || [])
            .filter((p) => p.PublicPort)
            .map((p) => ({
              host: p.PublicPort,
              container: p.PrivatePort,
              protocol: p.Type,
              hostIp: p.IP,
            })),
        };
      }),
  );
  return {
    connected: true,
    version: version.Version,
    os: version.Os,
    nodes,
    deployed: r.containers.length > 0 || r.networks.length > 0,
    addressMap,
    networks: r.networks.map((n) => ({
      nodeId: n.Labels[nodeLabel],
      subnet: n.IPAM?.Config?.[0]?.Subnet || '',
      containers: Object.keys(n.Containers || {}).length,
    })),
  };
}
export { decodeDockerLog } from './streams.mjs';
export async function execute(t, id, cmd, engine = docker) {
  const container = await ownedContainer(t, id, engine);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  // A command has its own wall-clock deadline below, not an idle-socket timeout.
  disableIdleTimeout(stream);
  const out = new PassThrough(),
    err = new PassThrough();
  engine.modem.demuxStream(stream, out, err);
  let output = '';
  const collect = (b) => {
    output = (output + b.toString()).slice(-48000);
  };
  out.on('data', collect);
  err.on('data', collect);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(
        Error('La commande dépasse 20 secondes. Le processus peut continuer dans le conteneur.'),
      );
    }, 20000);
    stream.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const result = await exec.inspect();
  return { output, exitCode: result.ExitCode };
}
export class CaptureManager {
  constructor(emit, engine = docker) {
    this.engine = engine;
    this.emit = emit;
    this.sessions = [];
    this.sequence = 0;
    this.sessionId = randomUUID();
    this.active = false;
    this.addressMap = new Map();
    this.recent = new Map();
  }
  async start(t, addressMap) {
    if (this.active) return;
    await this.stop(t);
    const list = (await resources(t, this.engine)).containers.filter(
      (c) => c.Labels[roleLabel] === 'node' && c.State === 'running',
    );
    if (!list.length) throw Error('Démarre au moins un conteneur pour capturer le trafic.');
    await ensureImage(
      CAPTURE_IMAGE,
      (message) => this.emit({ type: 'notice', message }),
      this.engine,
    );
    this.addressMap = addressMap;
    this.recent.clear();
    try {
      for (const c of list) {
        const nodeId = c.Labels[nodeLabel];
        const args = [
          'tshark',
          '-l',
          '-n',
          '-i',
          'any',
          '-T',
          'fields',
          '-E',
          'separator=/t',
          '-E',
          'occurrence=f',
          ...tsharkFields.flatMap((f) => ['-e', f]),
        ];
        const cap = await this.engine.createContainer({
          name: `dtr-${t.id}-capture-${nodeId}`,
          Image: CAPTURE_IMAGE,
          Entrypoint: args,
          Cmd: [],
          Labels: labels(t, nodeId, 'capture'),
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          HostConfig: {
            NetworkMode: `container:${c.Id}`,
            CapAdd: ['NET_RAW', 'NET_ADMIN'],
            Memory: 192 * 1024 * 1024,
            NanoCpus: 500000000,
            PidsLimit: 64,
            AutoRemove: false,
          },
        });
        const session = { container: cap, stream: null };
        this.sessions.push(session);
        const stream = await cap.attach({ stream: true, stdout: true, stderr: true });
        // An idle capture is healthy. Do not close it after the regular API timeout.
        disableIdleTimeout(stream);
        session.stream = stream;
        const out = new PassThrough(),
          err = new PassThrough();
        this.engine.modem.demuxStream(stream, out, err);
        let pending = '',
          stderr = '';
        const ready = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error(`La capture sur ${nodeId} ne démarre pas : ${stderr.slice(-400)}`)),
            12000,
          );
          err.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-4000);
            if (/Capturing on|Capture started|File:/.test(stderr)) {
              clearTimeout(timer);
              resolve();
            }
          });
          stream.on('end', () => {
            clearTimeout(timer);
            reject(Error(`Capture interrompue sur ${nodeId} : ${stderr.slice(-400)}`));
            if (this.active) {
              this.active = false;
              this.emit({
                type: 'capture',
                active: false,
                message: 'Une sonde de capture s’est arrêtée. Relance la capture.',
              });
            }
          });
          stream.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          stream.on('close', () => {
            clearTimeout(timer);
            reject(Error(`La connexion à la sonde ${nodeId} a été fermée.`));
            if (this.active) {
              this.active = false;
              this.emit({
                type: 'capture',
                active: false,
                message: 'Connexion à une sonde perdue. Relance la capture.',
              });
            }
          });
        });
        // Attach a rejection handler before starting the container.
        ready.catch(() => {});
        out.on('data', (chunk) => {
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop().slice(-65536);
          for (const line of lines) {
            const p = parsePacket(
              line,
              nodeId,
              this.addressMap,
              `${this.sessionId}-${++this.sequence}`,
            );
            if (!p) continue;
            // Prefer the source endpoint's observation. Keep incoming external packets.
            if (p.sourceNode && p.sourceNode !== nodeId) continue;
            const key = [p.time, p.source, p.target, p.bytes, p.info].join('|');
            if (this.recent.has(key)) continue;
            this.recent.set(key, true);
            if (this.recent.size > 2048) this.recent.delete(this.recent.keys().next().value);
            p.route = packetRoute(t, p);
            this.emit({ type: 'packet', packet: p });
          }
        });
        await cap.start();
        await ready;
        // TShark announces "Capturing on" before libpcap has finished opening its
        // packet socket. Verify the socket before reporting this probe as ready.
        const readiness = await cap.exec({
          Cmd: [
            'sh',
            '-c',
            'for i in $(seq 1 50); do if [ "$(wc -l < /proc/net/packet)" -gt 1 ]; then exit 0; fi; sleep 0.1; done; exit 1',
          ],
          AttachStdout: true,
          AttachStderr: true,
        });
        const readinessStream = await readiness.start({ hijack: true, stdin: false });
        readinessStream.resume();
        await new Promise((resolve, reject) => {
          readinessStream.once('end', resolve);
          readinessStream.once('error', reject);
        });
        if ((await readiness.inspect()).ExitCode !== 0)
          throw Error(`La sonde ${nodeId} n’a pas ouvert son interface réseau.`);
      }
      this.active = true;
      this.emit({
        type: 'capture',
        active: true,
        message: `Capture active sur ${list.length} conteneurs.`,
      });
    } catch (e) {
      await this.stop(t);
      throw e;
    }
  }
  async stop(t) {
    this.active = false;
    const sessions = this.sessions.splice(0);
    for (const s of sessions) {
      s.stream?.destroy();
      try {
        await s.container.remove({ force: true });
      } catch (e) {
        if (e.statusCode !== 404) throw e;
      }
    }
    // Recover orphan probes after an application restart.
    const stale = await this.engine.listContainers({
      all: true,
      filters: { label: [`${projectLabel}=${t.id}`, `${roleLabel}=capture`] },
    });
    for (const c of stale)
      try {
        await this.engine.getContainer(c.Id).remove({ force: true });
      } catch (e) {
        if (e.statusCode !== 404) throw e;
      }
    this.emit({ type: 'capture', active: false });
  }
}
