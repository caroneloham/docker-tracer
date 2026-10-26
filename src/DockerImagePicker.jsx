import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Blocks,
  Check,
  Database,
  Globe,
  Search,
  Server,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { imageReference } from '../shared/image-catalog.mjs';
import { containerBrand } from '../shared/container-brands.mjs';
import EquipmentIcon from './EquipmentIcon.jsx';
import './docker-image-picker.css';
import { BROWSER_MODE } from './browser-mode.js';

const compact = (value) => new Intl.NumberFormat('fr', { notation: 'compact' }).format(value);
const quickImages = {
  nginx: ['library/nginx', 'Serveur web'],
  postgres: ['library/postgres', 'Base relationnelle'],
  redis: ['library/redis', 'Cache et données rapides'],
  ollama: ['ollama/ollama', 'Modèles IA locaux'],
  grafana: ['grafana/grafana', 'Tableaux de bord'],
  n8n: ['n8nio/n8n', 'Automatisation'],
  portainer: ['portainer/portainer-ce', 'Gestion de conteneurs'],
  traefik: ['library/traefik', 'Proxy et routage'],
  caddy: ['library/caddy', 'Serveur web et HTTPS'],
  apache: ['library/httpd', 'Serveur web Apache'],
  wordpress: ['library/wordpress', 'Sites et publication'],
  node: ['library/node', 'Applications JavaScript'],
  python: ['library/python', 'Applications Python'],
  php: ['library/php', 'Applications PHP'],
  mysql: ['library/mysql', 'Base relationnelle'],
  mariadb: ['library/mariadb', 'Base relationnelle'],
  mongo: ['library/mongo', 'Base de documents'],
  elasticsearch: ['library/elasticsearch', 'Recherche de données'],
  opensearch: ['opensearchproject/opensearch', 'Recherche et analyse'],
  minio: ['minio/minio', 'Stockage objet'],
  qdrant: ['qdrant/qdrant', 'Base vectorielle'],
  vllm: ['vllm/vllm-openai', 'Serveur de modèles IA'],
  chroma: ['chromadb/chroma', 'Base vectorielle'],
  localai: ['localai/localai', 'API pour modèles locaux'],
  nextcloud: ['library/nextcloud', 'Fichiers et collaboration'],
  jellyfin: ['jellyfin/jellyfin', 'Bibliothèque multimédia'],
  plex: ['plexinc/pms-docker', 'Serveur multimédia'],
  syncthing: ['syncthing/syncthing', 'Synchronisation de fichiers'],
  gitea: ['gitea/gitea', 'Hébergement Git'],
  gitlab: ['gitlab/gitlab-ce', 'Code et intégration continue'],
  prometheus: ['prom/prometheus', 'Mesures et supervision'],
  uptime: ['louislam/uptime-kuma', 'Suivi de disponibilité'],
  adguard: ['adguard/adguardhome', 'Filtrage DNS'],
  pihole: ['pihole/pihole', 'Filtrage DNS'],
  rabbitmq: ['library/rabbitmq', 'Messagerie applicative'],
  mosquitto: ['library/eclipse-mosquitto', 'Messagerie MQTT'],
  vault: ['hashicorp/vault', 'Gestion des secrets'],
  alpine: ['library/alpine', 'Système Linux léger'],
  ubuntu: ['library/ubuntu', 'Environnement Linux'],
};
const quickCategories = [
  {
    id: 'popular',
    label: 'Essentiels',
    icon: Blocks,
    images: ['nginx', 'postgres', 'redis', 'ollama', 'grafana', 'n8n', 'portainer', 'traefik'],
  },
  {
    id: 'web',
    label: 'Web et code',
    icon: Globe,
    images: ['nginx', 'caddy', 'traefik', 'apache', 'wordpress', 'node', 'python', 'php'],
  },
  {
    id: 'data',
    label: 'Données',
    icon: Database,
    images: [
      'postgres',
      'mysql',
      'mariadb',
      'mongo',
      'redis',
      'elasticsearch',
      'opensearch',
      'minio',
    ],
  },
  {
    id: 'ai',
    label: 'Intelligence artificielle',
    icon: Sparkles,
    images: ['ollama', 'vllm', 'localai', 'qdrant', 'chroma'],
  },
  {
    id: 'apps',
    label: 'Applications',
    icon: Blocks,
    images: ['nextcloud', 'n8n', 'jellyfin', 'plex', 'syncthing', 'gitea', 'gitlab'],
  },
  {
    id: 'ops',
    label: 'Infrastructure',
    icon: Server,
    images: [
      'grafana',
      'prometheus',
      'uptime',
      'portainer',
      'adguard',
      'pihole',
      'rabbitmq',
      'mosquitto',
      'vault',
      'alpine',
      'ubuntu',
    ],
  },
];

function quickRepository(key) {
  const [repository, description] = quickImages[key];
  return {
    repository,
    name: repository.replace(/^library\//, ''),
    description,
    official: repository.startsWith('library/'),
  };
}
async function catalog(path, signal) {
  if (BROWSER_MODE) {
    const [kind, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    if (kind === 'tags') {
      const repository = params.get('repository') || '';
      const tagQuery = (params.get('q') || '').toLowerCase();
      const results = !tagQuery || 'latest'.includes(tagQuery)
        ? [{ tag: 'latest', image: repository + ':latest', platforms: [], size: 0 }]
        : [];
      return { results, hasNext: false, cached: false };
    }
    const term = (params.get('q') || '').toLowerCase();
    const results = Object.keys(quickImages).map(quickRepository)
      .filter((item) => (item.name + ' ' + item.description).toLowerCase().includes(term))
      .map((item) => ({ ...item, pulls: 0, stars: 0 }));
    return { results, total: results.length, hasNext: false, cached: false };
  }
  const response = await fetch('/api/image-catalog/' + path, { signal });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Catalogue indisponible. Réessaie.');
  return data;
}
function Pagination({ data, page, setPage, busy }) {
  if (!data || (!data.hasNext && page === 1)) return null;
  return (
    <nav className="image-picker-pagination" aria-label="Pages du catalogue">
      <button type="button" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>
        <ArrowLeft size={15} /> Précédent
      </button>
      <span>Page {page}</span>
      <button type="button" disabled={busy || !data.hasNext} onClick={() => setPage(page + 1)}>
        Suivant <ArrowRight size={15} />
      </button>
    </nav>
  );
}

export default function DockerImagePicker({ onSelect, onClose, hostId, embedded = false }) {
  const titleId = useId(),
    searchId = useId(),
    manualId = useId(),
    dialog = useRef(null);
  const [mode, setMode] = useState('hub'),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState('popular');
  const [page, setPage] = useState(1),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [repository, setRepository] = useState(null),
    [tagQuery, setTagQuery] = useState(''),
    [tagSearch, setTagSearch] = useState('');
  const [tagPage, setTagPage] = useState(1),
    [tags, setTags] = useState(null),
    [tagBusy, setTagBusy] = useState(false),
    [tagError, setTagError] = useState('');
  const [selected, setSelected] = useState(null),
    [manual, setManual] = useState('');
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('input')?.focus();
    return () => {
      if (!embedded && previous?.isConnected) previous.focus?.();
    };
  }, [embedded]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setTagSearch(tagQuery.trim());
      setTagPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [tagQuery]);
  useEffect(() => {
    setError('');
    setResult(null);
    if (mode !== 'hub' || !search || repository) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    catalog('search?' + new URLSearchParams({ q: search, page: String(page) }), controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [search, page, mode, repository]);
  useEffect(() => {
    setTagError('');
    setTags(null);
    setSelected(null);
    if (mode !== 'hub' || !repository) {
      setTagBusy(false);
      return;
    }
    const controller = new AbortController();
    setTagBusy(true);
    catalog(
      'tags?' +
        new URLSearchParams({
          repository: repository.repository,
          page: String(tagPage),
          q: tagSearch,
        }),
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setTags(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTagError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setTagBusy(false);
      });
    return () => controller.abort();
  }, [repository, tagPage, tagSearch, mode]);
  let manualImage = '',
    manualError = '';
  try {
    manualImage = imageReference(manual);
  } catch (e) {
    manualError = e.message;
  }
  const choose = () => {
    if (mode === 'manual') {
      if (!manualImage) return;
      onSelect({ image: manualImage });
    } else if (repository && selected)
      onSelect({
        image: selected.image,
        name: repository.name.split('/').at(-1),
        description: repository.description,
      });
  };
  const useRepository = (item) => {
    setRepository(item);
    setTagQuery('');
    setTagSearch('');
    setTagPage(1);
    setSelected(null);
  };
  const onKeyDown = (event) => {
    if (embedded) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const items = [
      ...dialog.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]',
      ),
    ].filter((element) => element.getClientRects().length);
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1).focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0].focus();
    }
  };
  const content = (
    <section
      className={'image-picker' + (embedded ? ' image-picker-embedded' : '')}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={titleId}
      ref={dialog}
      onKeyDown={onKeyDown}
    >
      <header className="image-picker-header">
        <div>
          <span className="image-picker-eyebrow">{BROWSER_MODE ? 'CATALOGUE INTÉGRÉ' : 'CATALOGUE DOCKER'}</span>
          <h2 id={titleId}>
            <EquipmentIcon image="docker" /> Choisir une image
          </h2>
          <p>{BROWSER_MODE ? 'Choisis une référence courante ou saisis précisément ton image.' : 'Trouve ton application, choisis sa version et configure ta machine.'}</p>
        </div>
        {!embedded && (
          <button type="button" aria-label="Fermer le catalogue Docker" onClick={onClose}>
            <X size={20} />
          </button>
        )}
      </header>
      <div className="image-picker-modes" aria-label="Source de l’image">
        <button type="button" aria-pressed={mode === 'hub'} onClick={() => setMode('hub')}>
          <EquipmentIcon image="docker" /> {BROWSER_MODE ? 'Images courantes' : 'Docker Hub'}
        </button>
        <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
          <Terminal size={16} /> Référence manuelle
        </button>
      </div>
      <div className="image-picker-body">
        {mode === 'manual' ? (
          <div className="image-picker-manual">
            <div className="image-picker-manual-intro">
              <EquipmentIcon image={manualImage || 'docker'} />
              <div>
                <h3>Une image précise ?</h3>
                <p>Colle une référence Docker Hub ou celle d’un autre registre.</p>
              </div>
            </div>
            <label htmlFor={manualId}>Image et version</label>
            <input
              id={manualId}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="ghcr.io/organisation/image:version"
              autoComplete="off"
              spellCheck={false}
            />
            {manual && (
              <p className={manualImage ? 'image-picker-success' : 'image-picker-error'}>
                {manualImage ? `Image sélectionnée : ${manualImage}` : manualError}
              </p>
            )}
            <p className="image-picker-note">
              Sans version, Docker utilise « latest ». Pour un registre privé, les accès seront
              nécessaires au déploiement.
            </p>
          </div>
        ) : repository ? (
          <>
            <button
              type="button"
              className="image-picker-back"
              onClick={() => {
                setRepository(null);
                setSelected(null);
              }}
            >
              <ArrowLeft size={15} /> {search ? 'Résultats de recherche' : 'Catalogue Docker'}
            </button>
            <div className="image-picker-repository">
              <EquipmentIcon image={repository.repository} />
              <div>
                <h3>
                  {containerBrand(repository.repository)?.label || repository.name}{' '}
                  {repository.official && (
                    <span className="image-picker-badge">
                      <BadgeCheck size={13} /> Officielle
                    </span>
                  )}
                </h3>
                <code>{repository.name}</code>
                <p>{repository.description}</p>
              </div>
            </div>
            <label htmlFor={searchId}>Choisir une version</label>
            <input
              id={searchId}
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              placeholder="Filtrer les versions : alpine, 17, latest…"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="image-picker-live" role="status" aria-live="polite">
              {tagBusy
                ? 'Recherche des versions…'
                : tagError
                  ? ''
                  : tags
                    ? `${tags.results.length} versions affichées${tags.cached ? ' · en cache' : ''}`
                    : ''}
            </div>
            {tagError && (
              <p className="image-picker-error" role="alert">
                {tagError}
              </p>
            )}
            {tags && !tags.results.length && (
              <p className="image-picker-empty">
                Aucune version trouvée. Essaie un autre filtre ou saisis une référence manuelle.
              </p>
            )}
            <div className="image-picker-tags">
              {tags?.results.map((tag) => (
                <button
                  type="button"
                  key={tag.tag}
                  aria-pressed={selected?.tag === tag.tag}
                  onClick={() => setSelected(tag)}
                >
                  <span>
                    <strong>{tag.tag}</strong>
                    {selected?.tag === tag.tag && (
                      <Check size={16} aria-label="Version sélectionnée" />
                    )}
                  </span>
                  <small>{tag.platforms.join(' · ') || 'Architecture non précisée'}</small>
                  {tag.size > 0 && (
                    <small>≈ {Math.ceil(tag.size / 1024 ** 2)} Mio compressés</small>
                  )}
                </button>
              ))}
            </div>
            <Pagination data={tags} page={tagPage} setPage={setTagPage} busy={tagBusy} />
          </>
        ) : (
          <>
            <label htmlFor={searchId}>Quelle application ajouter ?</label>
            <form
              className="image-picker-search"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(query.trim());
                setPage(1);
              }}
            >
              <Search size={19} />
              <input
                id={searchId}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={80}
                placeholder="nginx, postgres, redis, ollama…"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  className="image-picker-clear"
                  aria-label="Effacer la recherche"
                  onClick={() => {
                    setQuery('');
                    setSearch('');
                    setPage(1);
                  }}
                >
                  <X size={16} />
                </button>
              )}
              <button type="submit" disabled={!query.trim()}>
                Rechercher
              </button>
            </form>
            {!search && (
              <div className="image-picker-starters">
                <div className="image-picker-starters-heading">
                  <h3>Choix rapides</h3>
                  <span>{BROWSER_MODE ? 'Références proposées · à vérifier avant déploiement' : 'Une application, puis sa version'}</span>
                </div>
                <div className="image-picker-categories" aria-label="Catégories d’applications">
                  {quickCategories.map(({ id, label, icon: Icon }) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={category === id}
                      onClick={() => setCategory(id)}
                    >
                      <Icon size={15} /> {label}
                    </button>
                  ))}
                </div>
                <div className="image-picker-quick-grid">
                  {quickCategories
                    .find(({ id }) => id === category)
                    .images.map((key) => {
                      const item = quickRepository(key);
                      const label = containerBrand(item.repository)?.label || item.name;
                      return (
                        <button
                          type="button"
                          className="image-picker-quick-card"
                          key={key}
                          onClick={() => useRepository(item)}
                          aria-label={`Choisir ${label}`}
                        >
                          <span className="image-picker-logo">
                            <EquipmentIcon image={item.repository} />
                          </span>
                          <strong>{label}</strong>
                          <small>{item.description}</small>
                          <span className="image-picker-quick-action">
                            {BROWSER_MODE ? 'Choisir la référence' : 'Voir les versions'} <ArrowRight size={13} />
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
            <div className="image-picker-live" role="status" aria-live="polite">
              {busy
                ? BROWSER_MODE ? 'Recherche dans le catalogue intégré…' : 'Recherche sur Docker Hub…'
                : result
                  ? `${compact(result.total)} résultats${result.cached ? ' · en cache' : ''}`
                  : ''}
            </div>
            {error && (
              <p className="image-picker-error" role="alert">
                {error}
              </p>
            )}
            {result && !result.results.length && (
              <p className="image-picker-empty">
                Aucune image trouvée. Essaie son nom exact ou utilise une référence manuelle.
              </p>
            )}
            <div className="image-picker-results">
              {result?.results.map((item) => (
                <button
                  type="button"
                  className="image-picker-card"
                  key={item.repository}
                  onClick={() => useRepository(item)}
                >
                  <span className="image-picker-card-heading">
                    <span className="image-picker-logo">
                      <EquipmentIcon image={item.repository} />
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      {item.official && (
                        <span className="image-picker-badge">
                          <BadgeCheck size={13} /> Officielle
                        </span>
                      )}
                    </span>
                  </span>
                  <p>{item.description || 'Aucune description fournie.'}</p>
                  {!BROWSER_MODE && <small>
                    {compact(item.pulls)} téléchargements · {compact(item.stars)} étoiles
                  </small>}
                  <span className="image-picker-card-action">
                    Choisir une version <ArrowRight size={14} />
                  </span>
                </button>
              ))}
            </div>
            <Pagination data={result} page={page} setPage={setPage} busy={busy} />
          </>
        )}
      </div>
      <footer className="image-picker-footer">
        <div className="image-picker-selection">
          <EquipmentIcon
            image={
              mode === 'manual'
                ? manualImage || 'docker'
                : selected?.image || repository?.repository || 'docker'
            }
          />
          <div>
            <strong>
              {mode === 'manual'
                ? manualImage || 'Référence de ton choix'
                : selected?.image || 'Choisis une image et sa version'}
            </strong>
            <p>
              {BROWSER_MODE
                ? 'Référence ajoutée au brouillon, sans accès au registre ni téléchargement.'
                : 'La recherche ne télécharge aucune image.'}
              {!BROWSER_MODE && hostId ? ' La machine sera ajoutée au serveur sélectionné.' : ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="image-picker-confirm"
          disabled={mode === 'manual' ? !manualImage : !selected || tagBusy}
          onClick={choose}
        >
          Utiliser cette image <ArrowRight size={16} />
        </button>
      </footer>
    </section>
  );
  if (embedded) return content;
  return createPortal(
    <div
      className="image-picker-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {content}
    </div>,
    document.body,
  );
}
