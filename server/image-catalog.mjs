import { hubRepository } from '../shared/image-catalog.mjs';

const HUB = 'https://hub.docker.com';
const PAGE_SIZE = 12;
const MAX_BODY = 1024 * 1024;
const TTL = 5 * 60 * 1000;
const fail = (message, statusCode = 400, retryAfter) =>
  Object.assign(Error(message), { statusCode, retryAfter });
const cleanText = (value, size = 500) => (typeof value === 'string' ? value.slice(0, size) : '');
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function textQuery(value, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > 80 || /[^a-zA-Z0-9_. /-]/.test(value))
    throw fail('Recherche invalide : utilise un nom d’image de 80 caractères maximum.');
  const query = value.trim();
  if (!empty && !query) throw fail('Saisis le nom d’une image à rechercher.');
  return query;
}

function pageNumber(value = '1') {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > 1000)
    throw fail('Le numéro de page doit être compris entre 1 et 1000.');
  return Number(value);
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY)
    throw fail('La réponse du catalogue est trop volumineuse. Précise ta recherche.', 502);
  const reader = response.body?.getReader();
  if (!reader) throw fail('Le catalogue a renvoyé une réponse vide.', 502);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw fail('La réponse du catalogue est trop volumineuse. Précise ta recherche.', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('Le catalogue a renvoyé une réponse illisible. Réessaie plus tard.', 502);
  }
  if (!data || !Array.isArray(data.results))
    throw fail('Le format du catalogue a changé. Utilise une référence d’image manuelle.', 502);
  return data;
}

// Metadata only: this module has no Docker client and cannot pull images.
// Hub public search is isolated here because it is not part of the documented
// namespace API. Tags use its current documented endpoint. Pagination URLs from
// Hub are never followed; every request is rebuilt against the fixed host.
export function createImageCatalog({ fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  const cache = new Map(),
    pending = new Map();
  let windowStart = now(),
    requests = 0,
    cooldownUntil = 0;
  async function request(path, params, transform) {
    const url = new URL(path, HUB);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const key = url.href,
      time = now(),
      cached = cache.get(key);
    if (cached && time - cached.at < TTL) return { ...cached.data, cached: true };
    if (pending.has(key)) return pending.get(key);
    if (time < cooldownUntil)
      throw fail(
        'Docker Hub limite les recherches. Réessaie dans quelques instants.',
        429,
        Math.ceil((cooldownUntil - time) / 1000),
      );
    if (time - windowStart >= 60000) {
      windowStart = time;
      requests = 0;
    }
    if (requests >= 40 || pending.size >= 4)
      throw fail('Trop de recherches simultanées. Patiente quelques secondes.', 429, 10);
    requests++;
    const work = Promise.resolve().then(async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json', 'User-Agent': 'Docker-Tracer/image-catalog' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const retry = Math.min(
              300,
              Math.max(10, Number(response.headers.get('retry-after')) || 60),
            );
            cooldownUntil = now() + retry * 1000;
            throw fail(
              'Docker Hub limite les recherches. Réessaie dans quelques instants.',
              429,
              retry,
            );
          }
          if (response.status === 404) throw fail('Dépôt ou page introuvable sur Docker Hub.', 404);
          throw fail(
            'Docker Hub est momentanément indisponible. Réessaie ou saisis une image manuellement.',
            502,
          );
        }
        const raw = await boundedJson(response);
        const data = {
          source: 'Docker Hub',
          page: params.page,
          pageSize: PAGE_SIZE,
          total: count(raw.count),
          hasNext: !!raw.next && params.page < 1000,
          checkedAt: new Date(now()).toISOString(),
          results: transform(raw.results.slice(0, PAGE_SIZE)),
        };
        cache.delete(key);
        while (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), data });
        return { ...data, cached: false };
      } catch (error) {
        if (error.statusCode) throw error;
        if (error.name === 'TimeoutError' || error.name === 'AbortError')
          throw fail('Docker Hub met trop de temps à répondre. Réessaie.', 504);
        throw fail(
          'Connexion à Docker Hub impossible. Tu peux saisir une image manuellement.',
          502,
        );
      } finally {
        pending.delete(key);
      }
    });
    pending.set(key, work);
    return work;
  }
  return {
    async search(input = {}) {
      const q = textQuery(input.q),
        page = pageNumber(input.page);
      return request(
        '/v2/search/repositories/',
        { query: q, page, page_size: PAGE_SIZE },
        (items) =>
          items.flatMap((item) => {
            try {
              const repo = hubRepository(item.repo_name);
              return [
                {
                  repository: repo.canonical,
                  name: repo.display,
                  description: cleanText(item.short_description),
                  official: item.is_official === true && repo.canonical.startsWith('library/'),
                  stars: count(item.star_count),
                  pulls: count(item.pull_count),
                },
              ];
            } catch {
              return [];
            }
          }),
      );
    },
    async tags(input = {}) {
      let repo;
      try {
        repo = hubRepository(input.repository);
      } catch (error) {
        throw fail(error.message);
      }
      const page = pageNumber(input.page),
        q = input.q === undefined ? '' : textQuery(input.q, { empty: true });
      const [namespace, repository] = repo.canonical.split('/');
      return request(
        `/v2/namespaces/${namespace}/repositories/${repository}/tags`,
        {
          page,
          page_size: PAGE_SIZE,
          ...(q ? { name: q } : {}),
        },
        (items) =>
          items
            .filter((item) => /^[\w][\w.-]{0,127}$/.test(item.name))
            .map((item) => ({
              tag: item.name,
              image: `${repo.display}:${item.name}`,
              size: count(item.full_size),
              updatedAt: cleanText(item.last_updated, 60),
              platforms: [
                ...new Set(
                  (Array.isArray(item.images) ? item.images : [])
                    .slice(0, 100)
                    .filter(
                      (p) =>
                        p.os &&
                        p.architecture &&
                        p.os !== 'unknown' &&
                        p.architecture !== 'unknown',
                    )
                    .map(
                      (p) =>
                        `${cleanText(p.os, 25)}/${cleanText(p.architecture, 25)}${p.variant ? '/' + cleanText(p.variant, 20) : ''}`,
                    ),
                ),
              ].slice(0, 16),
            })),
      );
    },
  };
}

export function mountImageCatalog(app, options = {}) {
  const catalog = createImageCatalog(options);
  for (const kind of ['search', 'tags'])
    app.get(`/api/image-catalog/${kind}`, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await catalog[kind](req.query));
      } catch (error) {
        if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
        res.status(error.statusCode || 502).json({ error: error.message });
      }
    });
  return catalog;
}
