import Docker from 'dockerode';
import sshAgent from 'docker-modem/lib/ssh.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostSchema } from '../shared/workspace.mjs';
import { createInventoryService } from './inventory.mjs';
import { requestTimeout } from './streams.mjs';

export const keyFingerprint = (key) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
export class HostRegistry {
  constructor(store, localDocker, DockerClass = Docker) {
    this.store = store;
    this.localDocker = localDocker;
    this.DockerClass = DockerClass;
    this.clients = new Map();
    this.services = new Map();
    this.status = new Map();
    this.pending = new Map();
  }
  profile(id) {
    const h = this.store.read((s) => s.hosts.find((h) => h.id === id));
    if (!h) throw Object.assign(Error('Hôte inconnu.'), { statusCode: 404 });
    return h;
  }
  list() {
    return this.store
      .read((s) => s.hosts)
      .map((h) => ({
        ...h,
        connection: this.status.get(h.id) || {
          state: h.kind === 'ssh' && !h.fingerprint ? 'untrusted' : 'unknown',
        },
      }));
  }
  async save(input) {
    const existing = input.id
      ? this.store.read((s) => s.hosts.find((h) => h.id === input.id))
      : null;
    const value = hostSchema.parse({
      ...existing,
      ...input,
      id: existing?.id || `host-${randomUUID()}`,
      kind: input.kind || existing?.kind || 'ssh',
      fingerprint: existing?.fingerprint || null,
    });
    if (value.id === 'local' && value.kind !== 'local')
      throw Error('Le moteur local ne peut pas être remplacé.');
    if (value.kind === 'ssh' && value.auth === 'key' && !path.isAbsolute(value.identityFile))
      throw Error('Choisis le chemin absolu de la clé sur cet ordinateur.');
    if (existing && (existing.address !== value.address || existing.port !== value.port))
      value.fingerprint = null;
    await this.store.mutate((s) => {
      if (!existing && s.hosts.length >= 20) throw Error('Maximum de 20 hôtes.');
      s.hosts = [...s.hosts.filter((h) => h.id !== value.id), value];
    });
    if (
      !existing ||
      ['kind', 'address', 'port', 'username', 'auth', 'identityFile'].some(
        (k) => existing[k] !== value[k],
      )
    )
      this.invalidate(value.id);
    return value;
  }
  invalidate(id) {
    this.clients.delete(id);
    this.services.delete(id);
    this.status.delete(id);
    this.pending.delete(id);
  }
  async remove(id) {
    if (id === 'local') throw Error('Le moteur local est conservé.');
    await this.store.mutate((s) => {
      if (s.checks.some((c) => c.source.hostId === id || c.target.hostId === id))
        throw Error('Supprime d’abord les contrôles utilisant cet hôte.');
      s.hosts = s.hosts.filter((h) => h.id !== id);
    });
    this.invalidate(id);
  }
  async sshOptions(id) {
    const h = this.profile(id);
    const auth = {};
    if (h.auth === 'key') {
      const info = await stat(h.identityFile);
      if (!info.isFile() || info.size > 65536) throw Error('Fichier de clé invalide.');
      auth.privateKey = await readFile(h.identityFile);
    } else
      auth.agent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    if (h.auth === 'agent' && !auth.agent)
      throw Error(
        'Agent SSH indisponible. Charge une clé dans ton agent ou référence un fichier local.',
      );
    const sshOptions = {
      ...auth,
      host: h.address,
      port: h.port,
      username: h.username,
      readyTimeout: 10000,
      hostVerifier: (key) => {
        const fingerprint = keyFingerprint(key);
        if (h.fingerprint === fingerprint) return true;
        this.pending.set(id, { fingerprint, expires: Date.now() + 120000 });
        return false;
      },
    };
    return sshOptions;
  }
  async client(id) {
    if (id === 'local') return this.localDocker;
    if (this.clients.has(id)) return this.clients.get(id);
    const h = this.profile(id),
      sshOptions = await this.sshOptions(id);
    // Keep Dockerode's SSH dial-stdio transport. Its Channel has no setTimeout;
    // use an AbortSignal deadline instead of ClientRequest.setTimeout on Node 24.
    // HTTP URL construction also avoids docker-modem's nonstandard ssh: URL parsing.
    const docker = new this.DockerClass({
      protocol: 'http',
      host: h.address,
      port: h.port,
      timeout: 0,
      pathPrefix: '/',
    });
    const buildRequest = docker.modem.buildRequest.bind(docker.modem);
    docker.modem.buildRequest = (options, context, data, callback) => {
      const controller = new AbortController(),
        timer = setTimeout(
          () => controller.abort(Error('Délai SSH dépassé.')),
          requestTimeout(options),
        );
      const agent = sshAgent(sshOptions);
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      try {
        buildRequest({ ...options, agent, signal }, context, data, (error, result) => {
          clearTimeout(timer);
          if (error) agent.destroy();
          callback(error, result);
        });
      } catch (e) {
        clearTimeout(timer);
        agent.destroy();
        callback(e);
      }
    };
    this.clients.set(id, docker);
    return docker;
  }
  async test(id) {
    const h = this.profile(id);
    this.pending.delete(id);
    try {
      const docker = await this.client(id),
        info = await docker.info();
      if (info.OSType !== 'linux') throw Error('Un moteur Docker Linux est nécessaire.');
      const result = {
        state: 'connected',
        observedAt: Date.now(),
        engineId: info.ID,
        version: info.ServerVersion,
        name: info.Name,
      };
      this.status.set(id, result);
      return result;
    } catch (e) {
      const pending = this.pending.get(id);
      const result = pending
        ? {
            state: h.fingerprint ? 'changed-key' : 'untrusted',
            fingerprint: pending.fingerprint,
            previousFingerprint: h.fingerprint,
            message: h.fingerprint
              ? 'La clé du serveur a changé. Connexion refusée.'
              : 'Vérifie cette empreinte SSH avant d’autoriser la connexion.',
          }
        : { state: 'offline', message: e.message, observedAt: Date.now() };
      this.status.set(id, result);
      return result;
    }
  }
  async trust(id, fingerprint) {
    const pending = this.pending.get(id);
    if (!pending || pending.expires < Date.now() || pending.fingerprint !== fingerprint)
      throw Error('Teste à nouveau la connexion avant de confirmer cette empreinte.');
    await this.store.mutate((s) => {
      s.hosts.find((h) => h.id === id).fingerprint = fingerprint;
    });
    this.invalidate(id);
    return this.test(id);
  }
  async inventory(id) {
    this.profile(id);
    try {
      if (!this.services.has(id))
        this.services.set(id, createInventoryService(await this.client(id)));
      const result = await this.services.get(id).read();
      this.status.set(id, {
        state: 'connected',
        observedAt: result.observedAt,
        name: result.engine.name,
        version: result.engine.version,
      });
      return result;
    } catch (e) {
      const p = this.pending.get(id),
        h = this.profile(id);
      this.status.set(id, {
        state: p ? (h.fingerprint ? 'changed-key' : 'untrusted') : 'offline',
        message: p ? 'Identité SSH à vérifier dans Mes serveurs.' : e.message,
        fingerprint: p?.fingerprint,
      });
      throw e;
    }
  }
  async inspect(hostId, id) {
    await this.inventory(hostId);
    return this.services.get(hostId).inspect(id);
  }
  clearInventory(id) {
    this.services.delete(id);
  }
}
