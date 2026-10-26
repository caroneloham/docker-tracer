import YAML from 'yaml';
import { z } from 'zod';
import { composeSettings, composeDocument, composeRuntimeInstances } from './compose-project.mjs';

export const catalog = [
  {
    id: 'wordpress',
    name: 'WordPress',
    icon: 'wordpress',
    category: 'Sites web',
    color: '#21759b',
    description: 'Un site et sa base MariaDB, déjà reliés.',
    services: 2,
    storage: 'Site + base de données',
    port: 8080,
    target: 80,
    password: true,
    docs: 'https://hub.docker.com/_/wordpress',
    next: 'Le premier accès ouvre l’installation WordPress : langue, titre du site et compte administrateur.',
  },
  {
    id: 'nginx',
    name: 'Serveur web',
    icon: 'web',
    category: 'Sites web',
    color: '#1c8462',
    description: 'Nginx avec une page d’accueil personnalisée.',
    services: 1,
    storage: 'Page conservée dans le projet',
    port: 8081,
    target: 80,
    docs: 'https://hub.docker.com/_/nginx',
    next: 'Après démarrage, ouvre la page d’accueil. Son contenu reste modifiable dans la configuration du projet.',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    icon: 'database',
    category: 'Données',
    color: '#336791',
    description: 'Une base SQL avec stockage persistant.',
    services: 1,
    storage: 'Volume pour la base',
    port: 5432,
    target: 5432,
    password: true,
    docs: 'https://hub.docker.com/_/postgres',
    next: 'Connecte ton application au service database, port 5432. Base application, utilisateur app.',
  },
  {
    id: 'redis',
    name: 'Redis',
    icon: 'cache',
    category: 'Données',
    color: '#bd413b',
    description: 'Cache protégé par mot de passe et données persistantes.',
    services: 1,
    storage: 'Volume Redis avec journal AOF',
    port: 6379,
    target: 6379,
    password: true,
    docs: 'https://hub.docker.com/_/redis',
    next: 'Connecte ton application au service cache, port 6379, avec le mot de passe du projet.',
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    icon: 'monitor',
    category: 'Surveillance',
    color: '#348866',
    description: 'Une interface pour surveiller tes applications.',
    services: 1,
    storage: 'Volume pour les contrôles et l’historique',
    port: 3001,
    target: 3001,
    docs: 'https://github.com/louislam/uptime-kuma',
    next: 'Ouvre l’application pour créer son premier compte et choisir les services à surveiller.',
  },
  {
    id: 'custom',
    name: 'Image Docker',
    icon: 'docker',
    category: 'Personnalisé',
    color: '#2b86b4',
    description: 'Ton image, son port et un volume facultatif.',
    services: 1,
    storage: 'Au choix',
    port: 8082,
    target: 80,
    docs: 'https://docs.docker.com/reference/compose-file/services/',
    next: 'Vérifie les instructions de ton image. Les variables et autres réglages restent accessibles sur la carte.',
  },
];
export const catalogInput = z
  .object({
    templateId: z.enum(['wordpress', 'nginx', 'postgres', 'redis', 'uptime-kuma', 'custom']),
    projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    name: z.string().trim().min(1).max(80),
    hostId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    exposure: z.enum(['loopback', 'network']).default('loopback'),
    password: z.string().max(128).default(''),
    rootPassword: z.string().max(128).default(''),
    image: z.string().max(255).default('nginx:alpine'),
    targetPort: z.number().int().min(1).max(65535).default(80),
    protocol: z.enum(['http', 'tcp', 'udp']).default('http'),
    volumePath: z.string().max(1024).default(''),
  })
  .superRefine((v, ctx) => {
    if (
      ['wordpress', 'postgres', 'redis'].includes(v.templateId) &&
      (v.password.length < 16 || /[\0\r\n]/.test(v.password))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Le mot de passe doit contenir 16 à 128 caractères, sans retour à la ligne.',
        path: ['password'],
      });
    if (
      v.templateId === 'wordpress' &&
      (v.rootPassword.length < 16 ||
        /[\0\r\n]/.test(v.rootPassword) ||
        v.rootPassword === v.password)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Le mot de passe administrateur de MariaDB doit être distinct et contenir au moins 16 caractères.',
        path: ['rootPassword'],
      });
    if (v.templateId === 'custom' && (!v.image || /[\s\0$]/.test(v.image)))
      ctx.addIssue({
        code: 'custom',
        message: 'Indique une référence d’image Docker valide.',
        path: ['image'],
      });
    if (
      v.volumePath &&
      (!v.volumePath.startsWith('/') ||
        v.volumePath === '/' ||
        /[\0\r\n:$]/.test(v.volumePath) ||
        v.volumePath.split('/').includes('..'))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Le volume doit viser un dossier absolu du conteneur, par exemple /data.',
        path: ['volumePath'],
      });
  });
export function generateCatalogPassword(random = globalThis.crypto) {
  const bytes = new Uint8Array(24);
  random.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function newCatalogProjectName(name, suffix) {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42) || 'application';
  if (!/^[a-z0-9]{6,12}$/.test(suffix)) throw Error('Identifiant de projet invalide.');
  return base + '-' + suffix;
}
export function suggestCatalogPort(preferred, containers = []) {
  const occupied = new Set(
    containers.flatMap((c) => (c.ports || []).map((p) => Number(p.host)).filter(Boolean)),
  );
  for (let n = preferred; n <= 65535; n++) if (!occupied.has(n)) return n;
  for (let n = 1024; n < preferred; n++) if (!occupied.has(n)) return n;
  throw Error('Aucun port disponible dans la plage proposée.');
}
export function catalogErrorMessage(message) {
  if (/port is already allocated|address already in use/i.test(message))
    return 'Ce port d’accès est déjà utilisé. Clique sur « Modifier les réglages », choisis un autre port, puis prépare à nouveau l’installation.';
  if (/manifest unknown|manifest.*not found|pull access denied/i.test(message))
    return 'Docker ne peut pas télécharger cette image. Vérifie son nom, sa version et l’accès au registre dans les détails.';
  if (/timed out|timeout|délai.*dépassé/i.test(message))
    return 'L’opération n’a pas terminé dans le délai prévu. Vérifie l’état sur la carte et les logs avant de réessayer.';
  return message.length > 240
    ? 'L’opération n’a pas abouti. Le projet est conservé ; consulte le détail et corrige les réglages avant de réessayer.'
    : message;
}
const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function catalogConnection(compose, runtime, host) {
  let metadata;
  try {
    metadata = composeDocument((compose.lastApplied || compose).source).model[
      'x-docker-tracer-catalog'
    ];
  } catch {
    return null;
  }
  const item = catalog.find((t) => t.id === metadata?.id),
    access = metadata?.access;
  if (
    !item ||
    !access ||
    !['http', 'tcp', 'udp'].includes(access.protocol) ||
    !Number.isInteger(access.target)
  )
    return null;
  const instances = composeRuntimeInstances(runtime?.services, access.service);
  const candidates = instances
    .filter((i) => i.state === 'running')
    .flatMap((i) =>
      (i.ports || [])
        .filter(
          (p) =>
            p.container === access.target &&
            p.protocol === (access.protocol === 'udp' ? 'udp' : 'tcp'),
        )
        .map((p) => ({ ...p, health: i.health })),
    );
  const base = {
    name: item.name,
    next: item.next,
    password: !!item.password,
    service: access.service,
  };
  if (!runtime?.connected || !candidates.length)
    return {
      ...base,
      message: !runtime?.connected
        ? 'Serveur inaccessible : accès à vérifier.'
        : 'L’accès sera disponible lorsque le service démarrera et publiera son port.',
    };
  const port = candidates.find((p) => !['127.0.0.1', '::1'].includes(p.hostIp)) || candidates[0];
  if (host?.kind === 'ssh' && ['127.0.0.1', '::1'].includes(port.hostIp))
    return {
      ...base,
      message: `Port ${port.host} accessible uniquement sur le serveur SSH. Modifie l’adresse d’écoute pour un accès réseau.`,
    };
  const address =
    host?.kind === 'ssh'
      ? host.address
      : ['0.0.0.0', '::', ''].includes(port.hostIp)
        ? '127.0.0.1'
        : port.hostIp;
  if (
    typeof address !== 'string' ||
    /[^a-z0-9.:[\]_-]/i.test(address) ||
    !Number.isInteger(port.host) ||
    port.host < 1 ||
    port.host > 65535
  )
    return { ...base, message: 'Adresse d’accès à vérifier dans les ports du service.' };
  const authority =
    (address.includes(':') && !address.startsWith('[') ? `[${address}]` : address) +
    ':' +
    port.host;
  let url;
  try {
    if (access.protocol === 'http') url = new URL('http://' + authority).href;
  } catch {
    return { ...base, message: 'Adresse d’accès à vérifier.' };
  }
  return {
    ...base,
    url,
    address: authority,
    message:
      port.health === 'unhealthy'
        ? 'Le contrôle de santé est en échec. Ouvre les logs ou lance un diagnostic.'
        : 'Port publié dans Docker. L’accès réseau dépend aussi du pare-feu du serveur.',
  };
}
export function buildCatalogProject(input) {
  const v = catalogInput.parse(input),
    item = catalog.find((t) => t.id === v.templateId),
    variables = {},
    services = {},
    volumes = {},
    networks = { application: {} },
    configs = {};
  const service = (image, memory = '512m') => ({
    image,
    restart: 'unless-stopped',
    mem_limit: memory,
    cpus: 1,
    networks: ['application'],
  });
  const publish = (target, protocol = 'tcp') => [
    {
      target,
      published: String(v.port),
      protocol,
      host_ip: v.exposure === 'network' ? '0.0.0.0' : '127.0.0.1',
    },
  ];
  const mount = (name, target) => {
    volumes[name] = {};
    return { type: 'volume', source: name, target };
  };
  const health = (test, start_period = '10s') => ({
    test,
    interval: '3s',
    timeout: '3s',
    retries: 30,
    start_period,
  });
  let entryService,
    protocol = 'http',
    target = item.target;
  if (item.password) variables.SERVICE_PASSWORD = v.password;
  if (v.templateId === 'wordpress') {
    variables.DATABASE_ROOT_PASSWORD = v.rootPassword;
    networks.database = { internal: true };
    services.database = {
      ...service('mariadb:11.8', '768m'),
      networks: ['database'],
      environment: {
        MARIADB_DATABASE: 'wordpress',
        MARIADB_USER: 'app',
        MARIADB_PASSWORD: '${SERVICE_PASSWORD}',
        MARIADB_ROOT_PASSWORD: '${DATABASE_ROOT_PASSWORD}',
      },
      volumes: [mount('database-data', '/var/lib/mysql')],
      healthcheck: health(['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], '30s'),
    };
    services.wordpress = {
      ...service('wordpress:php8.3-apache', '768m'),
      networks: ['application', 'database'],
      ports: publish(80),
      environment: {
        WORDPRESS_DB_HOST: 'database:3306',
        WORDPRESS_DB_NAME: 'wordpress',
        WORDPRESS_DB_USER: 'app',
        WORDPRESS_DB_PASSWORD: '${SERVICE_PASSWORD}',
      },
      depends_on: { database: { condition: 'service_healthy' } },
      volumes: [mount('wordpress-data', '/var/www/html')],
      healthcheck: health(['CMD', 'php', '-r', 'exit(@fsockopen("127.0.0.1",80) ? 0 : 1);'], '30s'),
    };
    entryService = 'wordpress';
  } else if (v.templateId === 'nginx') {
    const title = escapeHtml(v.name);
    configs.homepage = {
      content:
        `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title><style>body{font:18px system-ui;max-width:760px;margin:15vh auto;padding:24px;color:#17334d}small{color:#5b7180}</style><small>DOCKER TRACER</small><h1>${title}</h1><p>Votre serveur web est prêt.</p><p>Cette page peut être modifiée dans la configuration du projet.</p></html>`.replaceAll(
          '$',
          '$$$$',
        ),
    };
    services.web = {
      ...service('nginx:alpine', '128m'),
      ports: publish(80),
      configs: [{ source: 'homepage', target: '/usr/share/nginx/html/index.html' }],
      healthcheck: health(['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']),
    };
    entryService = 'web';
  } else if (v.templateId === 'postgres') {
    services.database = {
      ...service('postgres:17-alpine'),
      ports: publish(5432),
      environment: {
        POSTGRES_DB: 'application',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: '${SERVICE_PASSWORD}',
      },
      volumes: [mount('database-data', '/var/lib/postgresql/data')],
      healthcheck: health(['CMD', 'pg_isready', '-U', 'app', '-d', 'application']),
    };
    entryService = 'database';
    protocol = 'tcp';
  } else if (v.templateId === 'redis') {
    services.cache = {
      ...service('redis:7-alpine', '256m'),
      ports: publish(6379),
      environment: { REDIS_PASSWORD: '${SERVICE_PASSWORD}' },
      command: ['redis-server', '--appendonly', 'yes', '--requirepass', '${SERVICE_PASSWORD}'],
      volumes: [mount('redis-data', '/data')],
      healthcheck: health([
        'CMD-SHELL',
        'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG',
      ]),
    };
    entryService = 'cache';
    protocol = 'tcp';
  } else if (v.templateId === 'uptime-kuma') {
    services.monitoring = {
      ...service('louislam/uptime-kuma:2', '768m'),
      ports: publish(3001),
      volumes: [mount('monitoring-data', '/app/data')],
    };
    entryService = 'monitoring';
  } else {
    target = v.targetPort;
    protocol = v.protocol;
    entryService = 'application';
    services.application = {
      ...service(v.image),
      ports: publish(target, protocol === 'udp' ? 'udp' : 'tcp'),
      ...(v.volumePath ? { volumes: [mount('application-data', v.volumePath)] } : {}),
    };
  }
  const model = {
    'x-docker-tracer-catalog': {
      id: item.id,
      version: 1,
      access: { service: entryService, target, protocol },
      next: item.next,
    },
    services,
    networks,
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(Object.keys(configs).length ? { configs } : {}),
  };
  const source =
    '# Infrastructure créée avec Docker Tracer. Tous les réglages restent modifiables.\n' +
    YAML.stringify(model);
  return {
    name: v.name,
    hostId: v.hostId,
    compose: composeSettings.parse({
      projectName: v.projectName,
      source,
      variables,
      waitSeconds: 180,
    }),
  };
}
