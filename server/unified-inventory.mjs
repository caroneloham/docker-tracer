import { qualifyInventory } from '../shared/workspace.mjs';

// Each host owns its request and freshness. A slow SSH peer never blocks the map.
export function unifiedInventory(hosts, waitMs = 750) {
  const snapshots = new Map(),
    pending = new Map(),
    nextRead = new Map();
  return async () => {
    const profiles = hosts.list();
    for (const h of profiles) {
      if (pending.has(h.id) || Date.now() < (nextRead.get(h.id) || 0)) continue;
      const task = hosts
        .inventory(h.id)
        .then((s) => snapshots.set(h.id, { ...s, stale: false }))
        .catch((e) => {
          const old = snapshots.get(h.id);
          if (old) snapshots.set(h.id, { ...old, stale: true, error: e.message });
        })
        .finally(() => {
          pending.delete(h.id);
          nextRead.set(h.id, Date.now() + 2000);
        });
      pending.set(h.id, task);
    }
    let timer;
    await Promise.race([
      Promise.allSettled([...pending.values()]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    const list = profiles.flatMap((h) =>
      snapshots.has(h.id) ? [qualifyInventory(snapshots.get(h.id), h)] : [],
    );
    return {
      observedAt: Date.now(),
      engine: { name: 'Mes serveurs Docker', version: '' },
      hosts: hosts.list(),
      containers: list.flatMap((s) => s.containers.map((c) => ({ ...c, stale: s.stale }))),
      networks: list.flatMap((s) => s.networks.map((n) => ({ ...n, stale: s.stale }))),
      links: list.flatMap((s) => s.links),
    };
  };
}
