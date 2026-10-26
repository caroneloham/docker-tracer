import { buildInventory } from '../shared/inventory.mjs';

export function createInventoryService(docker, now = Date.now) {
  let cache = null,
    pending = null,
    expires = 0;
  const details = new Map();
  async function read() {
    if (cache && now() < expires) return cache;
    if (pending) return pending;
    pending = Promise.all([
      docker.listContainers({ all: true }),
      docker.listNetworks(),
      docker.info(),
    ])
      .then(([containers, networks, engine]) => {
        cache = buildInventory(containers, networks, engine, now());
        expires = now() + 4000;
        return cache;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  async function inspect(id) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw Object.assign(Error('Identifiant de conteneur invalide.'), { statusCode: 400 });
    const entry = details.get(id);
    if (entry && now() < entry.expires) return entry.promise;
    const promise = (async () => {
      const known = (await read()).containers.find((c) => c.id === id);
      if (!known)
        throw Object.assign(Error('Ce conteneur n’existe plus. Actualise la carte.'), {
          statusCode: 404,
        });
      const container = docker.getContainer(id),
        info = await container.inspect();
      let metrics = null;
      if (info.State.Running)
        try {
          const s = await container.stats({ stream: false });
          const cpu =
            s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage || 0);
          const system = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
          metrics = {
            cpu: system > 0 ? (cpu / system) * (s.cpu_stats.online_cpus || 1) * 100 : 0,
            memory: Math.max(
              0,
              (s.memory_stats.usage || 0) - (s.memory_stats.stats?.inactive_file || 0),
            ),
            memoryLimit: s.memory_stats.limit || 0,
            rx: Object.values(s.networks || {}).reduce((sum, n) => sum + n.rx_bytes, 0),
            tx: Object.values(s.networks || {}).reduce((sum, n) => sum + n.tx_bytes, 0),
          };
        } catch {}
      return {
        id,
        observedAt: now(),
        created: info.Created,
        startedAt: info.State.StartedAt,
        health: info.State.Health?.Status || '',
        exitCode: info.State.ExitCode,
        error: info.State.Error || '',
        restartCount: info.RestartCount || 0,
        metrics,
      };
    })().catch((e) => {
      details.delete(id);
      throw e;
    });
    details.set(id, { promise, expires: now() + 4000 });
    if (details.size > 32) details.delete(details.keys().next().value);
    return promise;
  }
  return { read, inspect };
}
