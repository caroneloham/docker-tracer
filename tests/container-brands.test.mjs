import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { containerBrand, containerImageRepository } from '../shared/container-brands.mjs';

test('recognizes Docker Hub aliases, tags and digest-pinned images', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  for (const image of [
    'nginx',
    'nginx:1.27-alpine',
    'library/nginx',
    'docker.io/nginx:alpine',
    'index.docker.io/library/nginx:1.27',
    'registry-1.docker.io/library/nginx@' + digest,
    'nginx:alpine@' + digest,
  ]) {
    assert.equal(containerImageRepository(image), 'docker.io/library/nginx', image);
    assert.equal(containerBrand(image)?.label, 'NGINX', image);
  }
});

test('identifies actual application repositories, including the displayed TEI image', () => {
  for (const [image, label] of [
    ['redis:7-alpine', 'Redis'],
    ['postgres:17-alpine', 'PostgreSQL'],
    ['caddy:2-alpine', 'Caddy'],
    ['ollama/ollama:latest', 'Ollama'],
    ['vllm/vllm-openai:v0.11.0', 'vLLM'],
    ['ghcr.io/open-webui/open-webui:main', 'Open WebUI'],
    ['qdrant/qdrant:latest', 'Qdrant'],
    ['ghcr.io/huggingface/text-embeddings-inference:cpu-1.9', 'Hugging Face'],
    ['ghcr.io/huggingface/text-generation-inference:3.3', 'Hugging Face'],
    ['alpine:3.22', 'Alpine Linux'],
    ['ubuntu:24.04', 'Ubuntu'],
    ['docker:28-dind', 'Docker'],
    ['grafana/grafana:12', 'Grafana'],
    ['mysql:8.4', 'MySQL'],
    ['mariadb:11', 'MariaDB'],
    ['mongo:8', 'MongoDB'],
    ['docker.elastic.co/elasticsearch/elasticsearch:9.1.0', 'Elasticsearch'],
    ['opensearchproject/opensearch:3', 'OpenSearch'],
    ['rabbitmq:4-management', 'RabbitMQ'],
    ['quay.io/minio/minio:RELEASE.2025-01-01T00-00-00Z', 'MinIO'],
    ['traefik:v3', 'Traefik Proxy'],
    ['httpd:2.4-alpine', 'Apache'],
    ['node:24-alpine', 'Node.js'],
    ['python:3.13-slim', 'Python'],
    ['php:8.4-fpm', 'PHP'],
    ['wordpress:latest', 'WordPress'],
    ['nextcloud:apache', 'Nextcloud'],
    ['ghcr.io/home-assistant/home-assistant:stable', 'Home Assistant'],
    ['prom/prometheus:latest', 'Prometheus'],
    ['portainer/portainer-ce:latest', 'Portainer'],
    ['docker.gitea.com/gitea:latest', 'Gitea'],
    ['gitlab/gitlab-ce:latest', 'GitLab'],
    ['n8nio/n8n:latest', 'n8n'],
    ['jellyfin/jellyfin:latest', 'Jellyfin'],
    ['plexinc/pms-docker:latest', 'Plex'],
    ['adguard/adguardhome:latest', 'AdGuard'],
    ['pihole/pihole:latest', 'Pi-hole'],
    ['eclipse-mosquitto:2', 'Eclipse Mosquitto'],
    ['hashicorp/vault:1.19', 'Vault'],
    ['quay.io/keycloak/keycloak:26', 'Keycloak'],
    ['ghcr.io/goauthentik/server:2026.2', 'Authentik'],
    ['ghcr.io/immich-app/immich-server:release', 'Immich'],
    ['louislam/uptime-kuma:2', 'Uptime Kuma'],
    ['getmeili/meilisearch:v1', 'Meilisearch'],
    ['syncthing/syncthing:latest', 'Syncthing'],
    ['chromadb/chroma:latest', 'Chroma'],
    ['ghcr.io/berriai/litellm:main-stable', 'LiteLLM'],
    ['docker.litellm.ai/berriai/litellm:latest', 'LiteLLM'],
    ['localai/localai:latest-gpu-nvidia-cuda-12', 'LocalAI'],
    ['quay.io/go-skynet/local-ai:latest', 'LocalAI'],
    ['ghcr.io/ggml-org/llama.cpp:server-cuda', 'llama.cpp'],
    ['lscr.io/linuxserver/lm-studio:latest', 'LM Studio'],
  ])
    assert.equal(containerBrand(image)?.label, label, image);
});

test('does not mistake untrusted namespaces, registries, or similarly named tools for a vendor', () => {
  for (const image of [
    'customer/nginx',
    'nginx-tools',
    'nginx-client:latest',
    'customer/redis-exporter',
    'localhost:5000/nginx:alpine',
    'mirror.example:443/library/nginx',
    'ghcr.io/customer/open-webui',
    'docker.io/huggingface/text-embeddings-inference',
    'vllm/customer-app',
    'ghcr.io/nginx',
    'docker.io.evil.example/library/nginx',
    'registry-1.docker.io:5000/library/nginx',
    'ghcr.io/customer/litellm',
    'customer/localai',
    'docker.io/library/lmstudio',
    'lmstudio/llmster-preview:cpu',
    'lscr.io/customer/lm-studio',
    'linuxserver/lm-studio-tools',
    'my-nextcloud-backup',
    'prom/prometheus-exporter',
    'quay.io/keycloak/keycloak-backup',
    'ghcr.io/immich-app/unknown-image',
  ])
    assert.equal(containerBrand(image), null, image);
});

test('bad references and unknown images retain the equipment fallback', () => {
  for (const image of [
    null,
    undefined,
    {},
    '',
    'image locale',
    'nginx:',
    'NGINX',
    'https://docker.io/library/nginx',
    'nginx@invalid',
    'nginx@sha256:123',
    'nginx//',
    '../nginx',
    'nginx?tag=latest',
    'busybox:latest',
  ])
    assert.equal(containerBrand(image), null, String(image));
});

test('bundled SVG logos use no scripts or remote resources', async () => {
  const directory = new URL('../src/assets/brands/', import.meta.url);
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.svg'))) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.match(source, /<svg[\s>]/, name);
    assert.doesNotMatch(
      source,
      /<script\b|<foreignObject\b|<!DOCTYPE\b|<!ENTITY\b|\son\w+\s*=/i,
      name,
    );
    for (const match of source.matchAll(/(?:href\s*=\s*["']|url\(\s*["']?)([^"'\s)>]+)/gi)) {
      assert.ok(
        match[1].startsWith('#') || match[1].startsWith('data:image/png;base64,'),
        `${name}: ${match[1].slice(0, 80)}`,
      );
    }
  }
});
