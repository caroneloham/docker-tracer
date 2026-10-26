import YAML from 'yaml';
import { z } from 'zod';
import { composeDocument, composeSettings } from './compose-project.mjs';
import { generateCatalogPassword } from './catalog.mjs';
import { aiModelVllmArgs, aiModelWeightGiB, findAiModel } from './ai-models.mjs';

export const AI_EXTENSION = 'x-docker-tracer-ai';
const port = z.number().int().min(1).max(65535);
const image = z
  .string()
  .max(250)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/, 'Référence d’image invalide.');
const modelId = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]+$/, 'Identifiant de modèle invalide.');
const hostname = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    'Indique un nom DNS ou une IPv4, sans protocole ni port.',
  );
const databaseHost = z
  .string()
  .trim()
  .max(253)
  .refine(
    (value) =>
      !value.startsWith('[') ||
      (value.endsWith(']') && z.ipv6().safeParse(value.slice(1, -1)).success),
    'Les crochets sont réservés à une adresse IPv6 valide.',
  )
  .transform((value) => value.replace(/^\[([^\]]+)\]$/, '$1'))
  .refine(
    (value) => !value || hostname.safeParse(value).success || z.ipv6().safeParse(value).success,
    'Indique un nom DNS, une IPv4 ou une IPv6, sans protocole ni port.',
  );
const databaseIdentifier = z
  .string()
  .trim()
  .min(1, 'Ce champ est obligatoire.')
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Caractères de contrôle interdits.');
export const aiSchema = z
  .object({
    client: z.string().trim().min(1, 'Indique le nom du client.').max(80),
    environment: z.enum(['test', 'production']).default('test'),
    domain: hostname.default('ia.home.arpa'),
    bindIp: z.union([z.literal('0.0.0.0'), z.ipv4()]).default('127.0.0.1'),
    httpsPort: port.default(8443),
    httpPort: port.default(8080),
    tls: z.enum(['internal', 'provided', 'public']).default('internal'),
    acmeEmail: z.string().max(200).default(''),
    adminEmail: z.email('Adresse administrateur invalide.'),
    model: modelId.default('Qwen/Qwen3-8B'),
    modelRevision: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._/-]*$/)
      .default(''),
    parametersB: z.number().min(0.1).max(1000).default(8),
    dtype: z.enum(['auto', 'half', 'bfloat16']).default('auto'),
    wslCompatibility: z.boolean().optional(),
    eagerExecution: z.boolean().optional(),
    toolMode: z.enum(['chat', 'native']).optional(),
    toolParser: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,60}$/, 'Format d’appels d’outils invalide.')
      .optional(),
    startupMinutes: z.number().int().min(2).max(30).optional(),
    gpuIds: z
      .array(z.string().regex(/^(?:\d+|GPU-[a-fA-F0-9-]+)$/))
      .min(1)
      .max(16)
      .default(['0']),
    gpuName: z.string().max(80).default('NVIDIA · à préciser'),
    vramGiB: z.number().min(1).max(1024).default(24),
    ramGiB: z.number().min(8).max(4096).default(32),
    diskGiB: z.number().min(20).max(100000).default(100),
    maxModelLen: z.number().int().min(512).max(1048576).default(8192),
    maxSequences: z.number().int().min(1).max(1024).default(8),
    gpuMemory: z.number().min(0.1).max(0.95).default(0.85),
    shmGiB: z.number().int().min(1).max(128).default(4),
    webRamGiB: z.number().min(2).max(256).default(4),
    inferenceCpus: z.number().min(1).max(1024).optional(),
    inferenceRamGiB: z.number().min(2).max(4096).optional(),
    modelStorageRoot: z
      .string()
      .max(240)
      .regex(/^\/(?:[a-zA-Z0-9_ .-]+\/?)*$/, 'Choisis un dossier absolu Linux pour les modèles.')
      .refine(
        (s) => !s.split('/').some((part) => part === '.' || part === '..'),
        'Chemin de stockage invalide.',
      )
      .optional(),
    enginePort: port.default(8000),
    webPort: port.default(8080),
    embeddingModel: modelId.default('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'),
    embeddingAutoUpdate: z.boolean().optional(),
    chunkSize: z.number().int().min(100).max(16000).default(1000),
    chunkOverlap: z.number().int().min(0).max(8000).default(100),
    ragTopK: z.number().int().min(1).max(50).default(5),
    database: z.preprocess(
      (value) =>
        value && typeof value === 'object' && (value.mode === undefined || value.mode === 'managed')
          ? { mode: 'managed' }
          : value,
      z
        .object({
          mode: z.enum(['managed', 'external']).default('managed'),
          host: databaseHost.default(''),
          port: port.default(5432),
          name: z
            .string()
            .trim()
            .max(63)
            .regex(
              /^[a-zA-Z0-9_.-]+$/,
              'Nom PostgreSQL : lettres, chiffres, tirets, points ou underscores.',
            )
            .default('webui'),
          user: databaseIdentifier.default('webui'),
          sslMode: z.enum(['disable', 'prefer', 'require']).default('require'),
        })
        .prefault({}),
    ),
    tools: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(80),
          url: z.url().refine((s) => {
            const u = new URL(s);
            return (
              ['http:', 'https:'].includes(u.protocol) &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash
            );
          }, 'URL HTTP(S) sans identifiants, paramètres ni fragment.'),
          path: z
            .string()
            .max(200)
            .regex(/^[a-zA-Z0-9_./-]+$/)
            .default('openapi.json'),
          auth: z.enum(['none', 'bearer']).default('none'),
        }),
      )
      .max(8)
      .default([]),
    images: z
      .object({
        caddy: image.default('caddy:2.10.2-alpine'),
        webui: image.default('ghcr.io/open-webui/open-webui:v0.11.1'),
        vllm: image.default('vllm/vllm-openai:v0.29.0'),
        postgres: image.default('postgres:17-alpine'),
      })
      .prefault({}),
  })
  .superRefine((v, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.database.mode === 'external' && !v.database.host)
      ctx.addIssue({
        code: 'custom',
        path: ['database', 'host'],
        message: 'Indique le serveur PostgreSQL externe.',
      });
    if (new Set(v.gpuIds).size !== v.gpuIds.length)
      issue('gpuIds', 'Chaque GPU doit avoir un identifiant distinct.');
    if (v.toolMode === 'native' && !v.toolParser)
      issue('toolParser', 'Indique le format d’appels d’outils compatible avec ton modèle.');
    if (v.toolMode === 'chat' && v.tools.length)
      issue('toolMode', 'Choisis le mode avec outils pour connecter des API au modèle.');
    if (v.chunkOverlap >= v.chunkSize)
      issue('chunkOverlap', 'Le chevauchement doit être inférieur à la taille des fragments.');
    if (v.httpsPort === v.httpPort)
      issue('httpsPort', 'Les ports HTTP et HTTPS doivent être distincts.');
    if (v.webRamGiB >= v.ramGiB)
      issue('webRamGiB', 'Laisse de la RAM pour vLLM, PostgreSQL et Ubuntu.');
    if (v.inferenceRamGiB && v.inferenceRamGiB + v.webRamGiB + 2 > v.ramGiB)
      issue('inferenceRamGiB', 'Le budget RAM doit laisser au moins 2 Gio aux autres services.');
    if (v.inferenceRamGiB && v.shmGiB >= v.inferenceRamGiB)
      issue('shmGiB', 'La mémoire partagée doit rester inférieure à la limite RAM du moteur.');
    if (v.tls === 'public') {
      if (v.httpsPort !== 443 || v.httpPort !== 80)
        issue('httpsPort', 'Le profil certificat public utilise les ports 80 et 443.');
      if (!z.email().safeParse(v.acmeEmail).success)
        issue('acmeEmail', 'Indique un email pour le certificat public.');
      if (
        !v.domain.includes('.') ||
        z.ipv4().safeParse(v.domain).success ||
        /\.(local|internal|arpa)$/.test(v.domain)
      )
        issue(
          'domain',
          'Le certificat public nécessite un domaine public qui pointe vers ce serveur.',
        );
    }
  });

export function defaultAiSettings() {
  return aiSchema.parse({
    client: 'Nouveau client',
    adminEmail: 'admin@example.com',
    startupMinutes: 20,
    embeddingAutoUpdate: false,
    toolMode: 'native',
    toolParser: 'hermes',
  });
}
export function newAiSecrets() {
  return Object.fromEntries(
    ['AI_ADMIN_PASSWORD', 'AI_DB_PASSWORD', 'AI_WEBUI_SECRET', 'AI_ENGINE_KEY'].map((key) => [
      key,
      generateCatalogPassword(),
    ]),
  );
}
export function aiUrl(v) {
  return `https://${v.domain}${v.httpsPort === 443 ? '' : ':' + v.httpsPort}`;
}
export function aiSizing(input) {
  const v = aiSchema.parse(input),
    weights = aiModelWeightGiB(v.model, v.parametersB);
  return {
    weightsGiB: Math.round(weights * 10) / 10,
    budgetGiB: Math.round(v.gpuIds.length * v.vramGiB * v.gpuMemory * 10) / 10,
    fitsWeights: weights < v.gpuIds.length * v.vramGiB * v.gpuMemory,
  };
}
export function validateAiSecrets(input, settings) {
  const values = { ...input };
  const externalDatabase = settings.database?.mode === 'external';
  for (const key of [
    'AI_ADMIN_PASSWORD',
    ...(!externalDatabase ? ['AI_DB_PASSWORD'] : []),
    'AI_WEBUI_SECRET',
    'AI_ENGINE_KEY',
  ]) {
    const value = values[key];
    const minimum = key === 'AI_ADMIN_PASSWORD' ? 8 : 16;
    if (
      typeof value !== 'string' ||
      value.length < minimum ||
      value.length > 72 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw Error(
        key === 'AI_ADMIN_PASSWORD'
          ? 'Mot de passe initial : 8 à 72 caractères, sans caractères de contrôle.'
          : `Secret ${key} : 16 à 72 caractères, sans caractères de contrôle.`,
      );
  }
  if (!externalDatabase && !/^[a-zA-Z0-9_-]+$/.test(values.AI_DB_PASSWORD))
    throw Error(
      'Le mot de passe PostgreSQL doit utiliser des lettres, chiffres, tirets ou underscores.',
    );
  if (externalDatabase) {
    const password = values.AI_EXTERNAL_DB_PASSWORD;
    if (
      typeof password !== 'string' ||
      !password.trim() ||
      password.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(password)
    )
      throw Error(
        'Indique le mot de passe PostgreSQL externe, sans caractères de contrôle (1 à 1024 caractères).',
      );
    const db = settings.database,
      host = db.host.includes(':') ? `[${db.host}]` : db.host,
      encode = (value) =>
        encodeURIComponent(value).replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
    values.AI_EXTERNAL_DATABASE_URL = `postgresql://${encode(db.user)}:${encode(password)}@${host}:${db.port}/${encode(db.name)}?sslmode=${db.sslMode}`;
  } else {
    delete values.AI_EXTERNAL_DATABASE_URL;
  }
  if (settings.tls === 'provided') {
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+-----END CERTIFICATE-----\s*$/.test(
        values.AI_TLS_CERT || '',
      )
    )
      throw Error('Importe le certificat PEM et sa chaîne.');
    if (
      !/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\r?\n[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/.test(
        values.AI_TLS_KEY || '',
      )
    )
      throw Error('Importe une clé privée PEM non chiffrée.');
  }
  settings.tools.forEach((t, i) => {
    if (t.auth === 'bearer' && !values['AI_TOOL_KEY_' + i]?.trim())
      throw Error(`Indique la clé de l’outil ${t.name}.`);
  });
  const connections = settings.tools.map((t, i) => ({
    type: 'openapi',
    url: t.url,
    spec_type: 'url',
    spec: '',
    path: t.path,
    auth_type: t.auth,
    key: t.auth === 'bearer' ? values['AI_TOOL_KEY_' + i] : '',
    config: { enable: true },
    info: { id: 'client-tool-' + i, name: t.name, description: '' },
  }));
  values.AI_TOOL_CONNECTIONS = JSON.stringify(connections);
  return values;
}

export function aiModelStoragePath(root, projectName) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName || ''))
    throw Error('Nom de projet de stockage invalide.');
  return `${root.replace(/\/+$/, '')}/docker-tracer/${projectName}/models`;
}
export function aiComposeModel(input, projectName, { legacyModelCatalog = false } = {}) {
  const v = aiSchema.parse(input),
    literal = (s) => s.replaceAll('$', '$$'),
    externalDatabase = v.database.mode === 'external',
    catalogModel = legacyModelCatalog ? undefined : findAiModel(v.model);
  const health = (test, start = '30s') => ({
    test,
    interval: '10s',
    timeout: '5s',
    retries: 12,
    start_period: start,
  });
  const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
  const common = { restart: 'unless-stopped', logging };
  const uri = aiUrl(v);
  const caddyfile = `${v.tls === 'public' ? '{\n  email ' + v.acmeEmail + '\n}\n' : '{\n  auto_https disable_redirects\n}\nhttp://' + v.domain + ':80 {\n  redir ' + uri + '{uri} permanent\n}\n'}https://${v.domain} {\n  ${v.tls === 'internal' ? 'tls internal' : v.tls === 'provided' ? 'tls /run/secrets/ai_tls_cert /run/secrets/ai_tls_key' : ''}\n  reverse_proxy webui:${v.webPort}\n}\n`;
  const services = {
    caddy: {
      ...common,
      image: v.images.caddy,
      ports: [
        { target: 443, published: String(v.httpsPort), host_ip: v.bindIp, protocol: 'tcp' },
        { target: 80, published: String(v.httpPort), host_ip: v.bindIp, protocol: 'tcp' },
      ],
      networks: ['access'],
      configs: [{ source: 'ai_caddyfile', target: '/etc/caddy/Caddyfile' }],
      volumes: ['caddy_data:/data', 'caddy_config:/config'],
      depends_on: { webui: { condition: 'service_healthy' } },
      ...(v.tls === 'provided' ? { secrets: ['ai_tls_cert', 'ai_tls_key'] } : {}),
    },
    webui: {
      ...common,
      image: v.images.webui,
      mem_limit: `${v.webRamGiB}g`,
      networks: ['access', 'inference', ...(!externalDatabase ? ['data'] : [])],
      environment: {
        PORT: String(v.webPort),
        WEBUI_URL: uri,
        WEBUI_NAME: literal(v.client + ' · IA interne'),
        WEBUI_AUTH: 'true',
        ENABLE_SIGNUP: 'false',
        DEFAULT_USER_ROLE: 'pending',
        WEBUI_ADMIN_EMAIL: literal(v.adminEmail),
        WEBUI_ADMIN_PASSWORD: '${AI_ADMIN_PASSWORD}',
        WEBUI_SECRET_KEY: '${AI_WEBUI_SECRET}',
        ENABLE_PERSISTENT_CONFIG: 'false',
        ENABLE_OLLAMA_API: 'false',
        ENABLE_OPENAI_API: 'true',
        OPENAI_API_BASE_URL: `http://inference:${v.enginePort}/v1`,
        OPENAI_API_KEY: '${AI_ENGINE_KEY}',
        DEFAULT_MODELS: v.model,
        ...(v.toolMode || catalogModel
          ? {
              DEFAULT_MODEL_METADATA: JSON.stringify({
                capabilities: {
                  ...(v.toolMode ? { builtin_tools: v.toolMode === 'native' } : {}),
                  ...(catalogModel ? { vision: catalogModel.vision } : {}),
                },
              }),
            }
          : {}),
        DATABASE_URL: externalDatabase
          ? '${AI_EXTERNAL_DATABASE_URL}'
          : 'postgresql://webui:${AI_DB_PASSWORD}@database:5432/webui',
        RAG_EMBEDDING_ENGINE: '',
        RAG_EMBEDDING_MODEL: v.embeddingModel,
        ...(v.embeddingAutoUpdate === undefined
          ? {}
          : {
              RAG_EMBEDDING_MODEL_AUTO_UPDATE: String(v.embeddingAutoUpdate),
              RAG_EMBEDDING_MODEL_TRUST_REMOTE_CODE: 'false',
            }),
        VECTOR_DB: 'chroma',
        CHUNK_SIZE: String(v.chunkSize),
        CHUNK_OVERLAP: String(v.chunkOverlap),
        RAG_TOP_K: String(v.ragTopK),
        TOOL_SERVER_CONNECTIONS: '${AI_TOOL_CONNECTIONS}',
        ENABLE_CODE_EXECUTION: 'false',
        ENABLE_CODE_INTERPRETER: 'false',
        ENABLE_DIRECT_CONNECTIONS: 'false',
        WEBUI_SESSION_COOKIE_SECURE: 'true',
        WEBUI_AUTH_COOKIE_SECURE: 'true',
        ANONYMIZED_TELEMETRY: 'false',
        DO_NOT_TRACK: 'true',
        SCARF_NO_ANALYTICS: 'true',
      },
      volumes: ['webui_data:/app/backend/data'],
      depends_on: {
        ...(!externalDatabase ? { database: { condition: 'service_healthy' } } : {}),
        inference: { condition: 'service_healthy' },
      },
      healthcheck: health(
        [
          'CMD',
          'python',
          '-c',
          `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${v.webPort}/health', timeout=4)`,
        ],
        v.startupMinutes ? `${v.startupMinutes * 60}s` : '120s',
      ),
    },
    inference: {
      ...common,
      image: v.images.vllm,
      ...(v.inferenceCpus ? { cpus: v.inferenceCpus } : {}),
      ...(v.inferenceRamGiB ? { mem_limit: `${v.inferenceRamGiB}g` } : {}),
      networks: ['inference'],
      shm_size: `${v.shmGiB}g`,
      environment: {
        VLLM_API_KEY: '${AI_ENGINE_KEY}',
        HF_TOKEN: '${AI_HF_TOKEN:-}',
        VLLM_NO_USAGE_STATS: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        ...(v.wslCompatibility ? { VLLM_USE_V2_MODEL_RUNNER: '0' } : {}),
      },
      command: [
        '--model',
        v.model,
        '--served-model-name',
        v.model,
        '--host',
        '0.0.0.0',
        '--port',
        String(v.enginePort),
        '--tensor-parallel-size',
        String(v.gpuIds.length),
        '--gpu-memory-utilization',
        String(v.gpuMemory),
        '--max-model-len',
        String(v.maxModelLen),
        '--max-num-seqs',
        String(v.maxSequences),
        '--dtype',
        v.dtype,
        ...(legacyModelCatalog ? [] : aiModelVllmArgs(v.model)),
        ...(v.eagerExecution ? ['--enforce-eager'] : []),
        ...(v.toolMode === 'native'
          ? ['--enable-auto-tool-choice', '--tool-call-parser', v.toolParser]
          : []),
        ...(v.modelRevision ? ['--revision', v.modelRevision] : []),
      ],
      deploy: {
        resources: {
          reservations: {
            devices: [{ driver: 'nvidia', device_ids: v.gpuIds, capabilities: ['gpu'] }],
          },
        },
      },
      volumes: [
        v.modelStorageRoot
          ? {
              type: 'bind',
              source: aiModelStoragePath(v.modelStorageRoot, projectName),
              target: '/root/.cache/huggingface',
              bind: { create_host_path: true },
            }
          : 'model_cache:/root/.cache/huggingface',
        'vllm_cache:/root/.cache/vllm',
      ],
      healthcheck: health(
        [
          'CMD',
          'python3',
          '-c',
          `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${v.enginePort}/health', timeout=4)`,
        ],
        v.startupMinutes ? `${v.startupMinutes * 60}s` : '300s',
      ),
    },
    database: {
      ...common,
      image: v.images.postgres,
      networks: ['data'],
      environment: {
        POSTGRES_USER: 'webui',
        POSTGRES_DB: 'webui',
        POSTGRES_PASSWORD: '${AI_DB_PASSWORD}',
      },
      volumes: ['database_data:/var/lib/postgresql/data'],
      healthcheck: health(['CMD', 'pg_isready', '-U', 'webui', '-d', 'webui']),
    },
  };
  if (externalDatabase) delete services.database;
  return {
    [AI_EXTENSION]: { version: 1, modelCatalogVersion: 1, settings: v },
    services,
    networks: {
      access: { driver: 'bridge', 'x-docker-tracer': { label: 'Accès HTTPS', color: '#276bb0' } },
      inference: { driver: 'bridge', 'x-docker-tracer': { label: 'Moteur IA', color: '#7456ae' } },
      ...(!externalDatabase
        ? {
            data: {
              driver: 'bridge',
              internal: true,
              'x-docker-tracer': { label: 'Données privées', color: '#24714c' },
            },
          }
        : {}),
    },
    volumes: Object.fromEntries(
      [
        'caddy_data',
        'caddy_config',
        'webui_data',
        ...(!externalDatabase ? ['database_data'] : []),
        'model_cache',
        'vllm_cache',
      ].map((name) => [name, {}]),
    ),
    configs: { ai_caddyfile: { content: caddyfile } },
    ...(v.tls === 'provided'
      ? {
          secrets: {
            ai_tls_cert: { environment: 'AI_TLS_CERT' },
            ai_tls_key: { environment: 'AI_TLS_KEY' },
          },
        }
      : {}),
  };
}

export function readAiSettings(source) {
  const m = composeDocument(source).model[AI_EXTENSION];
  if (!m) return null;
  if (m.version !== 1) throw Error('Version du profil IA non prise en charge.');
  return aiSchema.parse(m.settings);
}
const equal = (a, b) => {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
};
export function buildAiCompose(input, variables, projectName, existing = null) {
  const settings = aiSchema.parse(input),
    secrets = validateAiSecrets(variables, settings),
    next = aiComposeModel(settings, projectName);
  let source = YAML.stringify(next, { lineWidth: 0 });
  if (existing) {
    const previousSettings = readAiSettings(existing.source);
    if (!previousSettings) throw Error('Ce projet ne contient pas de profil IA.');
    if (previousSettings.modelStorageRoot !== settings.modelStorageRoot)
      throw Error(
        'Le stockage d’un projet existant reste fixe : déplacer les modèles nécessite une migration séparée.',
      );
    const { doc, model } = composeDocument(existing.source),
      previous = aiComposeModel(previousSettings, projectName, {
        legacyModelCatalog: !model[AI_EXTENSION]?.modelCatalogVersion,
      });
    // Only change fields owned by this wizard; stop instead of overwriting manual changes.
    for (const section of ['services', 'networks', 'volumes', 'configs', 'secrets']) {
      for (const name of new Set([
        ...Object.keys(previous[section] || {}),
        ...Object.keys(next[section] || {}),
      ])) {
        const before = previous[section]?.[name],
          after = next[section]?.[name],
          current = model[section]?.[name];
        // Keep the original managed database volume available after changing databases.
        // Reconnecting a preserved, unmodified volume is also safe; no data is migrated.
        if (section === 'volumes' && name === 'database_data') {
          if (before && !after) continue;
          if (!before && after && equal(current, {})) continue;
        }
        if (!before && current !== undefined)
          throw Error(`Le nom ${section}.${name} est déjà utilisé dans la configuration.`);
        if (before && current === undefined)
          throw Error(
            `${section}.${name} a été retiré depuis la carte. Conserve la configuration complète ou rétablis cet élément.`,
          );
        if (before && !after) {
          if (!equal(before, current))
            throw Error(`${section}.${name} a été personnalisé ; suppression automatique refusée.`);
          doc.deleteIn([section, name]);
          continue;
        }
        for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
          if (!equal(current?.[key], before?.[key]))
            throw Error(
              `${section}.${name}.${key} a été modifié depuis la carte. Utilise la configuration complète ou rétablis ce champ avant de reprendre l’assistant.`,
            );
          if (after?.[key] === undefined) doc.deleteIn([section, name, key]);
          else doc.setIn([section, name, key], after[key]);
        }
        if (!before && !Object.keys(after || {}).length) doc.setIn([section, name], {});
      }
    }
    doc.set(AI_EXTENSION, next[AI_EXTENSION]);
    source = doc.toString({ lineWidth: 0 });
  }
  const mergedVariables = { ...existing?.variables, ...secrets };
  if (settings.database.mode !== 'external') delete mergedVariables.AI_EXTERNAL_DATABASE_URL;
  return composeSettings.parse({
    ...existing,
    projectName,
    source,
    variables: mergedVariables,
    waitSeconds: settings.startupMinutes ? (settings.startupMinutes * 60 + 120) * 2 : 600,
  });
}

export function aiChanges(beforeSource, afterSource) {
  const before = beforeSource ? composeDocument(beforeSource).model : { services: {} },
    after = composeDocument(afterSource).model;
  return Object.keys(after.services).filter(
    (name) =>
      !equal(before.services[name], after.services[name]) ||
      (name === 'caddy' && !equal(before.configs, after.configs)),
  );
}
