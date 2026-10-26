import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { containerId, recordId } from '../shared/workspace.mjs';
import { validateAllocation, cpuSetCount } from '../shared/container-resources.mjs';
import { discoverAiHardware } from './ai-hardware.mjs';

const fail = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nameSchema = z.string().min(1).max(256);
const proposal = z
  .object({
    expectedName: nameSchema,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    cpus: z.number().finite().optional(),
    memoryBytes: z.number().int().optional(),
  })
  .strict()
  .refine(
    (value) => value.cpus !== undefined || value.memoryBytes !== undefined,
    'Choisis une limite à modifier.',
  );
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(fail('Docker ne répond pas. Actualise avant de réessayer.', 504)),
          12000,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class ContainerResourcesService {
  constructor(hosts, { hardware = discoverAiHardware, emit = () => {}, now = Date.now } = {}) {
    this.hosts = hosts;
    this.hardware = hardware;
    this.emit = emit;
    this.now = now;
    this.previews = new Map();
    this.busy = new Set();
    this.hardwareCache = new Map();
  }
  async host(hostId) {
    recordId.parse(hostId);
    const profile = this.hosts.profile(hostId),
      docker = await this.hosts.client(hostId),
      info = await deadline(docker.info());
    if (info.OSType !== 'linux') throw fail('Ces réglages nécessitent un moteur Docker Linux.');
    const cache = this.hardwareCache.get(hostId),
      cacheKey = `${info.ID}:${info.Name}:${profile.kind}:${docker.modem?.socketPath || ''}`;
    let hardware;
    if (cache?.key === cacheKey && cache.expires > this.now()) hardware = cache.value;
    else {
      hardware = await this.hardware(info, {
        kind: profile.kind,
        socketPath: docker.modem?.socketPath,
      });
      this.hardwareCache.set(hostId, {
        key: cacheKey,
        value: hardware,
        expires: this.now() + 15000,
      });
    }
    return {
      hostId,
      name: profile.name || info.Name,
      engineName: info.Name,
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
      operatingSystem: info.OperatingSystem,
      hardware,
      gpus: hardware.gpus || [],
      memoryLimit: info.MemoryLimit !== false,
      cpuLimit: info.CpuCfsQuota !== false,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
  async target(hostId, id, expectedName) {
    recordId.parse(hostId);
    containerId.parse(id);
    this.hosts.profile(hostId);
    const docker = await this.hosts.client(hostId),
      container = docker.getContainer(id),
      info = await deadline(container.inspect());
    const name = (info.Name || '').replace(/^\//, '');
    if (info.Id !== id || (expectedName !== undefined && nameSchema.parse(expectedName) !== name))
      throw fail('La cible a changé. Actualise la machine.', 409);
    if (
      ['capture', 'observer', 'diagnostic', 'startup', 'backup'].includes(
        info.Config?.Labels?.['io.dockertracer.role'],
      )
    )
      throw fail('Les sondes ne sont pas modifiables ici.');
    if (info.State?.Dead || info.State?.RemovalInProgress)
      throw fail('Ce conteneur ne peut pas être modifié.', 409);
    return { docker, container, info, name, version: hash({ id, name, config: info.HostConfig }) };
  }
  async read(hostId, id) {
    const [target, host] = await Promise.all([this.target(hostId, id), this.host(hostId)]),
      config = target.info.HostConfig || {};
    let usage = null;
    if (target.info.State?.Running) {
      try {
        const stats = await deadline(target.container.stats({ stream: false }));
        const cpu = stats.cpu_stats || {},
          previous = stats.precpu_stats || {},
          delta = cpu.cpu_usage?.total_usage - previous.cpu_usage?.total_usage;
        const system = cpu.system_cpu_usage - previous.system_cpu_usage;
        usage = {
          memoryBytes: stats.memory_stats?.usage ?? null,
          cpuPercent:
            system > 0 && delta >= 0
              ? (delta / system) * (cpu.online_cpus || host.cpus) * 100
              : null,
        };
      } catch {
        /* Usage is optional; never infer zero from a failed read. */
      }
    }
    return {
      host,
      id,
      name: target.name,
      version: target.version,
      running: !!target.info.State?.Running,
      image: target.info.Config?.Image,
      composeProject: target.info.Config?.Labels?.['com.docker.compose.project'] || null,
      usage,
      limits: {
        cpus:
          config.NanoCpus > 0
            ? config.NanoCpus / 1e9
            : config.CpuQuota > 0
              ? config.CpuQuota / (config.CpuPeriod || 100000)
              : null,
        memoryBytes: config.Memory > 0 ? config.Memory : null,
        memorySwap: config.MemorySwap ?? 0,
        memoryReservation: config.MemoryReservation || 0,
        cpuSet: config.CpusetCpus || '',
        devices: config.DeviceRequests || [],
        runtime: config.Runtime || '',
      },
    };
  }
  plan(input, target, host) {
    const config = target.info.HostConfig || {},
      update = {};
    const allowedCpus = cpuSetCount(config.CpusetCpus);
    const allocation = validateAllocation(input, {
      ...host,
      cpus: allowedCpus ? Math.min(host.cpus, allowedCpus) : host.cpus,
    });
    if (allocation.cpus !== undefined) {
      if (!host.cpuLimit) throw fail('Ce moteur ne prend pas en charge la limite CPU.');
      if (config.CpuQuota || config.CpuPeriod) {
        update.CpuPeriod = config.CpuPeriod || 100000;
        update.CpuQuota = Math.round(allocation.cpus * update.CpuPeriod);
      } else update.NanoCpus = Math.round(allocation.cpus * 1e9);
    }
    if (allocation.memoryBytes !== undefined) {
      if (!host.memoryLimit) throw fail('Ce moteur ne prend pas en charge la limite mémoire.');
      if (config.MemorySwap > 0 && allocation.memoryBytes > config.MemorySwap)
        throw fail(
          'Cette RAM dépasse la limite RAM + swap existante. Ajuste le swap dans Compose.',
        );
      if (config.MemoryReservation > allocation.memoryBytes)
        throw fail(
          'La RAM est inférieure à la réservation existante. Ajuste la réservation dans Compose.',
        );
      update.Memory = allocation.memoryBytes;
    }
    return { allocation, update };
  }
  async preview(hostId, id, raw) {
    const input = proposal.parse(raw),
      [target, host] = await Promise.all([
        this.target(hostId, id, input.expectedName),
        this.host(hostId),
      ]);
    if (input.version !== target.version)
      throw fail('Les ressources ont changé. Actualise avant de modifier.', 409);
    const plan = this.plan(input, target, host),
      token = randomUUID(),
      expires = this.now() + 120000;
    for (const [key, value] of this.previews)
      if (value.expires < this.now()) this.previews.delete(key);
    if (this.previews.size >= 100) throw fail('Trop de modifications en attente.', 429);
    this.previews.set(token, {
      ...plan,
      hostId,
      id,
      version: target.version,
      name: target.name,
      expires,
    });
    return {
      token,
      expires,
      host: host.name,
      name: target.name,
      before: {
        cpus:
          target.info.HostConfig?.NanoCpus > 0
            ? target.info.HostConfig.NanoCpus / 1e9
            : target.info.HostConfig?.CpuQuota > 0
              ? target.info.HostConfig.CpuQuota / (target.info.HostConfig.CpuPeriod || 100000)
              : null,
        memoryBytes: target.info.HostConfig?.Memory || null,
      },
      after: plan.allocation,
      note: 'Application immédiate, sans recréer le conteneur. Les autres réglages sont conservés.',
    };
  }
  async apply(hostId, id, raw) {
    const input = z
        .object({ token: z.string().uuid(), expectedName: nameSchema })
        .strict()
        .parse(raw),
      saved = this.previews.get(input.token),
      key = `${hostId}:${id}`;
    if (
      !saved ||
      saved.expires < this.now() ||
      saved.hostId !== hostId ||
      saved.id !== id ||
      saved.name !== input.expectedName
    )
      throw fail('Aperçu expiré ou cible différente. Prépare un nouvel aperçu.', 409);
    if (this.busy.has(key)) throw fail('Une mise à jour est en cours.', 409);
    this.busy.add(key);
    try {
      const [target, host] = await Promise.all([
        this.target(hostId, id, saved.name),
        this.host(hostId),
      ]);
      if (target.version !== saved.version)
        throw fail('Les ressources ont changé depuis l’aperçu. Actualise.', 409);
      const plan = this.plan(saved.allocation, target, host);
      this.previews.delete(input.token);
      // Send only intended limits. In particular, never rewrite swap, restart policy or GPU requests.
      const result = await deadline(target.container.update(plan.update));
      this.emit({ type: 'container.resources.updated', hostId, containerId: id });
      return { ok: true, warnings: result?.Warnings || [], resources: await this.read(hostId, id) };
    } finally {
      this.busy.delete(key);
    }
  }
}
export function mountContainerResources(app, { hosts, labBusy = () => false, ...options }) {
  const service = new ContainerResourcesService(hosts, options),
    base = '/api/hosts/:hostId/containers/:id/resources';
  const route =
    (fn, mutation = false) =>
    async (req, res) => {
      try {
        if (mutation && labBusy(req.params.hostId))
          throw fail('Une opération est en cours sur ce serveur.', 409);
        res.json(await fn(req));
      } catch (error) {
        res.status(error instanceof z.ZodError ? 400 : error.statusCode || 400).json({
          error: error instanceof z.ZodError ? 'Valeurs de ressources invalides.' : error.message,
        });
      }
    };
  app.get(
    '/api/hosts/:hostId/hardware',
    route((r) => service.host(r.params.hostId)),
  );
  app.get(
    base,
    route((r) => service.read(r.params.hostId, r.params.id)),
  );
  app.post(
    base + '/preview',
    route((r) => service.preview(r.params.hostId, r.params.id, r.body)),
  );
  app.post(
    base + '/apply',
    route((r) => service.apply(r.params.hostId, r.params.id, r.body), true),
  );
  return service;
}
