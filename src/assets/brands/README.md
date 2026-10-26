# Application logos

These logos identify the software running in a container. They do not indicate image verification, endorsement, authenticity, or security.

Only the selected assets are bundled: 48 brands. Rendering a map never contacts a third-party icon service. Unknown images keep Docker Tracer's original equipment drawing. Matching uses the complete repository and registry, ignoring valid tags and SHA-256 digests, rather than the container name or an arbitrary substring. Networks keep their network symbol.

## Sources and licenses

`sources.json` records every exact asset URL, upstream source, brand guideline, modification and available license. The expanded collection also records the image repositories and documentation used to establish their identity. Retrieved 2026-10-19. Image tags in tests are resolution examples, not version recommendations.

- Most assets are selected SVGs from [Simple Icons](https://github.com/simple-icons/simple-icons/tree/c71c69e3a27e4436936b831c72643e6513b9f49b), released under CC0-1.0. The full collection license is included as `LICENSE-simple-icons.txt`. Each colored SVG receives only the brand color supplied in that revision's metadata. Vault keeps Simple Icons' original monochrome black rendition for contrast on the light map. The original brands retain their respective trademarks and any applicable rights, as described in the [Simple Icons disclaimer](https://github.com/simple-icons/simple-icons/blob/c71c69e3a27e4436936b831c72643e6513b9f49b/DISCLAIMER.md).
- PHP: original brand artwork credited to the PHP Group, through Simple Icons; the upstream logo is [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/), included as `LICENSE-php-CC-BY-SA-4.0.txt`. Source: https://php.net/download-logos.php. Modification: official purple fill from Simple Icons metadata. That asset and its modification remain under the same license.
- Apache: Apache Software Foundation feather through Simple Icons; Apache-2.0 license included as `LICENSE-apache-2.0.txt`. Source: https://www.apache.org/foundation/press/kit. The feather identifies Apache HTTP Server here and is not used as Docker Tracer branding.
- Keycloak: official Keycloak mark through Simple Icons. Its metadata points to the [Linux Foundation trademark usage policy](https://www.linuxfoundation.org/legal/trademark-usage); no endorsement is implied.
- Open WebUI: unmodified official favicon SVG from [Open WebUI](https://github.com/open-webui/open-webui/tree/91ea4e3421d1d8069f13d4a463fcb5986d94ea60). Its embedded raster is part of the upstream SVG. Full license included as `LICENSE-openwebui.txt`; branding is preserved.
- Chroma, LiteLLM, LocalAI and llama.cpp: unmodified assets from their respective upstream repositories, pinned to revisions in `sources.json`. Full upstream license texts are included as `LICENSE-chroma.txt`, `LICENSE-litellm.txt`, `LICENSE-localai.txt` and `LICENSE-llamacpp.txt`. Chroma's upstream favicon retains its embedded Streamline description. LiteLLM's selected asset is outside its enterprise directory.

## Coverage

- AI and vector data: Ollama, Open WebUI, Qdrant, Chroma, LiteLLM, LocalAI, llama.cpp, LM Studio. vLLM and Hugging Face use the generic equipment icon because their logo assets are not distributed here.
- Databases and messaging: PostgreSQL, Redis, MySQL, MariaDB, MongoDB, Elasticsearch, OpenSearch, RabbitMQ, MinIO, Meilisearch.
- Web and application runtimes: NGINX, Caddy, Traefik Proxy, Apache HTTP Server, Node.js, Python, PHP, WordPress.
- Homelab and applications: Nextcloud, Home Assistant, Gitea, GitLab, n8n, Jellyfin, Plex, AdGuard Home, Pi-hole, Eclipse Mosquitto, Immich, Syncthing.
- Operations and access: Docker, Grafana, Prometheus, Portainer, Uptime Kuma, Vault, Keycloak, Authentik, Alpine Linux, Ubuntu.

LM Studio is recognized only for `lscr.io/linuxserver/lm-studio`, documented by its image publisher [LinuxServer](https://docs.linuxserver.io/images/docker-lm-studio/). This is a community-packaged desktop application, not a claim of an official LM Studio container. No arbitrary `lmstudio` or `llmster` repository is inferred. HAProxy is left on the equipment fallback because a suitable small SVG with established upstream provenance was not selected for this collection.

When adding a brand, add only its needed local asset, record its provenance here and in `sources.json`, and explicitly list the intended repositories in `shared/container-brands.mjs`. Never infer a brand from a private registry or partial image name.
