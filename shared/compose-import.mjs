import { composeAttention, composeDocument } from './compose-project.mjs';

export const COMPOSE_IMPORT_LIMIT = 2 * 1024 * 1024;
const absolute = (value) => /^(?:\/|[A-Za-z]:[\\/]|~)/.test(value);
const remote = (value) => /^(?:https?:\/\/|git@|service:|docker-image:)/.test(value);
const slug = (value) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-_]+$/g, '')
    .slice(0, 63);

export async function readComposeImportFile(file) {
  if (!file || !/\.ya?ml$/i.test(file.name))
    throw Error('Choisis un fichier Compose .yaml ou .yml.');
  if (file.size > COMPOSE_IMPORT_LIMIT) throw Error('Le fichier Compose dépasse 2 Mio.');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > COMPOSE_IMPORT_LIMIT) throw Error('Le fichier Compose dépasse 2 Mio.');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('Le fichier doit être du texte UTF-8.');
  }
  if (source.includes('\0')) throw Error('Ce fichier contient des données binaires.');
  return { filename: file.name, source };
}

export function summarizeComposeImport(source, filename = 'compose.yaml') {
  if (new TextEncoder().encode(source).length > COMPOSE_IMPORT_LIMIT)
    throw Error('Le fichier Compose dépasse 2 Mio.');
  let model;
  try {
    ({ model } = composeDocument(source));
  } catch (error) {
    throw Error(error.message.replaceAll('—', ':'));
  }
  const filenameBase = filename.replace(/\.ya?ml$/i, '');
  const suggestedName =
    typeof model.name === 'string' && !model.name.includes('$')
      ? model.name
      : /^(?:docker-)?compose$/i.test(filenameBase)
        ? 'infra-importee'
        : filenameBase;
  const projectName = slug(suggestedName) || 'infra-importee';
  const dependencies = [],
    variables = new Map(),
    profiles = new Set();
  const addDependency = (kind, value, service = '') => {
    if (typeof value !== 'string' || !value || remote(value)) return;
    dependencies.push({ kind, path: value, service, relative: !absolute(value) });
  };
  const visited = new WeakSet();
  const walk = (value) => {
    if (typeof value === 'string') {
      const interpolation = value.replace(/\$\$/g, '');
      for (const match of interpolation.matchAll(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      )) {
        const name = match[1] || match[3],
          expression = match[2] || '';
        const optional = /^:?-/.test(expression) || /^:?\+/.test(expression);
        variables.set(name, { name, required: !optional || !!variables.get(name)?.required });
      }
    } else if (value && typeof value === 'object' && !visited.has(value)) {
      visited.add(value);
      Object.values(value).forEach(walk);
    }
  };
  walk(model);
  const services = Object.entries(model.services || {}).map(([name, service]) => {
    const inherited = Array.isArray(service.environment)
      ? service.environment.filter((entry) => !entry.includes('='))
      : Object.entries(service.environment || {})
          .filter(([, value]) => value == null)
          .map(([key]) => key);
    for (const key of inherited)
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) variables.set(key, { name: key, required: true });
    for (const profile of Array.isArray(service.profiles) ? service.profiles : [])
      profiles.add(profile);
    for (const env of [service.env_file || []].flat())
      addDependency('Variables', typeof env === 'string' ? env : env?.path, name);
    if (service.build)
      addDependency(
        'Build',
        typeof service.build === 'string' ? service.build : service.build.context || '.',
        name,
      );
    if (service.extends?.file) addDependency('Compose inclus', service.extends.file, name);
    const mounts = (service.volumes || []).map((volume) => {
      if (typeof volume === 'object') {
        if (volume.type === 'bind') addDependency('Dossier monté', volume.source, name);
        return `${volume.source || 'anonyme'} → ${volume.target || '?'}`;
      }
      const parts = String(volume).split(':');
      if (parts.length > 1) {
        const mounted = /^[A-Za-z]:[\\/]/.test(volume) ? parts.slice(0, 2).join(':') : parts[0];
        if (
          /^(?:[./~]|[A-Za-z]:[\\/])/.test(mounted) ||
          mounted.includes('/') ||
          mounted.includes('\\')
        )
          addDependency('Dossier monté', mounted, name);
      }
      return String(volume);
    });
    const ports = (service.ports || []).map((port) =>
      typeof port === 'object'
        ? `${port.host_ip ? port.host_ip + ':' : ''}${port.published || 'auto'} → ${port.target}/${port.protocol || 'tcp'}`
        : String(port),
    );
    return {
      name,
      image: service.image || (service.build ? 'Image à construire' : 'Définition incluse'),
      ports,
      mounts,
      profiles: Array.isArray(service.profiles) ? service.profiles : [],
    };
  });
  for (const [kind, definitions] of Object.entries({
    Config: model.configs,
    Secret: model.secrets,
  }))
    for (const value of Object.values(definitions || {}))
      if (value?.file) addDependency(kind, value.file);
  for (const included of [model.include || []].flat())
    for (const value of [typeof included === 'string' ? included : included?.path || []].flat())
      addDependency('Compose inclus', value);
  const warnings = composeAttention(model, projectName);
  if (model.include)
    warnings.push('Les services des fichiers inclus apparaîtront après validation Compose.');
  if (profiles.size)
    warnings.push(
      'Les services avec profil restent désactivés tant que leur profil n’est pas sélectionné.',
    );
  return {
    projectName,
    name: suggestedName.slice(0, 80),
    services,
    dependencies,
    needsDirectory: dependencies.some((entry) => entry.relative),
    variables: [...variables.values()],
    profiles: [...profiles],
    volumes: Object.keys(model.volumes || {}),
    warnings,
  };
}
