import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { disableIdleTimeout } from './streams.mjs';
import { captureSchema, resolveResource, resourceRef } from '../shared/workspace.mjs';
import { parsePacket, packetRoute, tsharkFields } from './packets.mjs';
import {
  TOOL_IMAGE,
  ensureToolImage,
  archiveFile,
  execTool,
  observerLabels,
  removeHelper,
} from './engine-tools.mjs';

export const CAPTURE_LIMIT = 20 * 1048576;
export function observationFlow(p) {
  return [p.hostId, p.source, p.target, p.sourcePort, p.targetPort, p.protocol].join('|');
}
export class TargetCaptures {
  constructor(store, hosts, emit) {
    this.store = store;
    this.hosts = hosts;
    this.emit = emit;
    this.active = new Map();
    this.starting = 0;
    this.dir = path.join(store.dir, 'captures');
  }
  list() {
    return this.store
      .read((s) =>
        s.captures.map((c) => {
          const r = this.active.get(c.id)?.record || c;
          return { ...r, packets: undefined };
        }),
      )
      .reverse();
  }
  get(id) {
    const r =
      this.active.get(id)?.record || this.store.read((s) => s.captures.find((c) => c.id === id));
    if (!r) throw Object.assign(Error('Capture inconnue.'), { statusCode: 404 });
    return r;
  }
  async pruneFiles() {
    await mkdir(this.dir, { recursive: true });
    const keep = new Set(
      this.store
        .read()
        .captures.flatMap((c) => c.files || [])
        .map((f) => f.filename),
    );
    for (const f of await readdir(this.dir))
      if (/^capture-[a-z0-9-]+-\d+\.pcap$/.test(f) && !keep.has(f))
        await unlink(path.join(this.dir, f));
  }
  async start(input) {
    const options = captureSchema.parse(input);
    if (this.active.size >= 3)
      throw Object.assign(Error('Maximum de trois captures simultanées.'), { statusCode: 409 });
    this.starting++;
    const record = {
      id: `capture-${randomUUID()}`,
      hostId: options.targets[0].hostId,
      runId: options.runId || null,
      startedAt: Date.now(),
      status: 'running',
      duration: options.duration,
      limitBytes: CAPTURE_LIMIT,
      snapLength: 0,
      targets: [],
      packets: [],
      flows: [],
      count: 0,
      files: [],
      errors: [],
      truncated: false,
      filter: options.port ? `port ${options.port} or icmp or arp` : '',
    };
    const session = {
      record,
      probes: [],
      seen: new Set(),
      sequence: 0,
      timer: null,
      updateTimer: null,
      pending: false,
      stopping: null,
    };
    try {
      // Reserve before awaiting I/O so concurrency is bounded even during slow image pulls.
      this.active.set(record.id, session);
      await this.store.mutate((s) => {
        s.captures.push(structuredClone(record));
      });
      const namespaces = new Set();
      for (const ref of options.targets) {
        const inventory = await this.hosts.inventory(ref.hostId),
          target = resolveResource(ref, inventory),
          docker = await this.hosts.client(ref.hostId);
        const targetInfo = await docker.getContainer(target.id).inspect();
        if (!targetInfo.State.Running)
          throw Error(`${target.name} doit être démarré pour capturer.`);
        const namespace = targetInfo.HostConfig.NetworkMode.startsWith('container:')
          ? targetInfo.HostConfig.NetworkMode.slice(10)
          : target.id;
        const nsKey = `${ref.hostId}:${namespace}`;
        if (namespaces.has(nsKey)) continue;
        namespaces.add(nsKey);
        record.targets.push(resourceRef(ref.hostId, target));
        await ensureToolImage(docker);
        const map = new Map(),
          ambiguous = new Set();
        for (const c of inventory.containers.filter((c) => !c.isProbe))
          for (const a of c.attachments)
            for (const ip of [a.ip, a.ipv6])
              if (ip) {
                if (map.has(ip) && map.get(ip).nodeId !== `${ref.hostId}:${c.id}`)
                  ambiguous.add(ip);
                map.set(ip, {
                  nodeId: `${ref.hostId}:${c.id}`,
                  networkId: `${ref.hostId}:${a.networkId}`,
                });
              }
        for (const ip of ambiguous) map.delete(ip);
        const topology = {
          edges: inventory.links.map((e) => ({
            id: `${ref.hostId}:${e.id}`,
            source: `${ref.hostId}:${e.source.slice(2)}`,
            target: `${ref.hostId}:${e.target.slice(2)}`,
          })),
        };
        const args = [
          'tshark',
          '-l',
          '-n',
          '-i',
          'any',
          '-s',
          '0',
          '-a',
          `duration:${options.duration}`,
          '-a',
          `filesize:${Math.floor(19000 / options.targets.length)}`,
          '-w',
          '/tmp/trace.pcap',
          '-F',
          'pcap',
          '-P',
          '-T',
          'fields',
          '-E',
          'separator=/t',
          '-E',
          'occurrence=f',
          ...tsharkFields.flatMap((f) => ['-e', f]),
          ...(record.filter ? ['-f', record.filter] : []),
        ];
        const container = await docker.createContainer({
          name: `dtr-observe-${record.id.slice(8)}-${session.probes.length}`,
          Image: TOOL_IMAGE,
          Entrypoint: args,
          Cmd: [],
          Labels: observerLabels(
            'observer',
            record.id,
            ref.hostId,
            this.store.read((s) => s.instanceId),
          ),
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          HostConfig: {
            NetworkMode: `container:${target.id}`,
            CapDrop: ['ALL'],
            CapAdd: ['NET_RAW', 'NET_ADMIN'],
            Memory: 192 * 1048576,
            NanoCpus: 500000000,
            PidsLimit: 64,
          },
        });
        const probe = {
          container,
          docker,
          hostId: ref.hostId,
          targetId: target.id,
          stream: null,
          stderr: '',
          ended: false,
        };
        session.probes.push(probe);
        const stream = await container.attach({ stream: true, stdout: true, stderr: true });
        probe.stream = stream;
        disableIdleTimeout(stream);
        const out = new PassThrough(),
          err = new PassThrough();
        let pending = '';
        err.on('data', (b) => {
          probe.stderr = (probe.stderr + b.toString()).slice(-3000);
        });
        out.on('data', (b) => {
          pending += b.toString();
          const lines = pending.split('\n');
          pending = lines.pop().slice(-65536);
          for (const line of lines) {
            const p = parsePacket(line, `${ref.hostId}:${target.id}`, map, ++session.sequence);
            if (!p) continue;
            const k = [ref.hostId, p.time, p.source, p.target, p.bytes, p.info].join('|');
            if (session.seen.has(k)) continue;
            session.seen.add(k);
            if (session.seen.size > 4096) session.seen.delete(session.seen.values().next().value);
            Object.assign(p, {
              id: `${record.id}-${session.sequence}`,
              hostId: ref.hostId,
              captureId: record.id,
              runId: record.runId,
              route: packetRoute(topology, p),
              association: record.runId ? 'candidate' : 'observation',
            });
            record.count++;
            record.packets = [...record.packets, p].slice(-600);
            const key = observationFlow(p);
            let flow = record.flows.find((f) => f.key === key);
            if (!flow && record.flows.length < 300) {
              flow = {
                key,
                hostId: ref.hostId,
                source: p.sourceNode,
                target: p.targetNode,
                sourceAddress: p.source,
                targetAddress: p.target,
                protocol: p.protocol,
                sourcePort: p.sourcePort,
                targetPort: p.targetPort,
                count: 0,
                bytes: 0,
                firstAt: p.time,
              };
              record.flows.push(flow);
            }
            if (flow) {
              flow.count++;
              flow.bytes += p.bytes;
              flow.lastAt = p.time;
              flow.packet = p;
            } else record.truncated = true;
            session.pending = true;
          }
        });
        stream.on('error', (e) => {
          record.errors.push(e.message);
          this.stop(record.id, 'interrupted').catch(() => {});
        });
        stream.on('end', () => {
          probe.ended = true;
          if (session.probes.length === namespaces.size && record.ready && !session.stopping)
            this.stop(record.id).catch(() => {});
        });
        docker.modem.demuxStream(stream, out, err);
        await container.start();
        const ready = await execTool(docker, container, [
          'sh',
          '-c',
          'for i in $(seq 1 50); do if [ "$(wc -l < /proc/net/packet)" -gt 1 ]; then exit 0; fi; sleep 0.1; done; exit 1',
        ]);
        if (ready.exitCode !== 0) throw Error(`La capture ne démarre pas : ${probe.stderr}`);
      }
      record.ready = true;
      session.timer = setTimeout(
        () => this.stop(record.id).catch(() => {}),
        options.duration * 1000,
      );
      session.updateTimer = setInterval(() => {
        if (session.pending) {
          session.pending = false;
          this.emit({
            type: 'workspace-capture',
            hostId: record.hostId,
            runId: record.runId,
            captureId: record.id,
            count: record.count,
            flows: record.flows,
          });
        }
      }, 1000);
      return structuredClone(record);
    } catch (e) {
      record.errors.push(e.message);
      await this.stop(record.id, 'interrupted');
      throw e;
    } finally {
      this.starting--;
    }
  }
  async stop(id, status = 'completed') {
    const session = this.active.get(id);
    if (!session) return this.get(id);
    if (session.stopping) return session.stopping;
    session.stopping = this.finish(session, status);
    return session.stopping;
  }
  async finish(session, status) {
    const r = session.record;
    clearTimeout(session.timer);
    clearInterval(session.updateTimer);
    await mkdir(this.dir, { recursive: true });
    let totalBytes = 0;
    try {
      for (const [i, p] of session.probes.entries()) {
        try {
          const info = await p.container.inspect();
          if (info.State.Running) {
            try {
              await p.container.kill({ signal: 'SIGINT' });
            } catch (e) {
              if (![304, 409].includes(e.statusCode)) throw e;
            }
            // dumpcap flushes its file during TShark's orderly shutdown.
            let timer;
            try {
              await Promise.race([
                p.container.wait(),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(Error('Arrêt de la capture trop lent.')), 8000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          } else if (info.State.ExitCode && info.State.ExitCode !== 130)
            r.errors.push(`Sonde terminée avec le code ${info.State.ExitCode} : ${p.stderr}`);
          const buffer = await archiveFile(
            p.container,
            '/tmp/trace.pcap',
            Math.floor(CAPTURE_LIMIT / Math.max(1, r.targets.length)),
          );
          totalBytes += buffer.length;
          if (totalBytes > CAPTURE_LIMIT) throw Error('Limite de 20 Mo atteinte.');
          const filename = `${r.id}-${i}.pcap`;
          await writeFile(path.join(this.dir, filename), buffer, { mode: 0o600 });
          r.files.push({
            filename,
            index: i,
            hostId: p.hostId,
            containerId: p.targetId,
            bytes: buffer.length,
          });
          if (buffer.length > Math.floor(18500000 / Math.max(1, r.targets.length)))
            r.truncated = true;
        } catch (e) {
          r.errors.push(e.message);
        } finally {
          p.stream?.destroy();
          const error = await removeHelper(p.container);
          if (error) r.errors.push(`Nettoyage à reprendre : ${error}`);
        }
      }
      r.status = r.errors.length ? 'interrupted' : status;
      r.finishedAt = Date.now();
      r.bytes = totalBytes;
      // Match only the tested 5-tuple/time window; simultaneous traffic remains explicitly ambiguous.
      if (r.runId) {
        const run = this.store.read().runs.find((x) => x.id === r.runId),
          tcp = run?.steps.find((s) => s.kind === 'tcp');
        for (const p of r.packets) {
          const addr = tcp?.evidence.address,
            port = String(tcp?.evidence.port || '');
          p.association =
            addr &&
            p.time >= run.startedAt - 1000 &&
            (p.source === addr || p.target === addr) &&
            (p.sourcePort === port || p.targetPort === port)
              ? 'compatible-ambiguous'
              : 'unrelated-or-unknown';
        }
      }
      await this.store.mutate((s) => {
        const i = s.captures.findIndex((c) => c.id === r.id);
        if (i >= 0) s.captures[i] = structuredClone(r);
      });
      this.emit({
        type: 'workspace-capture',
        hostId: r.hostId,
        runId: r.runId,
        captureId: r.id,
        status: r.status,
        count: r.count,
        flows: r.flows,
      });
      await this.pruneFiles();
      return structuredClone(r);
    } finally {
      this.active.delete(r.id);
    }
  }
  async file(id, index) {
    const record = this.get(id),
      f = record.files.find((f) => f.index === index);
    if (!f) throw Object.assign(Error('Fichier PCAP indisponible.'), { statusCode: 404 });
    return { buffer: await readFile(path.join(this.dir, f.filename)), filename: f.filename };
  }
  async shutdown() {
    await Promise.allSettled([...this.active.keys()].map((id) => this.stop(id, 'interrupted')));
  }
}
