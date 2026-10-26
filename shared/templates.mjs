import { z } from 'zod';
import { topologySchema } from './model.mjs';
export function validateEquipmentTemplate(value) {
  const t = z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      title: z.string().trim().min(1).max(48),
      data: z.unknown(),
    })
    .parse(value);
  if (t.data?.kind !== 'container') throw Error('Un modèle personnalisé doit être un conteneur.');
  const node = topologySchema.parse({
    id: 'validation',
    name: 'Validation de modèle',
    nodes: [
      {
        id: 'template',
        type: 'device',
        position: { x: 0, y: 0 },
        data: { ...t.data, label: 'template', proxy: null },
      },
    ],
    edges: [],
  }).nodes[0];
  return { ...t, data: node.data };
}
export const templateStorageKey = 'docker-tracer:equipment-templates:v1';
export function loadEquipmentTemplates(storage) {
  try {
    const raw = JSON.parse(storage.getItem(templateStorageKey) || '[]');
    return z.array(z.unknown()).max(50).parse(raw).map(validateEquipmentTemplate);
  } catch {
    return [];
  }
}
