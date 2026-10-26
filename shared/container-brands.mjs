// Match published repositories, never a substring of a container name or image.
// Registry aliases below identify Docker Hub only; private mirrors stay generic.
export const containerBrands = Object.freeze({
  nginx: Object.freeze({ id: 'nginx', label: 'NGINX' }),
  redis: Object.freeze({ id: 'redis', label: 'Redis' }),
  postgresql: Object.freeze({ id: 'postgresql', label: 'PostgreSQL' }),
  caddy: Object.freeze({ id: 'caddy', label: 'Caddy' }),
  ollama: Object.freeze({ id: 'ollama', label: 'Ollama' }),
  vllm: Object.freeze({ id: 'vllm', label: 'vLLM' }),
  openwebui: Object.freeze({ id: 'openwebui', label: 'Open WebUI' }),
  qdrant: Object.freeze({ id: 'qdrant', label: 'Qdrant' }),
  huggingface: Object.freeze({ id: 'huggingface', label: 'Hugging Face' }),
  alpinelinux: Object.freeze({ id: 'alpinelinux', label: 'Alpine Linux' }),
  ubuntu: Object.freeze({ id: 'ubuntu', label: 'Ubuntu' }),
  docker: Object.freeze({ id: 'docker', label: 'Docker' }),
  grafana: Object.freeze({ id: 'grafana', label: 'Grafana' }),
  mysql: Object.freeze({ id: 'mysql', label: 'MySQL' }),
  mariadb: Object.freeze({ id: 'mariadb', label: 'MariaDB' }),
  mongodb: Object.freeze({ id: 'mongodb', label: 'MongoDB' }),
  elasticsearch: Object.freeze({ id: 'elasticsearch', label: 'Elasticsearch' }),
  opensearch: Object.freeze({ id: 'opensearch', label: 'OpenSearch' }),
  rabbitmq: Object.freeze({ id: 'rabbitmq', label: 'RabbitMQ' }),
  minio: Object.freeze({ id: 'minio', label: 'MinIO' }),
  traefik: Object.freeze({ id: 'traefik', label: 'Traefik Proxy' }),
  apache: Object.freeze({ id: 'apache', label: 'Apache' }),
  nodejs: Object.freeze({ id: 'nodejs', label: 'Node.js' }),
  python: Object.freeze({ id: 'python', label: 'Python' }),
  php: Object.freeze({ id: 'php', label: 'PHP' }),
  wordpress: Object.freeze({ id: 'wordpress', label: 'WordPress' }),
  nextcloud: Object.freeze({ id: 'nextcloud', label: 'Nextcloud' }),
  homeassistant: Object.freeze({ id: 'homeassistant', label: 'Home Assistant' }),
  prometheus: Object.freeze({ id: 'prometheus', label: 'Prometheus' }),
  portainer: Object.freeze({ id: 'portainer', label: 'Portainer' }),
  gitea: Object.freeze({ id: 'gitea', label: 'Gitea' }),
  gitlab: Object.freeze({ id: 'gitlab', label: 'GitLab' }),
  n8n: Object.freeze({ id: 'n8n', label: 'n8n' }),
  jellyfin: Object.freeze({ id: 'jellyfin', label: 'Jellyfin' }),
  plex: Object.freeze({ id: 'plex', label: 'Plex' }),
  adguard: Object.freeze({ id: 'adguard', label: 'AdGuard' }),
  pihole: Object.freeze({ id: 'pihole', label: 'Pi-hole' }),
  mosquitto: Object.freeze({ id: 'mosquitto', label: 'Eclipse Mosquitto' }),
  vault: Object.freeze({ id: 'vault', label: 'Vault' }),
  keycloak: Object.freeze({ id: 'keycloak', label: 'Keycloak' }),
  authentik: Object.freeze({ id: 'authentik', label: 'Authentik' }),
  immich: Object.freeze({ id: 'immich', label: 'Immich' }),
  uptimekuma: Object.freeze({ id: 'uptimekuma', label: 'Uptime Kuma' }),
  meilisearch: Object.freeze({ id: 'meilisearch', label: 'Meilisearch' }),
  syncthing: Object.freeze({ id: 'syncthing', label: 'Syncthing' }),
  lmstudio: Object.freeze({ id: 'lmstudio', label: 'LM Studio' }),
  chroma: Object.freeze({ id: 'chroma', label: 'Chroma' }),
  litellm: Object.freeze({ id: 'litellm', label: 'LiteLLM' }),
  localai: Object.freeze({ id: 'localai', label: 'LocalAI' }),
  llamacpp: Object.freeze({ id: 'llamacpp', label: 'llama.cpp' }),
});

const repositories = new Map([
  ['docker.io/library/mysql', 'mysql'],
  ['docker.io/library/mariadb', 'mariadb'],
  ['docker.io/library/mongo', 'mongodb'],
  ['docker.io/library/elasticsearch', 'elasticsearch'],
  ['docker.elastic.co/elasticsearch/elasticsearch', 'elasticsearch'],
  ['docker.io/opensearchproject/opensearch', 'opensearch'],
  ['docker.io/opensearchproject/opensearch-dashboards', 'opensearch'],
  ['docker.io/library/rabbitmq', 'rabbitmq'],
  ['quay.io/minio/minio', 'minio'],
  ['docker.io/minio/minio', 'minio'],
  ['docker.io/library/traefik', 'traefik'],
  ['docker.io/library/httpd', 'apache'],
  ['docker.io/library/node', 'nodejs'],
  ['docker.io/library/python', 'python'],
  ['docker.io/library/php', 'php'],
  ['docker.io/library/wordpress', 'wordpress'],
  ['docker.io/library/nextcloud', 'nextcloud'],
  ['ghcr.io/home-assistant/home-assistant', 'homeassistant'],
  ['docker.io/prom/prometheus', 'prometheus'],
  ['docker.io/portainer/portainer-ce', 'portainer'],
  ['docker.io/portainer/portainer-ee', 'portainer'],
  ['docker.gitea.com/gitea', 'gitea'],
  ['docker.io/gitea/gitea', 'gitea'],
  ['docker.io/gitlab/gitlab-ce', 'gitlab'],
  ['docker.io/gitlab/gitlab-ee', 'gitlab'],
  ['docker.io/n8nio/n8n', 'n8n'],
  ['docker.io/jellyfin/jellyfin', 'jellyfin'],
  ['docker.io/plexinc/pms-docker', 'plex'],
  ['docker.io/adguard/adguardhome', 'adguard'],
  ['docker.io/pihole/pihole', 'pihole'],
  ['docker.io/library/eclipse-mosquitto', 'mosquitto'],
  ['docker.io/hashicorp/vault', 'vault'],
  ['quay.io/keycloak/keycloak', 'keycloak'],
  ['ghcr.io/goauthentik/server', 'authentik'],
  ['ghcr.io/immich-app/immich-server', 'immich'],
  ['ghcr.io/immich-app/immich-machine-learning', 'immich'],
  ['docker.io/louislam/uptime-kuma', 'uptimekuma'],
  ['docker.io/getmeili/meilisearch', 'meilisearch'],
  ['docker.io/syncthing/syncthing', 'syncthing'],
  ['lscr.io/linuxserver/lm-studio', 'lmstudio'],
  ['docker.io/chromadb/chroma', 'chroma'],
  ['ghcr.io/berriai/litellm', 'litellm'],
  ['docker.litellm.ai/berriai/litellm', 'litellm'],
  ['docker.io/localai/localai', 'localai'],
  ['quay.io/go-skynet/local-ai', 'localai'],
  ['ghcr.io/ggml-org/llama.cpp', 'llamacpp'],
  ['docker.io/library/nginx', 'nginx'],
  ['docker.io/library/redis', 'redis'],
  ['docker.io/redis/redis-stack', 'redis'],
  ['docker.io/redis/redis-stack-server', 'redis'],
  ['docker.io/library/postgres', 'postgresql'],
  ['docker.io/library/caddy', 'caddy'],
  ['docker.io/ollama/ollama', 'ollama'],
  ['docker.io/vllm/vllm-openai', 'vllm'],
  ['ghcr.io/vllm-project/vllm-openai', 'vllm'],
  ['ghcr.io/open-webui/open-webui', 'openwebui'],
  ['docker.io/qdrant/qdrant', 'qdrant'],
  ['ghcr.io/huggingface/text-embeddings-inference', 'huggingface'],
  ['ghcr.io/huggingface/text-generation-inference', 'huggingface'],
  ['docker.io/library/alpine', 'alpinelinux'],
  ['docker.io/library/ubuntu', 'ubuntu'],
  ['docker.io/library/docker', 'docker'],
  ['docker.io/grafana/grafana', 'grafana'],
  ['docker.io/grafana/grafana-oss', 'grafana'],
  ['docker.io/grafana/grafana-enterprise', 'grafana'],
]);

export function containerImageRepository(image) {
  if (typeof image !== 'string') return null;
  let reference = image.trim();
  if (!reference || /\s|[\\?#]|:\/\//.test(reference)) return null;
  const digestAt = reference.indexOf('@');
  if (digestAt !== -1) {
    if (!/^sha256:[a-f0-9]{64}$/i.test(reference.slice(digestAt + 1))) return null;
    reference = reference.slice(0, digestAt);
  }
  const tagAt = reference.lastIndexOf(':');
  if (tagAt > reference.lastIndexOf('/')) {
    if (!/^[\w][\w.-]{0,127}$/.test(reference.slice(tagAt + 1))) return null;
    reference = reference.slice(0, tagAt);
  }
  const parts = reference.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && /[.:]|^localhost$/i.test(parts[0])) {
    registry = parts.shift().toLowerCase();
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  if (parts.some((part) => !/^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/.test(part))) return null;
  return registry + '/' + parts.join('/');
}

export function containerBrand(image) {
  return containerBrands[repositories.get(containerImageRepository(image))] || null;
}
