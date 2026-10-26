import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createImageCatalog, mountImageCatalog } from '../server/image-catalog.mjs';
import { hubRepository, imageReference } from '../shared/image-catalog.mjs';

const response = (data, init = {}) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });

test('image catalogue: références Docker Hub et registres manuels sans URL arbitraire', () => {
  assert.deepEqual(hubRepository('nginx'), { canonical: 'library/nginx', display: 'nginx' });
  assert.equal(hubRepository('linuxserver/sonarr').canonical, 'linuxserver/sonarr');
  for (const value of ['https://example.test/a', '../nginx', 'x/y/z', '//host', 'Name', ['nginx']])
    assert.throws(() => hubRepository(value));
  assert.equal(imageReference('nginx'), 'nginx:latest');
  assert.equal(imageReference('localhost:5000/team/app:v2'), 'localhost:5000/team/app:v2');
  assert.equal(imageReference('ghcr.io/owner/my__app:Main'), 'ghcr.io/owner/my__app:Main');
  assert.equal(imageReference(`nginx@sha256:${'a'.repeat(64)}`), `nginx@sha256:${'a'.repeat(64)}`);
  for (const value of [
    'https://host/image',
    'name:tag;run',
    'x y',
    'X/Name',
    'user:password@host/image',
    'a@sha256:abc',
    '../image',
    'a:',
    'a?b',
  ])
    assert.throws(() => imageReference(value));
});

test('image catalogue: recherche bornée et cache sans pull, pagination reconstruite', async () => {
  let clock = 1000;
  const calls = [],
    catalog = createImageCatalog({
      now: () => clock,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response({
          count: 52,
          next: 'http://169.254.169.254/latest/meta-data',
          results: [
            {
              repo_name: 'nginx',
              short_description: 'Web server',
              is_official: true,
              pull_count: 25,
              star_count: 9,
            },
            { repo_name: 'evil/claimed', is_official: true },
            { repo_name: 'https://bad.test' },
          ],
        });
      },
    });
  const a = await catalog.search({ q: 'nginx', page: '2' });
  assert.equal(a.hasNext, true);
  assert.equal(a.cached, false);
  assert.equal(a.page, 2);
  assert.equal(a.results.length, 2);
  assert.equal(a.results[0].repository, 'library/nginx');
  assert.equal(a.results[0].official, true);
  assert.equal(a.results[1].official, false);
  assert.equal(calls[0].url.origin, 'https://hub.docker.com');
  assert.equal(calls[0].url.searchParams.get('page_size'), '12');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
  assert.equal((await catalog.search({ q: 'nginx', page: '2' })).cached, true);
  assert.equal(calls.length, 1);
  clock += 300001;
  await catalog.search({ q: 'nginx', page: '2' });
  assert.equal(calls.length, 2);
});

test('image catalogue: validation avant réseau et tags officiels avec filtre', async () => {
  let calls = 0;
  const catalog = createImageCatalog({
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url.origin, 'https://hub.docker.com');
      assert.equal(url.pathname, '/v2/namespaces/library/repositories/nginx/tags');
      assert.equal(url.searchParams.get('name'), 'alpine');
      return response({
        count: 2,
        results: [
          {
            name: 'stable-alpine',
            full_size: 10000,
            images: [
              { os: 'linux', architecture: 'amd64' },
              { os: 'unknown', architecture: 'unknown' },
              { os: 'linux', architecture: 'amd64' },
            ],
          },
          { name: 'bad/../../tag' },
        ],
      });
    },
  });
  for (const input of [
    { q: '' },
    { q: 'x', page: '0' },
    { q: 'x', page: '1001' },
    { q: ['a', 'b'] },
    { q: 'http://169.254.169.254' },
  ])
    await assert.rejects(catalog.search(input), { statusCode: 400 });
  await assert.rejects(catalog.tags({ repository: '../nginx' }), { statusCode: 400 });
  assert.equal(calls, 0);
  const data = await catalog.tags({ repository: 'nginx', q: 'alpine' });
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].image, 'nginx:stable-alpine');
  assert.deepEqual(data.results[0].platforms, ['linux/amd64']);
});

test('image catalogue: requêtes identiques simultanées partagées et erreurs non mémorisées', async () => {
  let calls = 0;
  const catalog = createImageCatalog({
    fetchImpl: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response({ results: [] });
    },
  });
  await Promise.all([catalog.search({ q: 'redis' }), catalog.search({ q: 'redis' })]);
  assert.equal(calls, 1);
  let fail = true;
  const retry = createImageCatalog({
    fetchImpl: () => {
      if (fail) throw Error('offline');
      return response({ results: [] });
    },
  });
  await assert.rejects(retry.search({ q: 'redis' }), { statusCode: 502 });
  fail = false;
  assert.deepEqual((await retry.search({ q: 'redis' })).results, []);
});

test('image catalogue: limite de débit amont et locale, timeout et réponse surdimensionnée', async () => {
  let calls = 0;
  const limited = createImageCatalog({
    fetchImpl: async () => {
      calls++;
      return response({}, { status: 429, headers: { 'retry-after': '12' } });
    },
  });
  await assert.rejects(limited.search({ q: 'redis' }), { statusCode: 429, retryAfter: 12 });
  await assert.rejects(limited.search({ q: 'nginx' }), { statusCode: 429 });
  assert.equal(calls, 1);
  const timeout = createImageCatalog({
    fetchImpl: async () => {
      throw new DOMException('timeout', 'TimeoutError');
    },
  });
  await assert.rejects(timeout.search({ q: 'redis' }), { statusCode: 504 });
  const giant = createImageCatalog({
    fetchImpl: async () => response({ results: [], text: 'x'.repeat(1024 * 1024) }),
  });
  await assert.rejects(giant.search({ q: 'redis' }), { statusCode: 502 });
  const badFormat = createImageCatalog({ fetchImpl: async () => response({ unexpected: [] }) });
  await assert.rejects(badFormat.search({ q: 'redis' }), { statusCode: 502 });
  const quota = createImageCatalog({
    now: () => 1000,
    fetchImpl: async () => response({ results: [] }),
  });
  for (let i = 0; i < 40; i++) await quota.search({ q: 'image' + i });
  await assert.rejects(quota.search({ q: 'image41' }), { statusCode: 429 });
  assert.equal((await quota.search({ q: 'image1' })).cached, true);
});

test('image catalogue: routes HTTP en lecture seule et erreurs JSON', async (t) => {
  const app = express();
  mountImageCatalog(app, { fetchImpl: async () => response({ results: [] }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const valid = await fetch(base + '/api/image-catalog/search?q=nginx');
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).source, 'Docker Hub');
  const bad = await fetch(base + '/api/image-catalog/tags?repository=https://example.test');
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);
  const post = await fetch(base + '/api/image-catalog/search', { method: 'POST' });
  assert.equal(post.status, 404);
});
