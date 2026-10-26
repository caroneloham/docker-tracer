import YAML from 'yaml';
import { composeDocument, composeServiceNetworks } from './compose-project.mjs';
import { analyzeRedundancyData } from './redundancy-data.mjs';

// Verified against Docker's official-images/library/haproxy on 2026-10-19.
// https://github.com/docker-library/official-images/blob/master/library/haproxy
export const LOCAL_REDUNDANCY_IMAGE = 'haproxy:3.2.26-alpine';
export const LOCAL_REDUNDANCY_MARKER = 'x-docker-tracer-redundancy';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CONFIG_PATH = '/usr/local/etc/haproxy/haproxy.cfg';
const READINESS_PORT = 19080;
const PROXY_CONFIG_LABEL = 'io.docker-tracer.haproxy-config';
// Change detector, not a security signature. Compose hashes service labels but
// not inline config payloads, so a changed payload must change the proxy service.
function proxyConfigRevision(content) {
  let fingerprint = 0xcbf29ce484222325n;
  for (const character of content) {
    fingerprint ^= BigInt(character.codePointAt(0));
    fingerprint = BigInt.asUintN(64, fingerprint * 0x100000001b3n);
  }
  return `v1-${fingerprint.toString(16).padStart(16, '0')}`;
}
const proxyHealthcheck = () => ({
  test: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${READINESS_PORT}/ready`],
  interval: '2s',
  timeout: '2s',
  retries: 3,
  start_period: '5s',
});
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (code, service, message, action = '') => ({
  code,
  service,
  scope: service || 'selection',
  message,
  action,
  resolution: action,
});
const portNumber = (value) => {
  if (!['string', 'number'].includes(typeof value) || !/^\d{1,5}$/.test(String(value))) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
};
function validHostIp(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value))
    return value.split('.').every((part) => Number(part) <= 255);
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return false;
  try {
    return Boolean(new URL(`http://[${value}]/`).hostname);
  } catch {
    return false;
  }
}

/** Fixed, literal TCP/UDP publications only; no interpolation or port ranges. */
export function parseRedundancyPort(value) {
  let target,
    published,
    hostIp = '',
    transportProtocol = 'tcp',
    details = {};
  if (isObject(value)) {
    ({ target, published } = value);
    hostIp = value.host_ip ?? '';
    transportProtocol = value.protocol ?? 'tcp';
    details = structuredClone(value);
  } else if (typeof value === 'string') {
    const match = value.match(
      /^(?:(\[[0-9a-f:.]+\]|[^:\s]+):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/i,
    );
    if (!match) return null;
    [, hostIp = '', published, target, transportProtocol = 'tcp'] = match;
    if (hostIp.startsWith('[')) hostIp = hostIp.slice(1, -1);
  } else return null;
  target = portNumber(target);
  published = portNumber(published);
  if (!target || !published || !validHostIp(hostIp) || !['tcp', 'udp'].includes(transportProtocol))
    return null;
  return { targetPort: target, publishedPort: published, hostIp, transportProtocol, details };
}

function selection(model, serviceNames) {
  if (
    !Array.isArray(serviceNames) ||
    serviceNames.length < 1 ||
    serviceNames.length > 50 ||
    serviceNames.some((name) => typeof name !== 'string' || !NAME.test(name)) ||
    new Set(serviceNames).size !== serviceNames.length
  )
    return [issue('INVALID_SELECTION', '', 'Sélectionne entre 1 et 50 services distincts.')];
  return serviceNames
    .filter((name) => !Object.hasOwn(model.services || {}, name))
    .map((name) =>
      issue('SERVICE_NOT_FOUND', name, 'Le service est absent du fichier Compose principal.'),
    );
}

function readSource(source) {
  if (typeof source !== 'string' || !source.length || source.length > 2 * 1024 * 1024)
    throw Error('Source invalide.');
  return composeDocument(source);
}

/** Read-only inventory. A publication is not evidence of HTTP or application readiness. */
export function analyzeRedundancyNetwork(source, serviceNames) {
  const blockers = [],
    warnings = [],
    endpoints = [];
  let doc, model;
  try {
    ({ doc, model } = readSource(source));
  } catch {
    return {
      endpoints,
      blockers: [issue('INVALID_COMPOSE', '', 'Le Compose est invalide ou trop volumineux.')],
      warnings,
    };
  }
  blockers.push(...selection(model, serviceNames));
  if (blockers.length) return { endpoints, blockers, warnings };
  if (Object.hasOwn(model, LOCAL_REDUNDANCY_MARKER))
    blockers.push(
      issue(
        'ALREADY_PREPARED',
        '',
        'Ce Compose contient déjà une préparation de redondance locale.',
        'Examine la préparation existante avant de la modifier.',
      ),
    );
  if (model.include)
    blockers.push(
      issue(
        'INCLUDED_SOURCE_UNSUPPORTED',
        '',
        'Les services inclus demandent une analyse de leurs fichiers sources.',
      ),
    );
  for (const key of ['services', 'networks', 'configs']) {
    const node = doc.get(key, true);
    if (node && (!YAML.isMap(node) || node.anchor))
      blockers.push(
        issue(
          'SHARED_SECTION_UNSUPPORTED',
          '',
          `La section ${key} doit être un objet YAML sans ancre partagée.`,
        ),
      );
  }
  for (const name of serviceNames) {
    const service = model.services[name];
    if (!service.image || service.build || service.extends)
      blockers.push(
        issue(
          'SOURCE_RESOLUTION_REQUIRED',
          name,
          'Une image explicite sans build ni extends est requise pour cette transformation.',
        ),
      );
    if (service.profiles?.length)
      blockers.push(
        issue(
          'PROFILE_UNSUPPORTED',
          name,
          'Un service sous profil demande un plan qui conserve ses règles d’activation.',
        ),
      );
    if (service.network_mode)
      blockers.push(
        issue(
          'NETWORK_MODE_UNSUPPORTED',
          name,
          'Le mode réseau spécial empêche la création sûre de deux instances derrière le proxy.',
        ),
      );
    if (service.hostname || service.mac_address || service.domainname)
      blockers.push(
        issue(
          'FIXED_IDENTITY',
          name,
          'Une identité réseau fixe doit être retirée ou adaptée avant la duplication.',
        ),
      );
    if (service.deploy?.mode && service.deploy.mode !== 'replicated')
      blockers.push(
        issue(
          'DEPLOY_MODE_UNSUPPORTED',
          name,
          'Seul le mode replicated convient à deux processus applicatifs permanents.',
        ),
      );
    if (service.deploy?.endpoint_mode || service.deploy?.placement)
      blockers.push(
        issue(
          'ORCHESTRATOR_SETTINGS',
          name,
          'Les réglages de placement ou de découverte Swarm demandent un plan spécifique.',
        ),
      );
    if (service.deploy?.restart_policy)
      blockers.push(
        issue(
          'RESTART_POLICY_CONFLICT',
          name,
          'Une politique deploy.restart_policy existe déjà.',
          'Définis une politique locale cohérente avant la préparation.',
        ),
      );
    const attachedNetworks = composeServiceNetworks(service);
    for (const [networkName, options] of Object.entries(attachedNetworks)) {
      if (
        isObject(options) &&
        ['ipv4_address', 'ipv6_address', 'mac_address', 'link_local_ips'].some(
          (key) => options[key] != null,
        )
      )
        blockers.push(
          issue(
            'FIXED_BACKEND_ADDRESS',
            name,
            'Une adresse IP ou MAC fixe ne peut pas être attribuée aux deux instances.',
          ),
        );
      const network = model.networks?.[networkName];
      if (network?.driver && network.driver !== 'bridge')
        blockers.push(
          issue(
            'NETWORK_DRIVER_UNSUPPORTED',
            name,
            'Le réseau existant utilise un pilote qui demande une validation spécifique du routage.',
          ),
        );
    }
    if (service.container_name)
      warnings.push(
        issue(
          'CONTAINER_NAME_REMOVED',
          name,
          'Le nom de conteneur fixe sera retiré pour permettre deux instances. Les références externes à ce nom devront être adaptées.',
        ),
      );
    if (!Array.isArray(service.ports) || !service.ports.length)
      warnings.push(
        issue(
          'INTERNAL_ONLY_SERVICE',
          name,
          'Ce service recevra plusieurs instances et une politique de redémarrage. Son DNS interne ne filtre pas les instances selon leur santé applicative.',
        ),
      );
    for (const value of service.ports || []) {
      const port = parseRedundancyPort(value);
      if (!port) {
        blockers.push(
          issue(
            'PORT_UNRESOLVED',
            name,
            'Une publication utilise un port dynamique, une plage, une variable ou une adresse non prise en charge.',
            'Définis des ports et adresses littéraux avant la préparation.',
          ),
        );
        continue;
      }
      if (port.transportProtocol !== 'tcp')
        blockers.push(
          issue(
            'UDP_UNSUPPORTED',
            name,
            'Une publication UDP ne peut pas être transférée à ce proxy HTTP/TCP.',
          ),
        );
      if (
        !port.hostIp &&
        Object.keys(attachedNetworks).some((key) => {
          const net = model.networks?.[key];
          return net?.external || net?.driver_opts?.['com.docker.network.bridge.host_binding_ipv4'];
        })
      )
        blockers.push(
          issue(
            'IMPLICIT_HOST_BINDING',
            name,
            'L’adresse de publication dépend d’un réseau existant ou externe.',
            'Rends host_ip explicite pour conserver exactement la portée d’accès.',
          ),
        );
      endpoints.push({ service: name, ...port, protocol: null, healthPath: null });
    }
  }
  // These references address a single container, not a scalable service.
  const selected = new Set(serviceNames);
  for (const [name, service] of Object.entries(model.services || {})) {
    const references = ['network_mode', 'pid', 'ipc'].flatMap((key) =>
      typeof service[key] === 'string' && /^(service|container):/.test(service[key])
        ? [service[key].split(':')[1]]
        : [],
    );
    for (const key of ['links', 'external_links', 'volumes_from'])
      for (const ref of Array.isArray(service[key]) ? service[key] : [])
        if (typeof ref === 'string') references.push(ref.replace(/^container:/, '').split(':')[0]);
    const selectedContainerNames = serviceNames
      .map((target) => model.services[target].container_name)
      .filter(Boolean);
    if (
      (selected.has(name) && references.length) ||
      references.some((ref) => selected.has(ref) || selectedContainerNames.includes(ref))
    )
      blockers.push(
        issue(
          'SINGLE_CONTAINER_REFERENCE',
          name,
          'Une référence à un conteneur unique est incompatible avec cette duplication.',
          'Adapte network_mode, pid, ipc, links ou volumes_from concernés.',
        ),
      );
    if (selected.has(name)) {
      const deps = Array.isArray(service.depends_on)
        ? service.depends_on
        : Object.keys(service.depends_on || {});
      if (deps.some((dependency) => model.services[dependency]?.profiles?.length))
        blockers.push(
          issue(
            'DEPENDENCY_PROFILE_UNSUPPORTED',
            name,
            'Une dépendance sous profil peut manquer au démarrage du proxy.',
          ),
        );
    }
  }
  const publications = Object.entries(model.services || {}).flatMap(([name, service]) =>
    (service.ports || [])
      .map((value) => ({ service: name, port: parseRedundancyPort(value) }))
      .filter((item) => item.port),
  );
  for (let i = 0; i < publications.length; i++)
    for (let j = i + 1; j < publications.length; j++) {
      const left = publications[i],
        right = publications[j];
      if (!selected.has(left.service) && !selected.has(right.service)) continue;
      const wildcard = (ip) => ['', '0.0.0.0', '::'].includes(ip);
      if (
        left.port.publishedPort === right.port.publishedPort &&
        left.port.transportProtocol === right.port.transportProtocol &&
        (left.port.hostIp === right.port.hostIp ||
          wildcard(left.port.hostIp) ||
          wildcard(right.port.hostIp))
      )
        blockers.push(
          issue(
            'PUBLIC_PORT_CONFLICT',
            left.service,
            'Deux publications peuvent utiliser la même adresse et le même port public.',
            'Résous ce conflit avant de préparer le proxy.',
          ),
        );
    }
  if (endpoints.length > 100)
    blockers.push(
      issue('TOO_MANY_ENDPOINTS', '', 'La préparation est limitée à 100 publications.'),
    );
  return { endpoints, blockers, warnings };
}

function uniqueName(base, names) {
  let name = base,
    suffix = 2;
  while (names.has(name)) name = `${base}-${suffix++}`;
  names.add(name);
  return name;
}

function editableService(doc, model, name) {
  const node = doc.getIn(['services', name], true);
  let anchored = false;
  YAML.visit(node, (_key, value) => {
    if (value?.anchor) anchored = true;
  });
  // Materialize a merge so removing inherited container_name actually removes it.
  const merged =
    YAML.isMap(node) &&
    node.items.some((pair) => pair.key?.value === '<<' || typeof pair.key?.value === 'symbol');
  if (anchored || merged || !YAML.isMap(node)) {
    const replacement = doc.createNode(structuredClone(model.services[name]));
    if (anchored) {
      // Keep the old anchors at their original position in document order. Moving
      // them to the document head can put their own aliases before their owners.
      const extension = uniqueName(
        'x-docker-tracer-original',
        new Set(Object.keys(model.services[name])),
      );
      replacement.items.unshift(doc.createPair(extension, node));
    }
    doc.setIn(['services', name], replacement);
  }
}

function safeHealthPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 512 &&
    /^\/(?:[A-Za-z0-9._~/?=&+-]|%[0-9A-Fa-f]{2})*$/.test(path)
  );
}

function endpointOptions(endpoints, requested, blockers) {
  if (
    !endpoints.length &&
    (requested === undefined || (Array.isArray(requested) && !requested.length))
  )
    return [];
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100) {
    blockers.push(
      issue(
        'ENDPOINT_CONFIGURATION_REQUIRED',
        '',
        'Déclare le protocole et la sonde de chaque publication.',
      ),
    );
    return [];
  }
  const used = new Set();
  const configured = endpoints
    .map((endpoint) => {
      const matches = requested
        .map((value, index) => ({ value, index }))
        .filter(
          ({ value }) =>
            isObject(value) &&
            value.service === endpoint.service &&
            portNumber(value.targetPort) === endpoint.targetPort &&
            portNumber(value.publishedPort) === endpoint.publishedPort &&
            (value.hostIp === undefined || value.hostIp === endpoint.hostIp),
        );
      if (matches.length !== 1) {
        blockers.push(
          issue(
            'ENDPOINT_CONFIGURATION_REQUIRED',
            endpoint.service,
            'Chaque publication doit correspondre à une seule déclaration de sonde.',
          ),
        );
        return null;
      }
      const { value, index } = matches[0];
      used.add(index);
      if (!['http', 'tcp'].includes(value.protocol)) {
        blockers.push(
          issue(
            'PROTOCOL_REQUIRED',
            endpoint.service,
            'Choisis explicitement HTTP ou TCP pour la publication.',
          ),
        );
        return null;
      }
      if (value.protocol === 'http' && !safeHealthPath(value.healthPath))
        blockers.push(
          issue(
            'INVALID_HEALTH_PATH',
            endpoint.service,
            'La sonde HTTP exige un chemin absolu explicite, sans espace ni directive de configuration.',
          ),
        );
      if (
        value.healthHost !== undefined &&
        (typeof value.healthHost !== 'string' ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(
            value.healthHost,
          ))
      )
        blockers.push(
          issue(
            'INVALID_HEALTH_HOST',
            endpoint.service,
            'Le nom Host de la sonde HTTP est invalide.',
          ),
        );
      if (value.protocol === 'tcp' && (value.healthPath != null || value.healthHost != null))
        blockers.push(
          issue(
            'TCP_HEALTH_MISMATCH',
            endpoint.service,
            'Une sonde TCP ne doit pas annoncer une vérification HTTP.',
          ),
        );
      if (
        value.protocol === 'http' &&
        /^(https|http2|grpc)$/i.test(endpoint.details.app_protocol || '')
      )
        blockers.push(
          issue(
            'TLS_OR_PROTOCOL_MISMATCH',
            endpoint.service,
            'Le protocole applicatif existant demande un routage TCP ou une configuration adaptée.',
          ),
        );
      return {
        ...endpoint,
        protocol: value.protocol,
        ...(value.protocol === 'http'
          ? { healthPath: value.healthPath, healthHost: value.healthHost }
          : {}),
      };
    })
    .filter(Boolean);
  if (used.size !== requested.length)
    blockers.push(
      issue(
        'UNKNOWN_ENDPOINT',
        '',
        'Une sonde ne correspond à aucune publication des services sélectionnés.',
      ),
    );
  return configured;
}

function haproxyConfiguration(endpoints, aliases, replicas) {
  const lines = [
    '# Generated for local container failover. Docker Compose >= 2.33.1.',
    'global',
    '  log stdout format raw local0',
    '  maxconn 2048',
    '',
    'defaults',
    '  log global',
    '  mode tcp',
    '  option tcplog',
    '  timeout connect 2s',
    '  timeout client 60s',
    '  timeout server 60s',
    '  timeout tunnel 1h',
    '  timeout check 1s',
    '  retries 0',
    '',
    'resolvers docker',
    '  nameserver embedded 127.0.0.11:53',
    '  accepted_payload_size 8192',
    '  resolve_retries 3',
    '  timeout resolve 1s',
    '  timeout retry 1s',
    '  hold valid 1s',
    '  hold other 1s',
    '  hold refused 1s',
    '  hold nx 1s',
    '  hold timeout 1s',
    '  hold obsolete 0s',
    '',
  ];
  endpoints.forEach((endpoint, index) => {
    const alias = aliases[endpoint.service];
    lines.push(
      `frontend entry_${index + 1}`,
      `  bind :${18080 + index}`,
      `  mode ${endpoint.protocol}`,
      `  default_backend pool_${index + 1}`,
      '',
      `backend pool_${index + 1}`,
      `  mode ${endpoint.protocol}`,
      '  balance roundrobin',
    );
    if (endpoint.protocol === 'http')
      lines.push(
        '  option httpchk',
        '  http-check connect',
        `  http-check send meth GET uri ${endpoint.healthPath} ver HTTP/1.1 hdr Host ${endpoint.healthHost || alias}`,
        '  http-check expect status 200-299',
      );
    else lines.push('  option tcp-check');
    lines.push(
      '  default-server inter 2s fall 3 rise 2 init-state fully-down',
      `  server-template replica 1-${replicas} ${alias}:${endpoint.targetPort} check resolvers docker resolve-prefer ipv4 resolve-opts prevent-dup-ip init-addr none`,
      '',
    );
  });
  // Compose --wait must wait for traffic to be routable, not just a running PID.
  // This loopback-only monitor also works for TCP publications. A failed replica
  // leaves the proxy healthy while at least one peer remains in every pool.
  lines.push(
    'frontend tracer_readiness',
    `  bind 127.0.0.1:${READINESS_PORT}`,
    '  mode http',
    '  monitor-uri /ready',
  );
  endpoints.forEach((_endpoint, index) =>
    lines.push(`  monitor fail if { nbsrv(pool_${index + 1}) lt 1 }`),
  );
  lines.push('');
  return lines.join('\n');
}

/** Pure, fail-closed transformation. Does not run Docker, write files, or claim tested failover. */
export function planLocalRedundancy(source, options = {}) {
  if (!isObject(options)) options = {};
  const { serviceNames, replicas = 2 } = options;
  const network = analyzeRedundancyNetwork(source, serviceNames);
  const blockers = [...network.blockers],
    warnings = [...network.warnings];
  const hasPublicPorts = network.endpoints.length > 0;
  const summary = {
    mode: 'single-engine',
    applicable: false,
    replicas,
    serviceNames: Array.isArray(serviceNames) ? [...serviceNames] : [],
    minimumComposeVersion: hasPublicPorts ? '2.33.1' : '2.0.0',
    image: hasPublicPorts ? LOCAL_REDUNDANCY_IMAGE : null,
    proof: 'not-tested',
    measuredRtoMs: null,
    endpoints: [],
  };
  const result = () => ({ source, blockers, warnings, summary });
  if (!Number.isInteger(replicas) || replicas < 2 || replicas > 4)
    blockers.push(
      issue(
        'INVALID_REPLICA_COUNT',
        '',
        'Cette préparation crée entre deux et quatre instances par service.',
      ),
    );
  if (blockers.length) return result();
  const data = analyzeRedundancyData(source, serviceNames, {
    confirmations: options.confirmations,
  });
  blockers.push(...data.blockers);
  warnings.push(...data.warnings);
  const endpoints = endpointOptions(network.endpoints, options.endpoints, blockers);
  if (blockers.length) return result();
  const { doc, model } = readSource(source);
  const publicServices = [...new Set(endpoints.map((endpoint) => endpoint.service))];
  const proxyService = hasPublicPorts
    ? uniqueName('tracer-ha-proxy', new Set(Object.keys(model.services)))
    : null;
  const usedNetworkNames = new Set(Object.keys(model.networks || {}));
  const serviceNetworks = Object.fromEntries(
    publicServices.map((name) => [name, uniqueName('tracer-ha-backends', usedNetworkNames)]),
  );
  const networkNames = Object.values(serviceNetworks);
  const networkName = networkNames[0] || null;
  const entryNetworkName = hasPublicPorts ? uniqueName('tracer-ha-entry', usedNetworkNames) : null;
  const configName = hasPublicPorts
    ? uniqueName('tracer-ha-config', new Set(Object.keys(model.configs || {})))
    : null;
  const aliasNames = new Set(Object.keys(model.services));
  const aliases = Object.fromEntries(
    publicServices.map((name, index) => [
      name,
      uniqueName(`tracer-ha-backend-${index + 1}`, aliasNames),
    ]),
  );
  for (const name of serviceNames) {
    const service = model.services[name];
    editableService(doc, model, name);
    doc.setIn(['services', name, 'ports'], []);
    doc.deleteIn(['services', name, 'container_name']);
    doc.setIn(['services', name, 'deploy'], { ...(service.deploy || {}), replicas });
    if (Object.hasOwn(service, 'scale')) doc.setIn(['services', name, 'scale'], replicas);
    doc.setIn(['services', name, 'restart'], 'unless-stopped');
    if (publicServices.includes(name))
      doc.setIn(['services', name, 'networks'], {
        ...composeServiceNetworks(service),
        [serviceNetworks[name]]: { aliases: [aliases[name]] },
      });
  }
  const config = hasPublicPorts ? haproxyConfiguration(endpoints, aliases, replicas) : null;
  if (hasPublicPorts) {
    doc.setIn(['configs', configName], { content: config });
    for (const name of networkNames)
      doc.setIn(['networks', name], { driver: 'bridge', internal: true });
    doc.setIn(['networks', entryNetworkName], { driver: 'bridge' });
    if (
      !Object.hasOwn(model.networks || {}, 'default') &&
      publicServices.some((name) =>
        Object.hasOwn(composeServiceNetworks(model.services[name]), 'default'),
      )
    )
      doc.setIn(['networks', 'default'], {});
    const ports = endpoints.map((endpoint, index) => ({
      ...endpoint.details,
      target: 18080 + index,
      published: String(endpoint.publishedPort),
      protocol: 'tcp',
      ...(endpoint.hostIp ? { host_ip: endpoint.hostIp } : {}),
    }));
    doc.setIn(['services', proxyService], {
      image: LOCAL_REDUNDANCY_IMAGE,
      restart: 'unless-stopped',
      command: ['haproxy', '-W', '-db', '-f', CONFIG_PATH],
      ports,
      // Explicit gateway selection survives container/network restarts. Merely
      // listing the public network first does not make Docker prefer it.
      networks: {
        [entryNetworkName]: { gw_priority: 1 },
        ...Object.fromEntries(networkNames.map((name) => [name, {}])),
      },
      depends_on: Object.fromEntries(
        publicServices.map((name) => [name, { condition: 'service_started' }]),
      ),
      configs: [{ source: configName, target: CONFIG_PATH }],
      // Compose injects inline configs into the container before start. It
      // rejects content-based configs when the root filesystem is read-only.
      sysctls: { 'net.ipv4.ip_forward': '0' },
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } },
      healthcheck: proxyHealthcheck(),
      labels: { [PROXY_CONFIG_LABEL]: proxyConfigRevision(config) },
    });
  }
  doc.set(LOCAL_REDUNDANCY_MARKER, {
    version: 1,
    mode: 'single-engine',
    serviceNames,
    replicas,
    proxyService,
    networkName,
    networkNames,
    entryNetworkName,
    configName,
    endpoints: endpoints.map(({ details, ...endpoint }) => endpoint),
  });
  warnings.push(
    issue(
      'SINGLE_ENGINE_LIMIT',
      '',
      'La machine, Docker, le proxy et les dépendances communes restent des points de panne.',
    ),
    issue(
      'RESTART_SCOPE',
      '',
      'Docker relance un processus arrêté selon unless-stopped. Un processus vivant mais unhealthy n’est pas redémarré automatiquement. Un arrêt manuel ou une suppression ne déclenche pas de recréation automatique.',
    ),
    issue(
      'INTERNAL_DNS_DIRECT',
      '',
      'Les communications internes par les noms de services existants restent en DNS direct, sans les contrôles de santé du proxy.',
    ),
    issue(
      'ACTIVE_CONNECTIONS',
      '',
      'Les connexions, WebSockets et requêtes en cours peuvent être interrompus. Les requêtes ne sont pas rejouées automatiquement. Les sessions et fichiers doivent être externes.',
    ),
    issue(
      'APPLY_REQUIRES_RECREATION',
      '',
      'La modification peut recréer les conteneurs sélectionnés et interrompre brièvement l’accès. Cette préparation ne prouve ni déploiement ni bascule.',
    ),
  );
  if (hasPublicPorts)
    warnings.push(
      issue(
        'PROXY_TIMEOUTS',
        '',
        'Le proxy applique 60 s d’inactivité aux échanges HTTP/TCP et 1 h aux tunnels. L’adresse cliente vue par le backend devient celle du proxy.',
      ),
      issue(
        'COMPOSE_VERSION_REQUIRED',
        '',
        'La priorité du réseau public exige Docker Compose 2.33.1 ou plus récent. Vérifier le modèle résolu avant application.',
      ),
    );
  if (endpoints.some((endpoint) => endpoint.protocol === 'tcp'))
    warnings.push(
      issue(
        'TCP_HEALTH_ONLY',
        '',
        'Une sonde TCP vérifie uniquement l’ouverture du port. TLS reste terminé par les backends ; les certificats et la disponibilité applicative ne sont pas vérifiés.',
      ),
    );
  Object.assign(summary, {
    applicable: true,
    proxyService,
    networkName,
    networkNames,
    entryNetworkName,
    serviceNetworks,
    configName,
    endpoints: endpoints.map(({ details, ...endpoint }) => endpoint),
    publicBindingsPreserved: true,
    entrypointRedundant: false,
    haproxyConfig: config,
  });
  return { source: doc.toString(), blockers, warnings, summary };
}

/** Read only our validated group metadata; never interpret arbitrary extensions as a plan. */
export function readLocalRedundancy(source) {
  try {
    const { model } = readSource(source),
      metadata = model[LOCAL_REDUNDANCY_MARKER];
    if (
      !isObject(metadata) ||
      metadata.version !== 1 ||
      metadata.mode !== 'single-engine' ||
      selection(model, metadata.serviceNames).length ||
      !Number.isInteger(metadata.replicas) ||
      metadata.replicas < 2 ||
      metadata.replicas > 4
    )
      return null;
    if (
      metadata.proxyService != null &&
      (typeof metadata.proxyService !== 'string' ||
        !NAME.test(metadata.proxyService) ||
        !Object.hasOwn(model.services, metadata.proxyService) ||
        typeof metadata.configName !== 'string' ||
        !NAME.test(metadata.configName) ||
        typeof model.configs?.[metadata.configName]?.content !== 'string')
    )
      return null;
    return structuredClone(metadata);
  } catch {
    return null;
  }
}

/** Resize the existing managed group without adding another proxy or moving ports. */
export function updateLocalRedundancyReplicas(source, options = {}) {
  if (!isObject(options)) options = {};
  const metadata = readLocalRedundancy(source),
    blockers = [],
    warnings = [];
  const replicas = options.replicas;
  const summary = {
    ...(metadata || {}),
    applicable: false,
    replicas,
    proof: 'not-tested',
    measuredRtoMs: null,
  };
  const result = () => ({ source, blockers, warnings, summary });
  if (!metadata) {
    blockers.push(
      issue(
        'PREPARATION_NOT_FOUND',
        '',
        'Le groupe de redondance existant est absent ou incomplet.',
      ),
    );
    return result();
  }
  if (!Number.isInteger(replicas) || replicas < 2 || replicas > 4)
    blockers.push(
      issue('INVALID_REPLICA_COUNT', '', 'Choisis entre deux et quatre instances par service.'),
    );
  if (
    options.serviceNames !== undefined &&
    (!Array.isArray(options.serviceNames) ||
      options.serviceNames.length !== metadata.serviceNames.length ||
      !metadata.serviceNames.every((name) => options.serviceNames.includes(name)))
  )
    blockers.push(
      issue(
        'PREPARED_GROUP_SCOPE',
        '',
        'Le réglage du nombre d’instances concerne tout le groupe déjà préparé.',
      ),
    );
  const data = analyzeRedundancyData(source, metadata.serviceNames, {
    confirmations: options.confirmations,
  });
  blockers.push(...data.blockers);
  warnings.push(...data.warnings);
  if (blockers.length) return result();
  const { doc, model } = readSource(source);
  // Recheck network and singleton constraints after any manual source edits.
  const inventoryDoc = doc.clone();
  inventoryDoc.delete(LOCAL_REDUNDANCY_MARKER);
  const network = analyzeRedundancyNetwork(inventoryDoc.toString(), metadata.serviceNames);
  blockers.push(...network.blockers);
  if (network.endpoints.length)
    blockers.push(
      issue(
        'PREPARED_PORTS_CHANGED',
        '',
        'Des ports ont été remis sur les instances ; rétablis la publication par le proxy avant de changer leur nombre.',
      ),
    );
  let config = null;
  if (metadata.proxyService) {
    const proxyNetworks = composeServiceNetworks(model.services[metadata.proxyService]);
    if (
      !metadata.entryNetworkName ||
      !Object.hasOwn(proxyNetworks, metadata.entryNetworkName) ||
      !Object.hasOwn(model.networks || {}, metadata.entryNetworkName) ||
      model.networks[metadata.entryNetworkName]?.internal
    )
      blockers.push(
        issue(
          'PROXY_ENTRY_NETWORK_CHANGED',
          metadata.proxyService,
          'Le réseau public du répartiteur a été modifié. Rétablis son entrée avant de changer la protection.',
        ),
      );
    const current = model.configs[metadata.configName].content;
    const template =
      /^  server-template replica 1-([2-4]) ([A-Za-z0-9.-]+):([0-9]+) check resolvers docker resolve-prefer ipv4 resolve-opts prevent-dup-ip init-addr none$/gm;
    const templates = [...current.matchAll(template)];
    const serverLines = current.match(/^\s*server(?:-template)?\s/gm) || [];
    const knownAliases = new Set(
      metadata.serviceNames.flatMap((name) =>
        Object.values(composeServiceNetworks(model.services[name])).flatMap(
          (network) => network?.aliases || [],
        ),
      ),
    );
    if (
      !templates.length ||
      templates.length !== serverLines.length ||
      templates.some(
        (match) =>
          Number(match[1]) !== metadata.replicas ||
          !knownAliases.has(match[2]) ||
          !portNumber(match[3]),
      )
    )
      blockers.push(
        issue(
          'PROXY_CONFIGURATION_CHANGED',
          metadata.proxyService,
          'La configuration du proxy a été modifiée hors du générateur ; son nombre de backends ne peut pas être changé automatiquement.',
        ),
      );
    else {
      config = current.replace(
        template,
        (_line, _old, alias, port) =>
          `  server-template replica 1-${replicas} ${alias}:${port} check resolvers docker resolve-prefer ipv4 resolve-opts prevent-dup-ip init-addr none`,
      );
      // Upgrade previously prepared groups so production --wait also checks routing.
      if (!/^frontend tracer_readiness$/m.test(config)) {
        const pools = [...config.matchAll(/^backend (pool_[0-9]+)$/gm)].map((match) => match[1]);
        if (pools.length !== templates.length || /\b19080\b/.test(config))
          blockers.push(
            issue(
              'PROXY_CONFIGURATION_CHANGED',
              metadata.proxyService,
              'La sonde du proxy existant doit être revue avant modification.',
            ),
          );
        else
          config +=
            `\nfrontend tracer_readiness\n  bind 127.0.0.1:${READINESS_PORT}\n  mode http\n  monitor-uri /ready\n` +
            pools.map((pool) => `  monitor fail if { nbsrv(${pool}) lt 1 }\n`).join('');
      }
    }
  }
  if (blockers.length) return result();
  for (const name of metadata.serviceNames) {
    editableService(doc, model, name);
    doc.setIn(['services', name, 'deploy'], { ...(model.services[name].deploy || {}), replicas });
    if (Object.hasOwn(model.services[name], 'scale'))
      doc.setIn(['services', name, 'scale'], replicas);
    doc.setIn(['services', name, 'restart'], 'unless-stopped');
  }
  if (metadata.proxyService) {
    editableService(doc, model, metadata.proxyService);
    const proxyNetworks = composeServiceNetworks(model.services[metadata.proxyService]);
    const otherPriorities = Object.entries(proxyNetworks)
      .filter(([name]) => name !== metadata.entryNetworkName)
      .map(([, options]) => Number(options?.gw_priority) || 0);
    doc.setIn(['services', metadata.proxyService, 'networks'], {
      ...proxyNetworks,
      [metadata.entryNetworkName]: {
        ...proxyNetworks[metadata.entryNetworkName],
        gw_priority: Math.max(1, ...otherPriorities.map((priority) => priority + 1)),
      },
    });
    doc.setIn(['configs', metadata.configName, 'content'], config);
    doc.setIn(['services', metadata.proxyService, 'healthcheck'], proxyHealthcheck());
    const existingLabels = model.services[metadata.proxyService].labels || {};
    const labels = Array.isArray(existingLabels)
      ? Object.fromEntries(
          existingLabels.map((label) => {
            const split = label.indexOf('=');
            return split < 0 ? [label, ''] : [label.slice(0, split), label.slice(split + 1)];
          }),
        )
      : existingLabels;
    doc.setIn(['services', metadata.proxyService, 'labels'], {
      ...labels,
      [PROXY_CONFIG_LABEL]: proxyConfigRevision(config),
    });
  }
  doc.setIn([LOCAL_REDUNDANCY_MARKER, 'replicas'], replicas);
  warnings.push(
    issue(
      'RESIZE_RECREATES_INSTANCES',
      '',
      'Compose ajuste le nombre d’instances et peut recréer le proxy ; les connexions actives peuvent être interrompues.',
    ),
  );
  Object.assign(summary, {
    applicable: true,
    updatedExisting: true,
    endpoints: metadata.endpoints || [],
    publicBindingsPreserved: true,
    entrypointRedundant: false,
    haproxyConfig: config,
    minimumComposeVersion: metadata.proxyService ? '2.33.1' : '2.0.0',
    image: metadata.proxyService ? model.services[metadata.proxyService].image : null,
  });
  return { source: doc.toString(), blockers, warnings, summary };
}
