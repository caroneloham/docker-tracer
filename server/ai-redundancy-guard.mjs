import { composeDocument } from '../shared/compose-project.mjs';

const marker = 'x-docker-tracer-ai-redundancy';
export function retiredAiReplicaContainers(record, config, actual) {
  const previousSource = record.compose.lastApplied?.source;
  if (!previousSource || !config[marker]) return [];
  const previous = composeDocument(previousSource).model[marker];
  if (previous?.version !== 1 || !Array.isArray(previous.services)) return [];
  const removed = new Set(previous.services.filter((name) => /^webui-[2-4]$/.test(name) && !Object.hasOwn(config.services || {}, name)));
  return actual.containers.filter((container) => {
    const labels = container.Config?.Labels || {};
    return labels['com.docker.compose.project'] === record.compose.projectName && removed.has(labels['com.docker.compose.service']);
  });
}

export async function assertFreshAiRedundancy({ record, settings, config, actual, docker }) {
  if (!config[marker]) return;
  const previouslyApplied = record.compose.lastApplied?.source;
  if (previouslyApplied && composeDocument(previouslyApplied).model[marker]) return;
  if (
    record.everDeployed ||
    settings.adopt ||
    actual.containers.length ||
    actual.networks.length ||
    actual.volumes.length
  )
    throw Error(
      'Cette préparation IA est réservée à une installation neuve. Des ressources ou un déploiement existent déjà : les données et la configuration sont conservées.',
    );
  for (const [key, volume] of Object.entries(config.volumes || {})) {
    const name = volume.name || `${settings.projectName}_${key}`;
    if (volume.external)
      throw Error('La préparation IA automatique ne modifie pas des volumes externes existants.');
    try {
      await docker.getVolume(name).inspect();
    } catch (error) {
      if (error.statusCode === 404) continue;
      throw Error('Impossible de vérifier les volumes existants avant la préparation IA.');
    }
    throw Error(
      'Un volume existe déjà pour cette infrastructure. La conversion automatique est arrêtée pour conserver ses données.',
    );
  }
}
