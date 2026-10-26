import YAML from 'yaml';
import { AI_EXTENSION, aiSchema } from './ai-infrastructure.mjs';
import { composeDocument, composeServiceNetworks } from './compose-project.mjs';

export const AI_REDUNDANCY_EXTENSION = 'x-docker-tracer-ai-redundancy';
const CONFIG_LABEL = 'io.docker-tracer.ai-caddy-config';
const CORE = ['caddy', 'webui', 'database', 'inference'];
const AUXILIARIES = ['redis', 'qdrant'];
const START = '# docker-tracer-ai-redundancy:start';
const END = '# docker-tracer-ai-redundancy:end';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const issue = (code, message, service) => ({ code, message, ...(service ? { service } : {}) });
const clone = (value) => structuredClone(value);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    object(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
// This label invalidates Compose's service configuration when inline config
// content changes. It is a change detector, not a cryptographic security check.
const fingerprint = (value) => {
  let hash = 2166136261;
  for (const character of typeof value === 'string' ? value : canonical(value))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
};
const env = (value) =>
  Array.isArray(value)
    ? Object.fromEntries(
        value.map((entry) => {
          const index = entry.indexOf('=');
          return index < 0 ? [entry, null] : [entry.slice(0, index), entry.slice(index + 1)];
        }),
      )
    : { ...(value || {}) };
const dependencies = (value) =>
  Array.isArray(value)
    ? Object.fromEntries(value.map((name) => [name, { condition: 'service_started' }]))
    : clone(value || {});
const secondaryNames = (replicas) =>
  Array.from({ length: replicas - 1 }, (_, index) => `webui-${index + 2}`);
const stableSecret = (value) =>
  typeof value === 'string' &&
  (/^\$\{[A-Z_][A-Z0-9_]*(?::?\?[^}]*)?\}$/.test(value) ||
    (value.length >= 16 && !value.includes('$') && !/[\r\n\x00]/.test(value)));
const imageIs = (value, pattern) => typeof value === 'string' && pattern.test(value.split('@')[0]);

function summary(model, replicas, applicable) {
  const services = CORE.filter((name) => model?.services?.[name]).map((name) => ({
    name,
    strategy: name === 'webui' && applicable ? 'replicas' : 'restart',
    instances: name === 'webui' && applicable ? replicas : 1,
    reason:
      name === 'webui' && applicable
        ? 'Interfaces avec fichiers partagés, PostgreSQL, Redis et Qdrant communs'
        : name === 'inference'
          ? 'Un seul moteur IA : budget GPU conservé, relance automatique'
          : name === 'caddy'
            ? 'Une entrée HTTPS commune, relance automatique'
            : 'Une seule base PostgreSQL, données conservées, relance automatique',
  }));
  if (applicable)
    for (const name of AUXILIARIES)
      services.push({
        name,
        strategy: 'restart',
        instances: 1,
        reason:
          name === 'redis'
            ? 'Coordination partagée, relance automatique'
            : 'Index vectoriel partagé persistant, relance automatique',
      });
  return {
    applicable,
    automatic: true,
    freshAiProfile: true,
    services,
    replicatedServices: applicable ? ['webui'] : [],
    restartServices: applicable ? ['caddy', 'database', 'inference', ...AUXILIARIES] : [],
    removedServices:
      applicable && [2, 3, 4].includes(model?.[AI_REDUNDANCY_EXTENSION]?.replicas)
        ? secondaryNames(model[AI_REDUNDANCY_EXTENSION].replicas).filter(
            (name) => !secondaryNames(replicas).includes(name),
          )
        : [],
    description: applicable
      ? `Interface : ${replicas} instances ; moteur IA : 1 instance avec relance automatique`
      : 'Préparation du profil IA indisponible',
  };
}

// Preserve anchors at their original position, including references from later
// services; replacing an aliased service must not mutate its anchor's owner.
function setObject(doc, model, section, name, value) {
  const current = doc.getIn([section, name], true);
  let anchored = false;
  YAML.visit(current, (_key, node) => {
    if (YAML.isPair(node) && String(node.key?.value || '').startsWith('x-docker-tracer-original-'))
      return YAML.visit.SKIP;
    if (node?.anchor) anchored = true;
  });
  const next = doc.createNode(value);
  if (YAML.isMap(current))
    for (const pair of current.items) {
      const key = String(pair.key?.value || '');
      if (key.startsWith('x-docker-tracer-original-') && next.has(key)) next.set(key, pair.value);
    }
  if (anchored) {
    let key = `x-docker-tracer-original-${name}`;
    while (Object.hasOwn(model[section]?.[name] || {}, key)) key += '-saved';
    next.items.unshift(doc.createPair(key, current));
  }
  doc.setIn([section, name], next);
}

function sharedDataMount(service, model) {
  let shared = false;
  for (const entry of service.volumes || []) {
    const parts = typeof entry === 'string' ? entry.split(':') : [];
    const mount =
      typeof entry === 'string'
        ? { source: parts[0], target: parts[1], read_only: parts[2]?.split(',').includes('ro') }
        : entry;
    if (!object(mount)) return false;
    if (mount.target !== '/app/backend/data') {
      if (!mount.read_only) return false;
      continue;
    }
    const definition = model.volumes?.[mount.source];
    if (
      shared ||
      mount.read_only ||
      (mount.type && mount.type !== 'volume') ||
      !Object.hasOwn(model.volumes || {}, mount.source) ||
      definition?.external ||
      definition?.name ||
      definition?.driver_opts ||
      (definition?.driver && definition.driver !== 'local')
    )
      return false;
    shared = true;
  }
  return shared;
}

function proxyBlock(port, replicas) {
  const upstreams = ['webui', ...secondaryNames(replicas)]
    .map((name) => `${name}:${port}`)
    .join(' ');
  return `  ${START}\n  reverse_proxy ${upstreams} {\n    lb_policy round_robin\n    health_uri /health\n    health_interval 3s\n    health_timeout 2s\n    health_status 200\n  }\n  ${END}`;
}

/** Pure planning only. Before the FIRST conversion, the API must establish that
 * this project's containers, networks and volumes do not exist, including after
 * a failed deployment. Never use lastApplied alone as proof of empty storage.
 * Existing SQLite/Chroma data is NOT migrated by this function.
 * Supported configuration: Open WebUI v0.11.1 config.py / env.py and the official
 * multi-replica guide: https://docs.openwebui.com/troubleshooting/multi-replica/
 */
export function prepareFreshAiRedundancy(source, { replicas = 2 } = {}) {
  const blockers = [],
    warnings = [];
  let parsed;
  const fail = (code, message, service) => blockers.push(issue(code, message, service));
  const result = (output, model, applicable = false) => ({
    source: output,
    summary: { ...summary(model, replicas, applicable), changed: output !== source },
    blockers,
    warnings,
  });
  if (![2, 3, 4].includes(replicas))
    fail('INVALID_REPLICA_COUNT', 'Choisis entre 2 et 4 interfaces.');
  try {
    parsed = composeDocument(source);
  } catch {
    fail('INVALID_COMPOSE', 'Le fichier Compose ne peut pas être analysé.');
    return result(source);
  }
  const { doc, model } = parsed,
    services = model.services || {};
  const extension = model[AI_EXTENSION],
    marker = model[AI_REDUNDANCY_EXTENSION];
  if (extension?.version !== 1 || !aiSchema.safeParse(extension.settings).success)
    fail(
      'AI_PROFILE_REQUIRED',
      'Ce profil automatique nécessite une infrastructure IA générée reconnue.',
    );
  if (model.include || model['x-docker-tracer-redundancy'])
    fail(
      'COMPOSE_LAYOUT_UNSUPPORTED',
      'Les inclusions ou une autre préparation de redondance demandent une adaptation spécifique.',
    );
  for (const name of CORE)
    if (!object(services[name]))
      fail('AI_SERVICE_REQUIRED', `Le service ${name} est nécessaire à ce profil.`, name);
  if (blockers.length) return result(source, model);

  const web = services.webui,
    environment = env(web.environment),
    caddy = services.caddy;
  if (!imageIs(web.image, /^ghcr\.io\/open-webui\/open-webui:v0\.11\.1$/))
    fail(
      'WEBUI_VERSION_UNSUPPORTED',
      'Le profil multi-instance est vérifié pour Open WebUI v0.11.1.',
      'webui',
    );
  if (!imageIs(caddy.image, /^(?:docker\.io\/(?:library\/)?)?caddy:2\.10\.2(?:-alpine)?$/))
    fail('CADDY_VERSION_UNSUPPORTED', 'Le profil nécessite Caddy 2.10.2.', 'caddy');
  if (
    !imageIs(
      services.database.image,
      /^(?:docker\.io\/(?:library\/)?)?postgres:17(?:[.-][a-zA-Z0-9.-]+)?$/,
    ) ||
    !/^postgres(?:ql)?:\/\/[^\s]+@database:5432\/[^\s]+$/.test(environment.DATABASE_URL || '')
  )
    fail(
      'POSTGRES_REQUIRED',
      'Conserve la base PostgreSQL 17 gérée et son DATABASE_URL actuel.',
      'database',
    );
  if (!stableSecret(environment.WEBUI_SECRET_KEY))
    fail(
      'SHARED_SECRET_REQUIRED',
      'Une clé WEBUI_SECRET_KEY stable et partagée doit déjà être configurée.',
      'webui',
    );
  if (
    (environment.STORAGE_PROVIDER || 'local') !== 'local' ||
    (environment.DATA_DIR && environment.DATA_DIR !== '/app/backend/data') ||
    !sharedDataMount(web, model)
  )
    fail(
      'SHARED_FILES_REQUIRED',
      'Les interfaces nécessitent le même volume local géré sur /app/backend/data, sans autre stockage inscriptible.',
      'webui',
    );
  if (
    web.command != null ||
    web.entrypoint != null ||
    web.build ||
    web.env_file ||
    caddy.command != null ||
    caddy.entrypoint != null ||
    caddy.build
  )
    fail(
      'CUSTOM_STARTUP_UNSUPPORTED',
      'Les commandes, images construites ou fichiers d’environnement personnalisés nécessitent une validation spécifique.',
    );
  for (const name of CORE) {
    const service = services[name];
    if (
      service.profiles?.length ||
      service.extends ||
      service.network_mode ||
      (service.scale != null && service.scale !== 1) ||
      (service.deploy?.replicas != null && service.deploy.replicas !== 1) ||
      service.deploy?.mode?.endsWith('-job') ||
      service.deploy?.restart_policy
    )
      fail(
        'SERVICE_LAYOUT_UNSUPPORTED',
        'Ce service possède une topologie ou une politique incompatible avec le profil automatique.',
        name,
      );
  }
  if (
    web.container_name ||
    web.ports?.length ||
    web.hostname ||
    web.devices?.length ||
    web.gpus ||
    web.privileged ||
    web.deploy?.resources?.reservations?.devices?.length
  )
    fail(
      'WEBUI_REPLICA_CONFLICT',
      'Les interfaces doivent être internes, sans identité fixe ni matériel exclusif.',
      'webui',
    );
  for (const options of Object.values(composeServiceNetworks(web)))
    if (
      options &&
      (options.aliases?.length ||
        ['ipv4_address', 'ipv6_address', 'mac_address', 'link_local_ips'].some(
          (key) => options[key] != null,
        ))
    )
      fail(
        'FIXED_ADDRESS_UNSUPPORTED',
        'Une adresse fixe ne peut pas être partagée entre interfaces.',
        'webui',
      );
  const networks = Object.keys(composeServiceNetworks(web));
  if (
    !networks.includes('data') ||
    !networks.includes('access') ||
    !Object.hasOwn(composeServiceNetworks(caddy), 'access') ||
    !Object.hasOwn(composeServiceNetworks(services.database), 'data') ||
    model.networks?.data?.internal !== true ||
    model.networks?.data?.external ||
    (model.networks?.data?.driver && model.networks.data.driver !== 'bridge')
  )
    fail(
      'SHARED_NETWORK_REQUIRED',
      'Conserve les réseaux access et data privé entre les services du profil.',
    );
  const port = Number(environment.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail('WEBUI_PORT_UNSUPPORTED', 'Le port HTTP interne doit être un entier connu.', 'webui');
  if (
    !web.healthcheck ||
    web.healthcheck.disable ||
    canonical(web.healthcheck.test) !==
      canonical([
        'CMD',
        'python',
        '-c',
        `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=4)`,
      ])
  )
    fail(
      'WEBUI_HEALTH_REQUIRED',
      'Une sonde de santé active est nécessaire pour sérialiser le démarrage des interfaces.',
      'webui',
    );
  const config = model.configs?.ai_caddyfile;
  const mounted = caddy.configs?.some(
    (entry) =>
      object(entry) && entry.source === 'ai_caddyfile' && entry.target === '/etc/caddy/Caddyfile',
  );
  if (
    !object(config) ||
    typeof config.content !== 'string' ||
    config.file ||
    config.external ||
    !mounted
  )
    fail('INLINE_CADDY_REQUIRED', 'Le Caddyfile intégré du profil doit être disponible.', 'caddy');
  if (marker) {
    if (
      marker.version !== 1 ||
      marker.mode !== 'fresh-only' ||
      ![2, 3, 4].includes(marker.replicas)
    ) {
      fail(
        'AI_REDUNDANCY_VERSION_UNSUPPORTED',
        'Version du profil multi-instance non prise en charge.',
      );
      return result(source, model);
    } else {
      for (const name of ['webui', ...secondaryNames(marker.replicas), ...AUXILIARIES])
        if (!services[name] || marker.serviceFingerprints?.[name] !== fingerprint(services[name]))
          fail(
            'PREPARED_SERVICE_CHANGED',
            'Un service préparé a été personnalisé : redimensionnement automatique refusé.',
            name,
          );
      if (marker.caddyConfigFingerprint !== fingerprint(config?.content || ''))
        fail('PREPARED_CADDY_CHANGED', 'Le Caddyfile préparé a été personnalisé.', 'caddy');
    }
  } else {
    if (
      (environment.VECTOR_DB || 'chroma') !== 'chroma' ||
      environment.CHROMA_HTTP_HOST ||
      environment.REDIS_URL
    )
      fail(
        'EXISTING_SHARED_BACKEND',
        'Un stockage vectoriel ou Redis personnalisé nécessite une préparation spécifique.',
        'webui',
      );
    for (const name of [...AUXILIARIES, ...secondaryNames(replicas)])
      if (Object.hasOwn(services, name))
        fail('RESOURCE_NAME_CONFLICT', `Le nom ${name} est déjà utilisé.`, name);
    if (Object.hasOwn(model.volumes || {}, 'qdrant_data'))
      fail('RESOURCE_NAME_CONFLICT', 'Le volume qdrant_data existe déjà dans la configuration.');
  }
  if (marker)
    for (const name of secondaryNames(replicas))
      if (!secondaryNames(marker.replicas).includes(name) && services[name])
        fail('RESOURCE_NAME_CONFLICT', `Le nom ${name} est déjà utilisé.`, name);
  let content = config?.content;
  if (typeof content === 'string' && Number.isInteger(port)) {
    const expression = marker
      ? /[ \t]*# docker-tracer-ai-redundancy:start\r?\n[\s\S]*?[ \t]*# docker-tracer-ai-redundancy:end/g
      : new RegExp(`^[ \\t]*reverse_proxy[ \\t]+webui:${port}[ \\t]*$`, 'gm');
    if ([...content.matchAll(expression)].length !== 1)
      fail(
        'CADDY_ROUTE_UNSUPPORTED',
        'La route HTTP générée vers webui ne peut pas être adaptée automatiquement.',
        'caddy',
      );
    else content = content.replace(expression, () => proxyBlock(port, replicas));
  }
  if (blockers.length) return result(source, model);

  warnings.push(
    issue(
      'SINGLE_HOST_SHARED_DEPENDENCIES',
      'Caddy, PostgreSQL, Qdrant, Redis et le moteur IA restent en une instance. La panne de la machine ou du GPU reste commune.',
    ),
  );
  warnings.push(
    issue(
      'RESOURCE_BUDGET',
      `${replicas} interfaces consomment chacune leur budget RAM ; Redis et Qdrant ajoutent des ressources.`,
    ),
  );
  warnings.push(
    issue(
      'IN_FLIGHT_REQUESTS',
      'Une requête ou connexion en cours peut être interrompue lors de la perte d’une interface.',
    ),
  );
  if (!marker)
    warnings.push(
      issue(
        'FRESH_INSTALL_ONLY',
        'À appliquer uniquement après vérification de l’absence de conteneurs, réseaux et volumes existants ; aucune donnée Chroma ou SQLite n’est migrée.',
      ),
    );
  if (marker?.replicas === replicas && env(caddy.labels)[CONFIG_LABEL] === fingerprint(content))
    return result(source, model, true);

  const primary = clone(web);
  primary.restart = 'unless-stopped';
  primary.environment = {
    ...environment,
    STORAGE_PROVIDER: 'local',
    VECTOR_DB: 'qdrant',
    QDRANT_URI: 'http://qdrant:6333',
    REDIS_URL: 'redis://redis:6379/0',
    WEBSOCKET_REDIS_URL: 'redis://redis:6379/1',
    ENABLE_WEBSOCKET_SUPPORT: 'true',
    WEBSOCKET_MANAGER: 'redis',
    UVICORN_WORKERS: '1',
    ENABLE_PERSISTENT_CONFIG: 'false',
    ENABLE_DB_MIGRATIONS: 'true',
  };
  primary.depends_on = {
    ...dependencies(web.depends_on),
    redis: { condition: 'service_healthy' },
    qdrant: { condition: 'service_healthy' },
  };
  const nextServices = { webui: primary };
  for (const name of secondaryNames(replicas)) {
    nextServices[name] = clone(primary);
    nextServices[name].environment.ENABLE_DB_MIGRATIONS = 'false';
    nextServices[name].depends_on.webui = { condition: 'service_healthy' };
  }
  const common = {
    restart: 'unless-stopped',
    networks: ['data'],
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  };
  nextServices.redis = marker
    ? clone(services.redis)
    : {
        ...clone(common),
        image: 'redis:7-alpine',
        command: ['redis-server', '--save', '', '--appendonly', 'no'],
        tmpfs: ['/data'],
        healthcheck: {
          test: ['CMD', 'redis-cli', 'ping'],
          interval: '5s',
          timeout: '3s',
          retries: 12,
        },
      };
  nextServices.qdrant = marker
    ? clone(services.qdrant)
    : {
        ...clone(common),
        image: 'qdrant/qdrant:v1.15',
        volumes: ['qdrant_data:/qdrant/storage'],
        // The official Debian image has bash but no curl/wget. Check the HTTP status
        // with bash's TCP support and standard Debian coreutils instead.
        healthcheck: {
          test: [
            'CMD',
            'bash',
            '-ec',
            "exec 3<>/dev/tcp/127.0.0.1/6333; printf 'GET /readyz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3; head -n 1 <&3 | grep -q ' 200 '",
          ],
          interval: '5s',
          timeout: '3s',
          retries: 24,
          start_period: '10s',
        },
      };
  const labels = env(caddy.labels);
  labels[CONFIG_LABEL] = fingerprint(content);
  nextServices.caddy = { ...clone(caddy), restart: 'unless-stopped', labels };
  for (const name of ['database', 'inference'])
    nextServices[name] = { ...clone(services[name]), restart: 'unless-stopped' };
  // Refuse removing an interface still referenced by a manually added service.
  const removed = marker
    ? secondaryNames(marker.replicas).filter((name) => !nextServices[name])
    : [];
  for (const [name, service] of Object.entries(services))
    if (
      !removed.includes(name) &&
      removed.some(
        (old) =>
          Object.hasOwn(dependencies(service.depends_on), old) ||
          ['network_mode', 'ipc', 'pid'].some((field) => service[field] === `service:${old}`) ||
          [...(service.links || []), ...(service.volumes_from || [])].some(
            (reference) => String(reference).split(':')[0] === old,
          ),
      )
    )
      fail(
        'SECONDARY_STILL_REFERENCED',
        'Un service dépend encore d’une interface à retirer.',
        name,
      );
  for (const name of removed)
    YAML.visit(doc.getIn(['services', name], true), (_key, node) => {
      if (node?.anchor)
        fail(
          'SECONDARY_ANCHOR_PRESENT',
          'Une interface à retirer porte une ancre YAML personnalisée.',
          name,
        );
    });
  const total =
    Object.keys(services).length -
    removed.length +
    Object.keys(nextServices).filter((name) => !Object.hasOwn(services, name)).length;
  if (total > 200) fail('SERVICE_LIMIT', 'Cette préparation dépasse la limite de 200 services.');
  if (blockers.length) return result(source, model);
  for (const name of removed) doc.deleteIn(['services', name]);
  for (const [name, service] of Object.entries(nextServices))
    setObject(doc, model, 'services', name, service);
  setObject(doc, model, 'configs', 'ai_caddyfile', { ...clone(config), content });
  if (!marker) doc.setIn(['volumes', 'qdrant_data'], {});
  // Fingerprint the emitted model, including any retained YAML-anchor extension.
  const emitted = doc.toJS({ maxAliasCount: 100 });
  doc.set(AI_REDUNDANCY_EXTENSION, {
    version: 1,
    mode: 'fresh-only',
    replicas,
    services: ['webui', ...secondaryNames(replicas)],
    caddyConfigFingerprint: fingerprint(content),
    serviceFingerprints: Object.fromEntries(
      ['webui', ...secondaryNames(replicas), ...AUXILIARIES].map((name) => [
        name,
        fingerprint(emitted.services[name]),
      ]),
    ),
  });
  const output = doc.toString({ lineWidth: 0 });
  composeDocument(output);
  return result(output, emitted, true);
}
