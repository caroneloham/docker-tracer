import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('API locale : persistance, validation et protection des mutations', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockertracer-test-'));
  const port = 14310;
  const bootstrapToken = 'a'.repeat(64);
  // Deliberately point this contract test to an absent daemon. No real resources are created.
  const child = spawn(process.execPath, ['server/index.mjs', '--production'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DTR_LOCAL_BOOTSTRAP_TOKEN: bootstrapToken,
      DTR_DATA_DIR: dir,
      DOCKER_HOST:
        process.platform === 'win32'
          ? 'npipe:////./pipe/dockertracer-test-missing'
          : 'unix:///tmp/dockertracer-test-missing.sock',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Serveur de test indisponible')), 8000);
      child.stdout.on('data', (b) => {
        if (String(b).includes('Docker Tracer')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(Error(`Serveur arrêté (${code})`));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const activation = await fetch(base + '/?access=' + bootstrapToken, { redirect: 'manual' });
    assert.equal(activation.status, 303);
    const cookie = activation.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('dtr_access='));
    assert.match(activation.headers.get('set-cookie'), /Max-Age=2592000/);
    assert.notEqual(cookie, 'dtr_access=' + bootstrapToken);
    assert.equal(
      (await fetch(base + '/?access=' + bootstrapToken, { redirect: 'manual' })).headers.get(
        'set-cookie',
      ),
      null,
    );
    assert.equal(
      (await fetch(base + '/api/state', { headers: { Cookie: 'dtr_access=' + bootstrapToken } }))
        .status,
      401,
    );
    const apiFetch = (url, options = {}) =>
      fetch(url, {
        ...options,
        headers: { ...options.headers, Cookie: cookie },
      });
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(
        base + '/api/state',
        {
          headers: { Host: 'evil.example', Cookie: cookie },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal(
      (await apiFetch(base + '/api/events', { headers: { Origin: 'https://evil.example' } }))
        .status,
      403,
    );
    const state = await (await apiFetch(base + '/api/state')).json();
    assert.equal(state.topology.nodes.length, 6);
    assert.equal(state.capabilities.applicationFiles, true);
    assert.equal(state.capabilities.startupChecks, true);
    let response = await apiFetch(base + '/api/topology', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.topology),
    });
    assert.equal(response.status, 403);
    response = await apiFetch(base + '/api/topology', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Docker-Tracer': '1',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify(state.topology),
    });
    assert.equal(response.status, 403);
    const t = structuredClone(state.topology);
    t.name = 'Test persistance';
    t.nodes[0].position.x = 99;
    // Maximum supported file content must survive JSON escaping and an API round trip.
    t.nodes[0].data.files = Array.from({ length: 16 }, (_, i) => ({
      path: '/etc/application/file-' + i + '.txt',
      content: '\u0001'.repeat(65536),
    }));
    response = await apiFetch(base + '/api/topology', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
      body: JSON.stringify(t),
    });
    assert.equal(response.status, 200);
    const saved = await (await apiFetch(base + '/api/state')).json();
    assert.equal(saved.topology.name, t.name);
    assert.equal(saved.topology.nodes[0].position.x, 99);
    assert.deepEqual(saved.topology.nodes[0].data.files, t.nodes[0].data.files);
    // Wait until the write operation has released its lock before the next request.
    while ((await (await apiFetch(base + '/api/state')).json()).busy)
      await new Promise((r) => setTimeout(r, 25));
    response = await apiFetch(base + '/api/topology', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Docker-Tracer': '1' },
      body: JSON.stringify({ ...t, id: 'different-project' }),
    });
    assert.equal(response.status, 400);
    response = await apiFetch(base + '/api/compose');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /network_mode|frontend/);
    response = await apiFetch(base + '/api/not-a-route');
    assert.equal(response.status, 404);
    response = await apiFetch(base + '/api/inventory');
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Docker/);
    response = await apiFetch(base + '/api/inventory/containers/not-an-id');
    assert.equal(response.status, 400);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    // mkdtemp returned a task-owned temporary directory. Validate before recursive removal.
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('dockertracer-test-'))
      throw Error('Chemin temporaire inattendu');
    await rm(dir, { recursive: true, force: true });
  }
});
