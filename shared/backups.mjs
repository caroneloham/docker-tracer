import { z } from 'zod';
import { topologySchema, volumeMounts } from './model.mjs';

export const backupInput = z.object({
  volume: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
});
export const backupId = z.string().uuid();
export const backupStates = {
  ready: 'Disponible',
  running: 'En cours',
  failed: 'Échouée',
  interrupted: 'Interrompue',
};
export function restoreTopology(topology, backup, mountId) {
  const next = topologySchema.parse(topology),
    node = next.nodes.find((n) => n.id === backup.nodeId && n.data.kind === 'container');
  if (!node) throw Error('Le service d’origine doit être présent pour restaurer ses données.');
  const mounts = volumeMounts(node),
    target = mounts.find((m) => m.target === backup.target);
  if (!target) throw Error('Le chemin du volume d’origine doit être présent sur ce service.');
  node.data.volume = '';
  node.data.volumes = mounts.map((m) => (m === target ? { ...m, id: mountId } : m));
  return topologySchema.parse(next);
}
