import { z } from 'zod';
export const FILE_LIMIT = 64 * 1024,
  PROJECT_FILE_LIMIT = 1024 * 1024;
// JSON escaping can expand one content byte to six characters.
export const PROJECT_JSON_LIMIT = 8 * 1024 * 1024;
export const CONFIGURATION_RESTART_MESSAGE =
  'Redémarre Docker Tracer pour activer les fichiers applicatifs et le reverse proxy. Le serveur encore ouvert utilise la version précédente.';
export function assertConfigurationSupport(topology, capabilities) {
  if (
    topology?.nodes?.some((n) => n.data?.files?.length || n.data?.proxy) &&
    capabilities?.applicationFiles !== true
  )
    throw Error(CONFIGURATION_RESTART_MESSAGE);
}
export const textBytes = (value) => new TextEncoder().encode(value).length;
export const filePath = z
  .string()
  .max(240)
  .refine((value) => {
    const parts = value.split('/');
    return (
      value.startsWith('/') &&
      parts.length > 1 &&
      parts.slice(1).every((p) => p && p !== '.' && p !== '..' && /^[a-zA-Z0-9_.@ +-]+$/.test(p)) &&
      !['proc', 'sys', 'dev'].includes(parts[1])
    );
  }, 'Utilise un chemin absolu de fichier, sans .., lien symbolique ni chemin système virtuel.');
export const appFileSchema = z.object({
  path: filePath,
  content: z
    .string()
    .max(FILE_LIMIT)
    .refine(
      (s) => !s.includes('\0') && textBytes(s) <= FILE_LIMIT,
      'Fichier texte UTF-8 de 64 Kio maximum, sans octet nul.',
    ),
});
export const appFilesSchema = z.array(appFileSchema).max(16).default([]);
export const proxySchema = z.object({
  targetId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/),
  networkId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/),
  port: z.number().int().min(1).max(65535).default(80),
  listenPort: z.number().int().min(1).max(65535).default(80),
  websocket: z.boolean().default(true),
});
export const PROXY_PATH = '/etc/nginx/conf.d/default.conf';
export const isNginx = (image) =>
  /^(?:(?:docker\.io\/)?library\/)?nginx(?::[^/]+|@sha256:[a-f0-9]+)?$/.test(image);
export const pathsOverlap = (a, b) =>
  a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/');
export function proxyConfig(name, settings) {
  const p = proxySchema.parse(settings);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)) throw Error('Nom du service cible invalide.');
  return (
    '# Généré par Docker Tracer · modifier depuis la carte.\n' +
    (p.websocket
      ? 'map $http_upgrade $dtr_connection_upgrade {\n    default upgrade;\n    "" close;\n}\n\n'
      : '') +
    `server {
    listen ${p.listenPort};
    server_name _;
    resolver 127.0.0.11 valid=5s ipv6=off;
    resolver_timeout 3s;
    location / {
        set $dtr_upstream http://${name}:${p.port};
        proxy_pass $dtr_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
${p.websocket ? '        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $dtr_connection_upgrade;\n' : ''}        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
`
  );
}
export function configurationFiles(t, n) {
  const files = n.data.files || [];
  if (!n.data.proxy) return files;
  const target = t.nodes.find((x) => x.id === n.data.proxy.targetId);
  if (!target) throw Error('Le service cible du reverse proxy est introuvable.');
  return [...files, { path: PROXY_PATH, content: proxyConfig(target.data.label, n.data.proxy) }];
}
