import { composeDocument } from './compose-project.mjs';

// This is a configuration analysis, not a storage probe or a migration engine.
// Primary references checked 2026-10-19:
// https://docs.docker.com/reference/compose-file/services/#volumes
// https://docs.openwebui.com/getting-started/advanced-topics/scaling/
// https://caddyserver.com/docs/automatic-https#storage
const statefulImages = [
  [
    /^(postgres|postgresql|timescaledb|pgvector)(?:[-_.]|$)/,
    'PostgreSQL',
    'DATABASE_REPLICATION_REQUIRED',
  ],
  [/^(mysql|mariadb|percona)(?:[-_.]|$)/, 'MySQL / MariaDB', 'DATABASE_REPLICATION_REQUIRED'],
  [/^(sqlite|sqlite3|rqlite)(?:[-_.]|$)/, 'SQLite', 'SQLITE_SINGLE_WRITER'],
  [
    /^(mongo|mongodb|cockroach|cockroachdb)(?:[-_.]|$)/,
    'Base de données',
    'DATABASE_REPLICATION_REQUIRED',
  ],
  [
    /^(redis|valkey|keydb|dragonfly)(?:[-_.]|$)/,
    'Redis / cache / coordination',
    'CACHE_ROLE_UNVERIFIED',
  ],
  [
    /^(rabbitmq|kafka|redpanda|nats|activemq|rocketmq)(?:[-_.]|$)/,
    'File de messages',
    'QUEUE_REPLICATION_REQUIRED',
  ],
  [
    /^(chroma|chromadb|qdrant|weaviate|milvus|elasticsearch|opensearch)(?:[-_.]|$)/,
    'Base vectorielle / index',
    'VECTOR_DATA_REPLICATION_REQUIRED',
  ],
];
const variable = (value) => /\$(?:\{|[A-Za-z_])/.test(String(value ?? ''));
const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const envMap = (environment) =>
  Array.isArray(environment)
    ? Object.fromEntries(
        environment.map((entry) => {
          const index = entry.indexOf('=');
          return index < 0 ? [entry, null] : [entry.slice(0, index), entry.slice(index + 1)];
        }),
      )
    : environment || {};
const imageName = (image) =>
  String(image || '')
    .split('/')
    .at(-1)
    .split(/[:@]/)[0]
    .toLowerCase();
const diagnostic = (code, service, message, action) => ({
  code,
  service,
  scope: service || 'selection',
  message,
  action,
  resolution: action,
});

function shortMount(value) {
  // A Windows drive letter is not a separator in Compose's short syntax.
  const parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== ':') continue;
    if (
      index === start + 1 &&
      /^[A-Za-z]$/.test(value[start]) &&
      /[\\/]/.test(value[index + 1] || '')
    )
      continue;
    parts.push(value.slice(start, index));
    start = index + 1;
  }
  parts.push(value.slice(start));
  if (parts.length > 3 || parts.some((part) => !part)) return { invalid: true };
  const source = parts.length > 1 ? parts[0] : null;
  const target = parts.length > 1 ? parts[1] : parts[0];
  const modes = (parts[2] || '').split(',').filter(Boolean);
  if (modes.includes('ro') && modes.includes('rw')) return { invalid: true };
  return {
    source,
    target,
    type: source && /^(?:[./~\\]|[A-Za-z]:[\\/])/.test(source) ? 'bind' : 'volume',
    readOnly: modes.includes('ro'),
    invalid: variable(value) || !/^(?:\/|[A-Za-z]:[\\/])/.test(target),
  };
}

function mountInfo(value) {
  if (typeof value === 'string') return shortMount(value);
  if (!value || typeof value !== 'object') return { invalid: true };
  const type = value.type || 'volume';
  return {
    type,
    source: value.source || null,
    target: value.target,
    readOnly: value.read_only === true,
    invalid:
      !['bind', 'volume', 'tmpfs', 'image'].includes(type) ||
      typeof value.target !== 'string' ||
      !value.target ||
      variable(value.target) ||
      variable(value.source) ||
      (value.read_only != null && typeof value.read_only !== 'boolean') ||
      (['bind', 'image'].includes(type) && !value.source),
  };
}

function hasGpu(service, environment) {
  const devices = list(service.deploy?.resources?.reservations?.devices);
  return (
    (service.gpus != null && service.gpus !== false && list(service.gpus).length > 0) ||
    service.runtime === 'nvidia' ||
    devices.some(
      (device) => device?.driver === 'nvidia' || list(device?.capabilities).flat().includes('gpu'),
    ) ||
    list(service.devices).some((device) => /gpu|nvidia|\/dev\/(?:dri|kfd)/i.test(String(device))) ||
    ['NVIDIA_VISIBLE_DEVICES', 'CUDA_VISIBLE_DEVICES'].some(
      (key) =>
        environment[key] != null &&
        !['', 'none', 'void', '-1'].includes(String(environment[key]).toLowerCase()),
    )
  );
}

function databaseReference(environment) {
  return Object.entries(environment).filter(([key]) =>
    /^(?:DATABASE_URL|SQLALCHEMY_DATABASE_URI|DB_CONNECTION|DB_TYPE|DATABASE_TYPE|DB_ENGINE|DATABASE_HOST|DB_HOST|POSTGRES_HOST|MYSQL_HOST)$/.test(
      key,
    ),
  );
}

function dependencies(service, environment, services) {
  const found = new Set(
    Array.isArray(service.depends_on) ? service.depends_on : Object.keys(service.depends_on || {}),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (!/(?:^|_)(?:URLS?|URI|HOST|HOSTNAME|SERVER|SERVICE)$/.test(key)) continue;
    if (typeof value !== 'string' || variable(value)) continue;
    let host = value;
    try {
      host = new URL(value).hostname;
    } catch {
      /* A host-only reference may still name a service. */
    }
    if (Object.hasOwn(services, host)) found.add(host);
  }
  return [...found];
}

/**
 * Analyze only the selected services; dependencies stay in place and are reported.
 * options.confirmations.statelessServices is an explicit operator attestation that
 * sessions, files, jobs and other required state tolerate concurrent instances.
 * It never overrides evidence of durable state, writable mounts or GPU contention.
 * No credentials, environment values, Compose source or migration commands are returned.
 */
export function analyzeRedundancyData(source, selectedServiceNames, options = {}) {
  const { model } = composeDocument(source);
  const allServices = model.services || {};
  const selected = [...new Set(selectedServiceNames ?? Object.keys(allServices))];
  const confirmed = new Set(list(options.confirmations?.statelessServices));
  const result = { services: [], data: [], blockers: [], warnings: [] };
  const addData = (name, key, properties) =>
    result.data.push({
      id: `${name}:${key}`,
      serviceIds: [name],
      adapter: null,
      evidence: { state: 'unverified', method: 'compose-config' },
      ...properties,
    });

  for (const name of selected) {
    const service = allServices[name];
    if (!service) {
      result.blockers.push(
        diagnostic(
          'SERVICE_NOT_FOUND',
          name,
          `Le service « ${name} » est absent du Compose principal.`,
          'Actualiser la sélection des services.',
        ),
      );
      continue;
    }
    const start = result.blockers.length;
    const environment = envMap(service.environment);
    const image = imageName(service.image);
    const known = statefulImages.find(([pattern]) => pattern.test(image));
    const webui = /^(?:open-webui|openwebui)(?:[-_.]|$)/.test(image);
    const caddy = /^caddy(?:[-_.]|$)/.test(image);
    const inference =
      /^(?:vllm|ollama|llama-server|llamacpp|llama\.cpp|text-generation-inference|tritonserver)(?:[-_.]|$)/.test(
        image,
      );
    const refs = databaseReference(environment);
    const sqlite =
      refs.some(([, value]) =>
        /^(?:sqlite(?:3)?(?:\+[^:]+)?(?::|$)|.*\.(?:sqlite3?|db)$)/i.test(String(value || '')),
      ) || /(?:^|\s)sqlite3?(?:\s|$)/i.test(list(service.command).join(' '));
    const localChroma =
      String(environment.VECTOR_DB || '').toLowerCase() === 'chroma' &&
      !environment.CHROMA_HTTP_HOST;
    let classification =
      known || webui || caddy || sqlite || localChroma
        ? 'stateful'
        : inference
          ? 'inference'
          : 'unknown';
    const reasons = [];
    const block = (code, message, action) => {
      reasons.push(message);
      result.blockers.push(diagnostic(code, name, message, action));
    };
    const warn = (code, message, action) =>
      result.warnings.push(diagnostic(code, name, message, action));

    const sysctls = envMap(service.sysctls);
    if (
      service['x-docker-tracer']?.kind === 'router' ||
      service.privileged ||
      list(service.cap_add).some((cap) =>
        ['NET_ADMIN', 'ALL'].includes(String(cap).toUpperCase()),
      ) ||
      ['net.ipv4.ip_forward', 'net.ipv6.conf.all.forwarding'].some(
        (key) => String(sysctls[key]) === '1',
      )
    ) {
      block(
        'NETWORK_APPLIANCE_UNSUPPORTED',
        'Ce service contrôle le réseau. Deux copies ne font pas basculer les routes ou les tunnels.',
        'Conserver cet équipement unique ; sa redondance demande un protocole réseau adapté.',
      );
    }

    if (known) {
      const [, , code] = known;
      const action =
        code === 'SQLITE_SINGLE_WRITER'
          ? 'Garder le service unique, ou migrer SQLite selon la documentation de l’application avant de créer plusieurs instances.'
          : code === 'CACHE_ROLE_UNVERIFIED'
            ? 'Garder cette instance commune ; vérifier si elle porte un cache jetable, des sessions, une file ou des données avant tout plan spécifique.'
            : 'Garder ce service en instance unique et redonder ses clients ; préparer séparément la réplication native de ce moteur si nécessaire.';
      block(
        code,
        `${known[1]} : une deuxième instance ne partage ni les écritures ni le rôle de la première.`,
        action,
      );
      addData(name, 'engine', {
        source: known[1],
        kind: 'application-state',
        access: 'single-writer',
        strategy: code === 'SQLITE_SINGLE_WRITER' ? 'manual' : 'native-replication',
      });
    }
    if (sqlite && !known) {
      block(
        'SQLITE_SINGLE_WRITER',
        'SQLite local détecté : la duplication générique ne vérifie pas la coordination des écritures et la reprise.',
        'Garder le service unique, ou migrer la base selon la documentation de l’application avant de créer plusieurs instances.',
      );
      addData(name, 'sqlite', {
        source: 'SQLite local',
        kind: 'application-state',
        access: 'single-writer',
        strategy: 'manual',
      });
    }
    if (localChroma && !webui) {
      block(
        'CHROMA_LOCAL_STATE',
        'Chroma local conserve un index et une base locale dont le partage entre processus n’est pas validé.',
        'Utiliser un service Chroma HTTP commun ou une base vectorielle compatible, puis vérifier la migration.',
      );
      addData(name, 'chroma', {
        source: 'Chroma local',
        kind: 'application-state',
        access: 'single-writer',
        strategy: 'manual',
      });
    }
    if (webui) {
      block(
        'OPENWEBUI_STATE_UNVERIFIED',
        'Open WebUI conserve aussi des fichiers, un index vectoriel et des états de session ; une base SQL externe ne suffit pas.',
        'Vérifier PostgreSQL, Redis et la coordination WebSocket, la base vectorielle commune, les fichiers partagés et les mêmes secrets de session pour cette version.',
      );
      addData(name, 'webui', {
        source: 'Fichiers, vecteurs et sessions Open WebUI',
        kind: 'application-state',
        access: 'unknown',
        strategy: 'manual',
      });
    }
    if (caddy) {
      block(
        'TLS_STORAGE_UNVERIFIED',
        'Caddy peut gérer certificats, clés et autorité locale ; sa configuration de stockage TLS n’a pas été inspectée.',
        'Garder Caddy en entrée commune, ou vérifier son stockage partagé et sa coordination des certificats avant de le dupliquer.',
      );
      addData(name, 'tls', {
        source: 'Stockage TLS Caddy',
        kind: 'application-state',
        access: 'unknown',
        strategy: 'manual',
      });
    }

    for (const [index, value] of list(service.volumes).entries()) {
      const mount = mountInfo(value);
      const label = mount.target && !variable(mount.target) ? mount.target : `montage ${index + 1}`;
      const ephemeral = mount.type === 'tmpfs';
      const readOnly = mount.readOnly || mount.type === 'image';
      addData(name, `mount:${index + 1}`, {
        source:
          mount.type === 'volume' && mount.source && !variable(mount.source)
            ? `volume:${mount.source}`
            : `${mount.type || 'unknown'}:${index + 1}`,
        target: label,
        kind: mount.type || 'unknown',
        access: mount.invalid
          ? 'unknown'
          : ephemeral
            ? 'ephemeral'
            : readOnly
              ? 'read-only'
              : 'single-writer',
        strategy: mount.invalid
          ? 'blocked'
          : ephemeral
            ? 'ephemeral'
            : readOnly
              ? 'shared-read-only'
              : 'blocked',
      });
      if (mount.invalid) {
        block(
          'MOUNT_UNRESOLVED',
          `${label} : le type, le chemin ou le mode de montage ne peut pas être déterminé.`,
          'Résoudre la configuration Compose et déclarer explicitement le type et le mode du montage.',
        );
      } else if (ephemeral) {
        warn(
          'EPHEMERAL_STATE',
          `${label} est temporaire et propre à chaque instance.`,
          'Vérifier que sa perte et son absence sur l’autre instance sont acceptables.',
        );
      } else if (readOnly) {
        warn(
          'READ_ONLY_CONTENT_UNVERIFIED',
          `${label} est déclaré en lecture seule pour ce service.`,
          'Vérifier la présence et le contenu de cette même référence sur la machine ; le mode lecture seule n’empêche pas un autre processus de modifier la source.',
        );
      } else {
        classification = 'stateful';
        block(
          'WRITABLE_VOLUME_UNSAFE',
          `${label} est accessible en écriture ; dupliquer le montage ne prouve pas que deux instances peuvent écrire ensemble.`,
          'Garder le service unique, externaliser cet état, ou passer ce montage en lecture seule uniquement si l’application le permet.',
        );
      }
    }

    for (const kind of ['configs', 'secrets']) {
      for (const [index, reference] of list(service[kind]).entries()) {
        const ref = typeof reference === 'string' ? reference : reference?.source;
        const valid =
          typeof ref === 'string' && !variable(ref) && Object.hasOwn(model[kind] || {}, ref);
        addData(name, `${kind}:${index + 1}`, {
          source: valid ? `${kind}:${ref}` : `${kind}:${index + 1}`,
          kind,
          access: 'read-only',
          strategy: valid ? 'shared-read-only' : 'blocked',
        });
        if (!valid)
          block(
            'READ_ONLY_REFERENCE_UNRESOLVED',
            `Une référence ${kind} n’est pas déclarée dans le Compose principal.`,
            'Résoudre et vérifier la référence avant de préparer une deuxième instance.',
          );
      }
    }
    if (list(service.volumes_from).length)
      block(
        'INHERITED_MOUNTS_UNVERIFIED',
        'volumes_from hérite de montages dont le partage n’est pas vérifié.',
        'Déclarer et analyser chaque montage avant de dupliquer ce service.',
      );
    if (list(service.tmpfs).length)
      warn(
        'EPHEMERAL_STATE',
        'Les fichiers tmpfs restent propres à chaque instance et disparaissent à son arrêt.',
        'Vérifier que seuls des fichiers temporaires y sont écrits.',
      );
    if (list(service.env_file).length)
      warn(
        'ENV_FILE_UNINSPECTED',
        'Les fichiers env_file ne sont pas lus par cette analyse.',
        'Vérifier que leurs réglages concordent avec la confirmation sans état et avec la configuration résolue.',
      );

    if (hasGpu(service, environment))
      block(
        'GPU_CAPACITY_UNVERIFIED',
        'Les instances utiliseraient les ressources GPU de la même machine ; la mémoire et les périphériques ne sont pas réservés séparément.',
        'Vérifier VRAM, capacité et affectation des GPU pour deux moteurs simultanés avant une préparation dédiée.',
      );
    if (inference)
      warn(
        'INFERENCE_WARMUP_REQUIRED',
        'Le deuxième moteur doit charger le modèle avant de recevoir des requêtes ; une génération en cours peut être interrompue.',
        'Vérifier le modèle, la capacité mémoire et une sonde de disponibilité après échauffement.',
      );

    const externalRefs = refs.filter(
      ([key, value]) =>
        /(?:URL|URI|HOST)$/.test(key) &&
        value != null &&
        !/^(?:sqlite|.*\.(?:sqlite3?|db)$)/i.test(String(value)),
    );
    if (externalRefs.length) {
      addData(name, 'database-reference', {
        source: externalRefs.map(([key]) => key).join(', '),
        kind: 'external-dependency',
        access: 'unknown',
        strategy: 'external',
      });
      warn(
        'EXTERNAL_DATABASE_DEPENDENCY',
        'Une référence de connexion à une base est présente ; elle ne prouve ni la disponibilité de la base ni l’absence d’autres états locaux.',
        'Conserver la connexion existante et vérifier les écritures concurrentes, les migrations au démarrage et les autres états de l’application.',
      );
    }
    for (const dependency of dependencies(service, environment, allServices)) {
      if (dependency === name || selected.includes(dependency)) continue;
      const exists = Object.hasOwn(allServices, dependency);
      addData(name, `dependency:${dependency}`, {
        source: dependency,
        kind: 'service-dependency',
        access: 'unknown',
        strategy: 'external',
      });
      warn(
        exists ? 'DEPENDENCY_SINGLE_INSTANCE' : 'DEPENDENCY_NOT_IN_COMPOSE',
        `La dépendance « ${dependency} » reste commune, hors du périmètre redondé.`,
        'La conserver dans le Compose ; la panne de cette dépendance reste hors de la protection contre l’arrêt d’une instance applicative.',
      );
    }

    if (!known && !webui && !caddy && !sqlite && !localChroma) {
      if (confirmed.has(name)) {
        if (classification === 'unknown') classification = 'stateless';
        reasons.push(
          'Absence d’état requis entre instances confirmée explicitement par l’utilisateur.',
        );
      } else {
        block(
          'STATE_UNCLASSIFIED',
          'L’image et l’absence de volume ne prouvent pas que les sessions, fichiers ou tâches peuvent être répartis entre plusieurs instances.',
          'Confirmer explicitement que l’application accepte plusieurs instances et que son état nécessaire est externe ou jetable.',
        );
      }
    }
    if (result.blockers.length === start)
      warn(
        'LOCAL_CAPACITY_REQUIRED',
        'Les instances démarrées simultanément partagent le CPU et la RAM de cette machine.',
        'Vérifier la capacité disponible pour deux instances et la charge attendue après l’arrêt de l’une d’elles.',
      );
    result.services.push({
      name,
      classification,
      strategy: result.blockers.length > start ? 'blocked' : 'active-active',
      reasons,
    });
  }
  return result;
}
