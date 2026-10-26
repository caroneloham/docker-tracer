import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createInventoryService } from './inventory.mjs';
import { mountWorkspaceApi } from './workspace-api.mjs';
import { createProjectService, mountProjectApi } from './projects.mjs';
import { docker, friendlyError } from './docker.mjs';
import { PROJECT_JSON_LIMIT } from '../shared/configuration.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DTR_DATA_DIR
  ? path.resolve(process.env.DTR_DATA_DIR)
  : path.join(root, 'data');
await mkdir(dataDir, { recursive: true });
const clients = new Set();
function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    if (res.writableLength > 1024 * 1024) {
      res.end();
      clients.delete(res);
    } else res.write(line);
  }
}
const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT) || 4310;
const production = process.argv.includes('--production');
const localAccessToken =
  process.env.DTR_LOCAL_ACCESS_TOKEN || (production ? randomBytes(32).toString('hex') : '');
const generatedBootstrapToken = !!localAccessToken && !process.env.DTR_LOCAL_BOOTSTRAP_TOKEN;
let bootstrapToken =
  process.env.DTR_LOCAL_BOOTSTRAP_TOKEN ||
  (localAccessToken ? randomBytes(32).toString('hex') : '');
const reopenToken = process.env.DTR_LOCAL_REOPEN_TOKEN || '';
let bootstrapAvailable = !!bootstrapToken;
if (localAccessToken && !/^[a-f0-9]{64}$/i.test(localAccessToken))
  throw new Error('DTR_LOCAL_ACCESS_TOKEN doit contenir 64 caractères hexadécimaux.');
if (bootstrapToken && !/^[a-f0-9]{64}$/i.test(bootstrapToken))
  throw new Error('DTR_LOCAL_BOOTSTRAP_TOKEN doit contenir 64 caractères hexadécimaux.');
if (bootstrapToken && bootstrapToken.toLowerCase() === localAccessToken.toLowerCase())
  throw new Error('Le jeton de démarrage doit être distinct du jeton de session locale.');
if (reopenToken && !/^[a-f0-9]{64}$/i.test(reopenToken))
  throw new Error('DTR_LOCAL_REOPEN_TOKEN doit contenir 64 caractères hexadécimaux.');
if (
  reopenToken &&
  (!localAccessToken ||
    [bootstrapToken, localAccessToken].some(
      (token) => token.toLowerCase() === reopenToken.toLowerCase(),
    ))
)
  throw new Error('Le jeton du lanceur doit être distinct des autres jetons locaux.');
function matchesToken(value, expected) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function hasAccessCookie(req) {
  return (req.headers.cookie || '').split(';').some((part) => {
    const separator = part.indexOf('=');
    return (
      separator > 0 &&
      part.slice(0, separator).trim() === 'dtr_access' &&
      matchesToken(part.slice(separator + 1).trim(), localAccessToken)
    );
  });
}
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname))
    return res.status(403).json({ error: 'Hôte non autorisé.' });
  if (req.method === 'POST' && req.path === '/_dtr/launcher/reopen') {
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.headers.origin &&
      !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(req.headers.origin)
    )
      return res.status(403).json({ error: 'Origine non autorisée.' });
    if (!reopenToken || !matchesToken(req.headers['x-docker-tracer-launcher'], reopenToken))
      return res.status(403).json({ error: 'Lanceur local requis.' });
    bootstrapToken = randomBytes(32).toString('hex');
    bootstrapAvailable = true;
    return res.json({ bootstrapToken });
  }
  if (
    bootstrapAvailable &&
    req.method === 'GET' &&
    req.path === '/' &&
    matchesToken(req.query.access, bootstrapToken)
  ) {
    bootstrapAvailable = false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.cookie('dtr_access', localAccessToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/api',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return res.redirect(303, '/');
  }
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
    if (localAccessToken && !hasAccessCookie(req))
      return res.status(401).json({ error: 'Session locale requise. Relancez Docker Tracer.' });
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(origin))
      return res.status(403).json({ error: 'Origine non autorisée.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-docker-tracer'] !== '1')
      return res.status(403).json({ error: 'En-tête de protection manquant.' });
  }
  next();
});
app.use(express.json({ limit: PROJECT_JSON_LIMIT }));
const inventory = createInventoryService(docker);
app.get('/api/inventory', async (_req, res) => {
  try {
    res.json(await inventory.read());
  } catch (error) {
    res.status(503).json({ error: friendlyError(error) });
  }
});
app.get('/api/inventory/containers/:id', async (req, res) => {
  try {
    res.json(await inventory.inspect(req.params.id));
  } catch (error) {
    res
      .status([400, 404].includes(error.statusCode) ? error.statusCode : 503)
      .json({ error: friendlyError(error) });
  }
});
app.get('/api/events', (req, res) => {
  if (clients.size >= 12) return res.status(429).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
  const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(timer);
    clients.delete(res);
  });
});
let projects;
const workspace = await mountWorkspaceApi(app, {
  dataDir,
  localDocker: docker,
  emit,
  labBusy: (hostId) => projects?.hostBusy(hostId) || false,
  guardHost: (id, next) => projects?.guardHost(id, next),
  projectList: () => projects?.list() || [],
});
projects = await createProjectService({ dataDir, workspace, emit });
mountProjectApi(app, projects);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((error, _req, res, _next) => {
  const message =
    error instanceof z.ZodError
      ? error.issues.map((i) => i.message).join(' ')
      : friendlyError(error);

  if (!res.headersSent)
    res.status(error instanceof z.ZodError ? 400 : error.statusCode || 500).json({
      error: message,
      ...(error.deploymentRun ? { deploymentRun: error.deploymentRun } : {}),
    });
});
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Docker Tracer → http://127.0.0.1:${port}`);
  if (generatedBootstrapToken)
    console.log(`Ouvrez http://127.0.0.1:${port}/?access=${bootstrapToken}`);
});
async function shutdown() {
  await workspace.shutdown();
  await projects.shutdown();
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
