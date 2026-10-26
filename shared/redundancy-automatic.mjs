import { composeDocument, patchComposeObject } from './compose-project.mjs';
import { analyzeRedundancyData } from './redundancy-data.mjs';
import { analyzeRedundancyNetwork, planLocalRedundancy } from './redundancy-network.mjs';

const repository = (image = '') =>
  String(image)
    .split('@')[0]
    .replace(/:[^/:]+$/, '')
    .replace(/^(?:docker\.io\/)?library\//, '')
    .replace(/^docker\.io\//, '');
const imageDefaults = {
  nginx: { protocol: 'http', healthPath: '/', label: 'NGINX' },
  'nginxinc/nginx-unprivileged': { protocol: 'http', healthPath: '/', label: 'NGINX' },
  httpd: { protocol: 'http', healthPath: '/', label: 'Apache HTTP Server' },
};

export function detectRedundancyEndpoint(service, endpoint) {
  const repo = repository(service.image);
  const appProtocol = endpoint.details?.app_protocol;
  if (endpoint.targetPort === 443 || appProtocol === 'https')
    return { protocol: 'tcp', label: 'HTTPS transmis', detectedFrom: 'port' };
  const known = imageDefaults[repo];
  if (known && [80, 8080, 8000, 8888].includes(endpoint.targetPort))
    return { ...known, detectedFrom: 'image-et-port' };
  if (appProtocol === 'http')
    return { protocol: 'tcp', label: 'HTTP, sonde TCP', detectedFrom: 'compose' };
  return { protocol: 'tcp', label: 'TCP', detectedFrom: 'controle-de-port' };
}

function permanentServices(model) {
  const completed = new Set();
  for (const service of Object.values(model.services || {}))
    for (const [name, dependency] of Object.entries(service.depends_on || {}))
      if (dependency?.condition === 'service_completed_successfully') completed.add(name);
  return new Set(
    Object.entries(model.services || {})
      .filter(
        ([name, service]) =>
          !completed.has(name) &&
          !String(service.deploy?.mode || '').endsWith('-job') &&
          // An explicit "no" is frequently an init job. Do not turn it into a loop.
          service.restart !== 'no' &&
          !service.profiles?.length &&
          (['always', 'unless-stopped'].includes(service.restart) ||
            /^(?:nginx|httpd|caddy|postgres|mysql|mariadb|redis|qdrant\/qdrant|vllm\/vllm-openai|ollama\/ollama|ghcr\.io\/open-webui\/open-webui|nginxinc\/nginx-unprivileged)$/.test(
              repository(service.image),
            )),
      )
      .map(([name]) => name),
  );
}

function singleReason(service, findings) {
  if (findings.some((item) => item.code === 'GPU_CAPACITY_UNVERIFIED'))
    return 'GPU conservé pour une seule instance';
  if (findings.some((item) => item.code === 'NETWORK_APPLIANCE_UNSUPPORTED'))
    return 'Équipement réseau conservé en une instance';
  if (findings.some((item) => item.code === 'TLS_STORAGE_UNVERIFIED'))
    return 'Certificats conservés dans une entrée commune';
  if (findings.some((item) => item.code !== 'STATE_UNCLASSIFIED'))
    return 'Données conservées dans une seule instance';
  return 'Compatibilité avec plusieurs instances non établie';
}

// Conservative automatic policy: keep state and one-shot jobs intact. Recognized
// HTTP images may be multiplied only after both strict analyzers accept them.
// Restart-only protection is reported separately and never counted as replicas.
export function planAutomaticRedundancy(source, { serviceNames, replicas = 2 } = {}) {
  const { model } = composeDocument(source);
  const names = [...new Set(serviceNames || Object.keys(model.services || {}))];
  if (!names.length || names.some((name) => !model.services?.[name]))
    throw Error('Sélectionne au moins un service du projet.');
  if (![2, 3, 4].includes(replicas)) throw Error('Choisis entre 2 et 4 instances.');
  const permanent = permanentServices(model);
  const data = analyzeRedundancyData(source, names);
  const rows = [],
    eligible = [],
    endpoints = [];
  for (const name of names) {
    const service = model.services[name];
    const findings = data.blockers.filter((item) => item.service === name);
    if (!permanent.has(name)) {
      rows.push({
        name,
        strategy: 'unchanged',
        instances: 1,
        reason: 'Politique de démarrage conservée',
      });
      continue;
    }
    const known = imageDefaults[repository(service.image)];
    const command = service.command;
    const customCommand =
      command != null &&
      !(Array.isArray(command) && ['nginx', 'httpd', 'httpd-foreground'].includes(command[0]));
    const network = analyzeRedundancyNetwork(source, [name]);
    const accepted =
      known &&
      !customCommand &&
      service.entrypoint == null &&
      findings.every((item) => item.code === 'STATE_UNCLASSIFIED') &&
      !network.blockers.length &&
      network.endpoints.length > 0;
    if (accepted) {
      eligible.push(name);
      const checks = network.endpoints.map((endpoint) => ({
        ...endpoint,
        ...detectRedundancyEndpoint(service, endpoint),
      }));
      endpoints.push(...checks);
      rows.push({
        name,
        strategy: 'replicas',
        instances: replicas,
        reason: 'Plusieurs instances derrière une entrée commune',
        endpoints: checks,
      });
    } else {
      const reason =
        known &&
        !network.endpoints.length &&
        !findings.some((item) => item.code !== 'STATE_UNCLASSIFIED')
          ? 'Service interne sans entrée publiée : redémarrage automatique'
          : singleReason(service, findings);
      rows.push({ name, strategy: 'restart', instances: 1, reason });
    }
  }
  let next = source;
  for (const row of rows.filter((item) => item.strategy !== 'unchanged'))
    if (!['always', 'unless-stopped'].includes(model.services[row.name].restart))
      next = patchComposeObject(next, 'services', row.name, 'restart', 'unless-stopped');
  let plan = { source: next, blockers: [], warnings: [], summary: { applicable: true } };
  if (eligible.length)
    plan = planLocalRedundancy(next, {
      serviceNames: eligible,
      replicas,
      confirmations: { statelessServices: eligible },
      endpoints,
    });
  return {
    ...plan,
    summary: {
      ...plan.summary,
      automatic: true,
      services: rows,
      replicatedServices: eligible,
      restartServices: rows.filter((row) => row.strategy === 'restart').map((row) => row.name),
      changed: !!plan.source && plan.source !== source,
      description: eligible.length
        ? `${eligible.length} service(s) en ${replicas} instances`
        : 'Relance automatique uniquement : aucun service multiplié',
    },
  };
}
