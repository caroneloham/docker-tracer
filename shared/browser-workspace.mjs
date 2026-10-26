import YAML from 'yaml';
import { initialTopology, topologySchema, composeObject, templates } from './model.mjs';
import {
  composeDocument,
  composeGraph,
  composeRecord,
  composeSettings,
} from './compose-project.mjs';
import { resetBridgeAddresses } from './bridge.mjs';

const MAX_PROJECTS = 50;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const host = Object.freeze({ id: 'local', name: 'Navigateur', kind: 'browser', address: 'local' });
const images = Object.freeze([
  { name: 'nginx:alpine', description: 'Serveur web Nginx' },
  { name: 'redis:7-alpine', description: 'Cache Redis' },
  { name: 'postgres:16', description: 'Base PostgreSQL' },
  { name: 'node:22-alpine', description: 'Application Node.js' },
  { name: 'alpine:3.23', description: 'Linux Alpine' },
]);
const capabilities = Object.freeze({
  composeProjects: true,
  aiInfrastructure: false,
  aiStoragePreview: false,
  imageCatalog: true,
  browserWorkspace: true,
});
const stateCapabilities = Object.freeze({
  applicationFiles: true,
  startupChecks: true,
  advancedBridges: true,
  volumeBackups: false,
  composeProjects: true,
  browserWorkspace: true,
});
const unavailable =
  'Cette action demande le Docker Tracer local. Le mode navigateur ne se connecte à aucun serveur Docker.';

function error(message, status = 400) {
  return { status, body: { error: message } };
}

function uuid() {
  if (!globalThis.crypto?.randomUUID)
    throw Error('Navigateur sécurisé requis pour créer un projet.');
  return globalThis.crypto.randomUUID();
}

function parseBody(body) {
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') return JSON.parse(body);
  if (typeof body === 'object' && !Array.isArray(body)) return body;
  throw Error('Corps de requête invalide.');
}

function header(headers, key) {
  if (typeof headers?.get === 'function') return headers.get(key);
  const name = Object.keys(headers || {}).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return name ? headers[name] : undefined;
}

function clone(record) {
  return structuredClone(record);
}

function metadata(record, defaultId) {
  const model = record.compose ? composeDocument(record.compose.source).model : null;
  return {
    kind: record.compose ? 'compose' : 'graph',
    composeProjectName: record.compose?.projectName || null,
    id: record.id,
    name: record.topology.name,
    hostId: 'local',
    host,
    revision: record.revision,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    containers: model
      ? Object.keys(model.services || {}).length
      : record.topology.nodes.filter((node) => node.data.kind === 'container').length,
    networks: model
      ? Object.keys(model.networks || {}).length
      : record.topology.nodes.filter((node) => node.data.kind === 'network').length,
    legacy: record.id === defaultId,
    everDeployed: false,
    busy: false,
    capture: false,
    state: 'draft',
  };
}

function ensureRevision(record, headers, body, fromBody = false) {
  const value = fromBody ? body.revision : header(headers, 'If-Match');
  if (value === undefined || value === null || value === '')
    throw Object.assign(Error('Recharge le projet avant de le modifier (révision manquante).'), {
      status: 428,
    });
  if (Number(String(value).replaceAll('"', '')) !== record.revision)
    throw Object.assign(
      Error('Ce projet a changé dans une autre fenêtre. Recharge-le avant de continuer.'),
      { status: 409 },
    );
}

function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw Error('Nom de projet invalide (1 à 80 caractères).');
  return value.trim();
}

// The store is intentionally owned by this one browser tab. It never calls
// fetch, Docker, localStorage, indexedDB, the filesystem, or a remote API.
export function createBrowserWorkspace() {
  const started = Date.now();
  const defaultTopology = topologySchema.parse(initialTopology());
  const defaultId = defaultTopology.id;
  const records = new Map([
    [
      defaultId,
      {
        id: defaultId,
        hostId: 'local',
        topology: defaultTopology,
        revision: 1,
        compose: null,
        archivedAt: null,
        createdAt: started,
        updatedAt: started,
      },
    ],
  ]);

  const get = (id) => {
    const record = records.get(id);
    if (!record) throw Object.assign(Error('Projet introuvable.'), { status: 404 });
    return record;
  };
  const projectNameAvailable = (name, exceptId) =>
    ![...records.values()].some(
      (record) => record.id !== exceptId && !record.archivedAt && record.topology.name === name,
    );
  const make = (input) => {
    const name = validateName(input.name);
    if (input.hostId !== 'local')
      throw Error('Le mode navigateur propose uniquement un espace de travail local en mémoire.');
    if (records.size >= MAX_PROJECTS) throw Error('Maximum de 50 projets dans cet onglet.');
    if (!projectNameAvailable(name)) throw Error('Un projet porte déjà ce nom.');
    if (input.compose && input.copyFrom) throw Error('Choisis une copie ou un fichier Compose.');
    if (input.template && !['empty', 'example'].includes(input.template))
      throw Error('Modèle de projet inconnu.');
    const id = `p-${uuid()}`;
    let topology = { id, name, nodes: [], edges: [] };
    let compose = null;
    if (input.compose) {
      const settings = composeSettings.parse(input.compose);
      composeDocument(settings.source);
      if (
        [...records.values()].some((record) => record.compose?.projectName === settings.projectName)
      )
        throw Error('Ce nom Compose est déjà utilisé, archives comprises.');
      // A browser workspace cannot adopt resources or read files on a host.
      if (settings.adopt || settings.useDotEnv || settings.directory)
        throw Error('L’adoption et les fichiers du serveur demandent Docker Tracer local.');
      compose = composeRecord.parse(settings);
    } else if (input.copyFrom) {
      const source = get(input.copyFrom);
      if (source.compose)
        throw Error(
          'Pour copier un projet Compose, réimporte son fichier avec un autre nom Compose.',
        );
      topology = clone(source.topology);
      for (const node of topology.nodes) {
        node.data.ports = [];
        node.data.subnet = '';
        node.data.bridge = resetBridgeAddresses(node.data.bridge);
      }
      for (const edge of topology.edges) edge.ipv4 = '';
    } else if (input.template === 'example') {
      topology = initialTopology();
    }
    topology.id = id;
    topology.name = name;
    topology = topologySchema.parse(topology);
    const now = Date.now();
    const record = {
      id,
      hostId: 'local',
      topology,
      revision: 1,
      compose,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    records.set(id, record);
    return record;
  };
  const update = (record, fn) => {
    if (record.archivedAt) throw Error('Restaure ce projet avant de le modifier.');
    fn(record);
    record.revision += 1;
    record.updatedAt = Date.now();
    return { project: metadata(record, defaultId) };
  };
  const state = (record) => ({
    project: metadata(record, defaultId),
    compose: record.compose ? clone(record.compose) : null,
    topology: clone(record.topology),
    capabilities: stateCapabilities,
    deployments: [],
    runtime: {
      connected: false,
      nodes: {},
      networks: [],
      services: {},
      deployed: false,
      message: 'Aucun moteur Docker dans le navigateur.',
    },
    capture: false,
    busy: false,
    journal: [],
    tests: [],
  });

  function handle(path, { method = 'GET', body, headers = {} } = {}) {
    try {
      const pathname = new URL(path, 'https://browser.local').pathname;
      method = String(method).toUpperCase();
      if (!pathname.startsWith('/api/')) return error('Route inconnue.', 404);
      if (pathname === '/api/projects' && method === 'GET')
        return {
          status: 200,
          body: {
            projects: [...records.values()].map((record) => metadata(record, defaultId)),
            defaultId,
            capabilities,
          },
        };
      if (pathname === '/api/projects' && method === 'POST')
        return { status: 201, body: { project: metadata(make(parseBody(body)), defaultId) } };
      if (pathname === '/api/hosts' && method === 'GET') return { status: 200, body: [host] };
      if (pathname === '/api/hosts') return error(unavailable, 403);
      if (pathname === '/api/catalog' && method === 'GET')
        return { status: 200, body: { templates: clone(templates), images: clone(images) } };
      if (pathname === '/api/catalog/templates' && method === 'GET')
        return { status: 200, body: clone(templates) };
      if (pathname === '/api/catalog/images' && method === 'GET')
        return { status: 200, body: clone(images) };
      if (pathname === '/api/templates' && method === 'GET')
        return { status: 200, body: clone(templates) };
      if (pathname === '/api/images' && method === 'GET')
        return { status: 200, body: clone(images) };

      const match = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!idPattern.test(id)) return error('Identifiant de projet invalide.');
        const record = get(id);
        const route = match[2] || '';
        if ((route === '' || route === '/') && method === 'GET')
          return { status: 200, body: { project: metadata(record, defaultId) } };
        if (route === '/state' && method === 'GET') return { status: 200, body: state(record) };
        if (route === '/topology' && method === 'GET')
          return { status: 200, body: clone(record.topology) };
        if (route === '/compose' && method === 'GET')
          return {
            status: 200,
            body: YAML.stringify(composeObject(record.topology)),
            contentType: 'text/yaml',
          };
        if (route === '/compose/source' && method === 'GET') {
          if (!record.compose) return error('Projet Compose requis.', 409);
          return { status: 200, body: record.compose.source, contentType: 'text/yaml' };
        }
        if (route === '/compose/source' && method === 'PUT') {
          ensureRevision(record, headers);
          if (!record.compose) return error('Projet Compose requis.', 409);
          const settings = composeSettings.parse(parseBody(body));
          composeDocument(settings.source);
          if (
            settings.projectName !== record.compose.projectName ||
            settings.adopt !== record.compose.adopt
          )
            return error('La cible Compose ne peut pas changer.', 409);
          return {
            status: 200,
            body: {
              ok: true,
              ...update(record, (next) => {
                next.compose = { ...next.compose, ...settings, resolved: null };
              }),
            },
          };
        }
        if (route === '/compose/preview' && method === 'POST') {
          ensureRevision(record, headers);
          if (!record.compose) return error('Projet Compose requis.', 409);
          const settings = composeSettings.parse(parseBody(body));
          if (
            settings.projectName !== record.compose.projectName ||
            settings.adopt !== record.compose.adopt
          )
            return error('La cible Compose ne peut pas changer.', 409);
          const config = composeDocument(settings.source).model;
          const graph = composeGraph(settings.source, settings.positions);
          return {
            status: 200,
            body: {
              token: null,
              projectName: settings.projectName,
              hostId: 'local',
              output:
                'Syntaxe YAML vérifiée dans ce navigateur. Aucun déploiement ni test Docker exécuté.',
              dryRunSucceeded: false,
              services: Object.keys(config.services || {}),
              attention: [],
              existing: [],
              config,
              graph,
            },
          };
        }
        if (route === '/topology' && method === 'PUT') {
          ensureRevision(record, headers);
          if (record.compose) return error('Ce projet utilise l’éditeur Compose.', 409);
          const next = topologySchema.parse(parseBody(body));
          if (next.id !== record.id) return error('L’identifiant du projet ne peut pas changer.');
          return {
            status: 200,
            body: {
              topology: next,
              ...update(record, (current) => {
                current.topology = next;
              }),
            },
          };
        }
        if (route === '/rename' && ['POST', 'PATCH'].includes(method)) {
          ensureRevision(record, headers, parseBody(body), !header(headers, 'If-Match'));
          const name = validateName(parseBody(body).name);
          if (!projectNameAvailable(name, record.id))
            return error('Un projet porte déjà ce nom.', 409);
          return {
            status: 200,
            body: update(record, (current) => {
              current.topology.name = name;
            }),
          };
        }
        if (route === '/clone' && method === 'POST') {
          const request = parseBody(body);
          const created = make({
            name: request.name || `${record.topology.name} copie`,
            hostId: 'local',
            copyFrom: id,
          });
          return { status: 201, body: { project: metadata(created, defaultId) } };
        }
        if (route === '/archive' && method === 'POST') {
          if (record.id === defaultId)
            return error('Le laboratoire initial reste disponible.', 409);
          ensureRevision(record, headers, parseBody(body), true);
          return {
            status: 200,
            body: update(record, (current) => {
              current.archivedAt = Date.now();
            }),
          };
        }
        if (route === '/restore' && method === 'POST') {
          ensureRevision(record, headers, parseBody(body), true);
          record.archivedAt = null;
          record.revision += 1;
          record.updatedAt = Date.now();
          return { status: 200, body: { project: metadata(record, defaultId) } };
        }
        if (route === '/lab/preview' && method === 'POST') {
          ensureRevision(record, headers);
          topologySchema.parse(parseBody(body));
          return error(
            'Le laboratoire est validé localement ; l’aperçu de déploiement nécessite Docker Tracer local.',
            403,
          );
        }
        // A browser workspace must never claim a successful runtime action.
        return error(unavailable, 403);
      }
      if (
        pathname.startsWith('/api/hosts/') ||
        pathname.startsWith('/api/workspace/') ||
        pathname.startsWith('/api/inventory')
      )
        return error(unavailable, 403);
      return error(unavailable, 403);
    } catch (cause) {
      const message = cause?.issues?.[0]?.message || cause?.message || 'Requête invalide.';
      return error(message, cause?.status || 400);
    }
  }

  return { handle };
}
