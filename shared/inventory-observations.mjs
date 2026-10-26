// An observation stays inspectable after its session ends, but must never be
// presented as live traffic merely because the inventory renders again.
export function inventoryObservations(captures = [], limit = 150) {
  const flows = new Map();
  for (const capture of captures) {
    for (const flow of capture.flows || []) {
      if (!flow.source || !flow.target || flow.source === flow.target) continue;
      const previous = flows.get(flow.key);
      if (previous && previous.lastAt >= flow.lastAt) continue;
      flows.set(flow.key, {
        ...flow,
        captureId: capture.id,
        captureStatus: capture.status,
        live: capture.status === 'running',
      });
    }
  }
  return [...flows.values()].sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0)).slice(-limit);
}

export function capturesForContainer(captures = [], container) {
  if (!container) return [];
  const dockerId = container.dockerId || container.id;
  return captures.filter((capture) =>
    capture.targets?.some(
      (target) => target.hostId === container.hostId && target.containerId === dockerId,
    ),
  );
}
