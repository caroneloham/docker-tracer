import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserTransport } from '../shared/browser-transport.mjs';

test('the complete browser app cannot send API or Compose data to a server', async () => {
  let networkCalls = 0;
  const nativeFetch = async () => { networkCalls++; throw Error('unexpected network'); };
  const scope = { location: { href: 'https://autodocker.eu/essai/tracer/' }, fetch: nativeFetch };
  const installed = installBrowserTransport(scope);
  const listing = await (await scope.fetch('/api/projects')).json();
  assert.ok(listing.projects.length);
  const id = listing.defaultId;
  const state = await (await scope.fetch(`/api/projects/${id}/state`)).json();
  assert.equal(state.runtime.connected, false);
  assert.ok(state.topology.nodes.length);
  const source = 'services:\n  private_app:\n    image: nginx:alpine\n    environment:\n      PASSWORD: private-test-value\n';
  const created = await scope.fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Imported in memory', hostId: 'local', template: 'empty', compose: { source, projectName: 'private-app' } }),
  });
  assert.ok(created.ok, await created.text());
  assert.equal((await scope.fetch('https://example.org/collect', { method: 'POST', body: source })).status, 403);
  assert.equal((await scope.fetch('/api/projects/' + id + '/deploy', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await scope.fetch('/essai/api/ai-jobs', { method: 'POST', body: source })).status, 403);
  const events = new scope.EventSource('/api/events');
  assert.equal(events.readyState, 2);
  const socket = new scope.WebSocket('wss://autodocker.eu/api/terminal');
  assert.equal(socket.readyState, 3);
  const upload = new scope.XMLHttpRequest();
  upload.open('POST', '/api/container/private/files');
  await new Promise(resolve => { upload.onerror = resolve; upload.send(source); });
  assert.equal(upload.status, 403);
  assert.equal(networkCalls, 0);
  installed.restore();
  assert.equal(scope.fetch, nativeFetch);
});

test('browser transport handles Request objects, size limits and cancellation locally', async () => {
  const scope = { location: { href: 'https://autodocker.eu/essai/tracer/' } };
  installBrowserTransport(scope);
  const listing = await (await scope.fetch(new Request('https://autodocker.eu/api/projects'))).json();
  assert.ok(listing.defaultId);
  const tooLarge = await scope.fetch('/api/projects', { method: 'POST', body: 'x'.repeat(8 * 1024 * 1024 + 1) });
  assert.equal(tooLarge.status, 413);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scope.fetch('/api/projects', { signal: controller.signal }), { name: 'AbortError' });
});
