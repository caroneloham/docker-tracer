import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import tar from 'tar-stream';
import express from 'express';
import { z } from 'zod';
import { containerId, recordId } from '../shared/workspace.mjs';
import { disableIdleTimeout } from './streams.mjs';

const FILE_LIMIT = 256 * 1024;
export const UPLOAD_LIMIT = 20 * 1024 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
const DIRECTORY = 0x80000000;
const SYMLINK = 0x08000000;
const TYPE_MASK = 0x8f280000;
const failure = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const expectedName = z.string().min(1).max(256);
const shellChoices = [
  { path: '/bin/bash', label: 'Bash' },
  { path: '/usr/bin/bash', label: 'Bash' },
  { path: '/bin/ash', label: 'Ash' },
  { path: '/bin/sh', label: 'Sh' },
];
const shellSchema = z.enum(shellChoices.map((shell) => shell.path));
const terminalColumns = z.number().int().min(20).max(400);
const terminalRows = z.number().int().min(5).max(160);
const terminalSize = z.object({ cols: terminalColumns, rows: terminalRows }).strict();
const pathname = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value)) return false;
    if (value.split('/').length > 42) return false;
    if (path.posix.normalize(value) !== value || (value !== '/' && value.endsWith('/')))
      return false;
    return !['/proc', '/sys', '/dev'].some(
      (prefix) => value === prefix || value.startsWith(prefix + '/'),
    );
  }, 'Utilise un chemin absolu direct, hors de /proc, /sys et /dev.');
const uploadMetadata = z
  .object({
    expectedName,
    path: pathname.refine(
      (value) => value !== '/' && Buffer.byteLength(path.posix.basename(value), 'utf8') <= 255,
      'Choisis un nom de fichier de 255 octets maximum.',
    ),
  })
  .strict();
const readableText = (buffer) => {
  if (buffer.includes(0))
    throw failure('Ce fichier est binaire. Seuls les fichiers texte UTF-8 sont éditables.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw failure('Ce fichier ne contient pas du texte UTF-8 valide.');
  }
};
const withDeadline = async (operation, milliseconds = 12000, disposeLate) => {
  let timer,
    expired = false;
  try {
    return await Promise.race([
      Promise.resolve(operation).then((value) => {
        if (expired) disposeLate?.(value);
        return value;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(failure('Docker ne répond pas dans le délai prévu.', 504));
        }, milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

async function inspectPath(container, value, { directory = false } = {}) {
  const segments =
    value === '/'
      ? ['/']
      : [
          '/',
          ...value
            .slice(1)
            .split('/')
            .map((_, index, all) => '/' + all.slice(0, index + 1).join('/')),
        ];
  let last;
  for (const target of segments) {
    const response = await withDeadline(container.infoArchive({ path: target }), 12000, (late) =>
      late.destroy?.(),
    );
    const encoded = response.headers?.['x-docker-container-path-stat'];
    response.resume?.();
    if (!encoded) throw failure('Docker ne fournit pas les métadonnées de ce chemin.');
    try {
      last = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      throw failure('Métadonnées Docker invalides.');
    }
    if (!Number.isSafeInteger(last.mode) || !Number.isSafeInteger(last.size) || last.size < 0)
      throw failure('Métadonnées Docker invalides.');
    const mode = last.mode >>> 0;
    if (last.linkTarget || mode & SYMLINK)
      throw failure('Ce chemin traverse un lien symbolique. Choisis le chemin réel du fichier.');
    if ((mode & TYPE_MASK) !== 0 && !(mode & DIRECTORY))
      throw failure('Les périphériques, sockets et fichiers spéciaux ne sont pas éditables.');
    if (target !== value && !(mode & DIRECTORY))
      throw failure('Un parent de ce chemin n’est pas un dossier.');
  }
  if (directory !== !!((last.mode >>> 0) & DIRECTORY))
    throw failure(
      directory ? 'Ce chemin n’est pas un dossier.' : 'Choisis un fichier, pas un dossier.',
    );
  return last;
}

async function readArchive(container, value) {
  const info = await inspectPath(container, value);
  if (info.size > FILE_LIMIT) throw failure('Le fichier dépasse la limite de 256 Kio.', 413);
  const archive = await withDeadline(container.getArchive({ path: value }), 12000, (late) =>
    late.destroy?.(),
  );
  const extract = tar.extract();
  const pieces = [];
  let bytes = 0,
    wireBytes = 0,
    entries = 0,
    header;
  const content = new Promise((resolve, reject) => {
    extract.on('entry', (entry, stream, next) => {
      entries++;
      if (
        entries !== 1 ||
        entry.type !== 'file' ||
        entry.name !== path.posix.basename(value) ||
        entry.size > FILE_LIMIT
      ) {
        stream.resume();
        extract.destroy(
          failure(
            'Archive inattendue : le fichier a changé ou n’est pas un fichier texte ordinaire.',
          ),
        );
        return;
      }
      header = entry;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > FILE_LIMIT)
          extract.destroy(failure('Le fichier dépasse la limite de 256 Kio.', 413));
        else pieces.push(chunk);
      });
      stream.on('end', next);
      stream.on('error', reject);
    });
    extract.on('error', reject);
    extract.on('finish', () =>
      entries === 1
        ? resolve(Buffer.concat(pieces))
        : reject(failure('Le fichier est absent de l’archive Docker.')),
    );
    archive.on('data', (chunk) => {
      wireBytes += chunk.length;
      if (wireBytes > FILE_LIMIT + 65536)
        extract.destroy(failure('Archive Docker trop volumineuse.', 413));
    });
    archive.on('error', reject);
    archive.pipe(extract);
  });
  try {
    const buffer = await withDeadline(content);
    return {
      content: readableText(buffer),
      hash: hash(buffer),
      bytes: buffer.length,
      header,
      info,
    };
  } finally {
    archive.destroy();
    extract.destroy();
  }
}

async function requireAbsent(container, filename) {
  try {
    const response = await withDeadline(container.infoArchive({ path: filename }), 12000, (late) =>
      late.destroy?.(),
    );
    response.resume?.();
  } catch (error) {
    if (error.statusCode === 404) return;
    throw error;
  }
  throw failure('Ce nom existe déjà. Choisis un autre nom pour importer le fichier.', 409);
}

async function verifyUploadedFile(container, filename, content) {
  const info = await inspectPath(container, filename);
  if (info.size !== content.length)
    throw failure(
      'La taille du fichier importé a changé. Vérifie le fichier avant de réessayer.',
      409,
    );
  const archive = await withDeadline(container.getArchive({ path: filename }), 12000, (late) =>
    late.destroy?.(),
  );
  const extract = tar.extract(),
    digest = createHash('sha256');
  let entries = 0,
    bytes = 0,
    wireBytes = 0;
  const verified = new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (
        ++entries !== 1 ||
        header.type !== 'file' ||
        header.name !== path.posix.basename(filename) ||
        header.size !== content.length
      ) {
        stream.resume();
        extract.destroy(failure('Le fichier importé a changé pendant la vérification.', 409));
        return;
      }
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > content.length)
          extract.destroy(failure('Le fichier importé a changé pendant la vérification.', 409));
        else digest.update(chunk);
      });
      stream.on('end', next);
      stream.on('error', reject);
    });
    extract.on('error', reject);
    extract.on('finish', () => {
      if (entries !== 1 || bytes !== content.length || digest.digest('hex') !== hash(content))
        reject(
          failure(
            'Le contenu du fichier importé a changé. Vérifie le fichier avant de réessayer.',
            409,
          ),
        );
      else resolve();
    });
    archive.on('data', (chunk) => {
      wireBytes += chunk.length;
      if (wireBytes > UPLOAD_LIMIT + 65536)
        extract.destroy(failure('Archive Docker trop volumineuse.', 413));
    });
    archive.on('error', reject);
    archive.pipe(extract);
  });
  try {
    await withDeadline(verified, 30000);
  } finally {
    archive.destroy();
    extract.destroy();
  }
}

async function commandOutput(docker, container, command) {
  let exec;
  try {
    exec = await withDeadline(
      container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false }),
    );
  } catch (error) {
    throw failure(
      `Impossible de lancer /bin/sh. Cette image peut ne pas contenir de shell. Tu peux ouvrir un fichier par son chemin exact. ${error.message}`,
    );
  }
  let stream;
  try {
    stream = await withDeadline(exec.start({ hijack: true, stdin: false }), 12000, (late) =>
      late.destroy?.(),
    );
  } catch (error) {
    throw failure(
      `Shell indisponible dans ce conteneur. Aucun outil n’a été installé. ${error.message}`,
    );
  }
  const out = new PassThrough(),
    err = new PassThrough();
  const chunks = [],
    errors = [];
  let bytes = 0;
  const ended = new Promise((resolve, reject) => {
    for (const [target, list] of [
      [out, chunks],
      [err, errors],
    ])
      target.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 512 * 1024) {
          reject(
            failure('Ce dossier contient trop d’éléments. Ouvre un sous-dossier directement.', 413),
          );
          stream.destroy();
        } else list.push(chunk);
      });
    stream.once('end', resolve);
    stream.once('error', reject);
    stream.once('close', resolve);
    docker.modem.demuxStream(stream, out, err);
  });
  try {
    await withDeadline(ended);
    const result = await withDeadline(exec.inspect());
    if (result.ExitCode === 42)
      throw failure(
        'Ce dossier contient plus de 1 000 éléments. Ouvre un sous-dossier directement.',
        413,
      );
    if (result.Running || result.ExitCode !== 0)
      throw failure(
        Buffer.concat(errors).toString('utf8').slice(0, 1500) ||
          'Impossible de parcourir ce dossier avec le shell de l’image.',
      );
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    stream.destroy();
    out.destroy();
    err.destroy();
  }
}

export class ContainerWorkbenchService {
  constructor(
    hosts,
    { emit = () => {}, idleMs = 120000, lifetimeMs = 900000, now = Date.now } = {},
  ) {
    this.hosts = hosts;
    this.emit = emit;
    this.idleMs = idleMs;
    this.lifetimeMs = lifetimeMs;
    this.now = now;
    this.sessions = new Map();
    this.writes = new Set();
    this.opening = 0;
    this.timer = setInterval(() => this.sweep(), 10000);
    this.timer.unref?.();
  }
  async target(hostId, id, name, running = false) {
    recordId.parse(hostId);
    containerId.parse(id);
    this.hosts.profile(hostId);
    const docker = await this.hosts.client(hostId),
      container = docker.getContainer(id);
    const info = await withDeadline(container.inspect());
    if (info.Id !== id) throw failure('La cible Docker a changé. Actualise la carte.', 409);
    const currentName = (info.Name || '').replace(/^\//, '');
    if (name !== undefined && expectedName.parse(name) !== currentName)
      throw failure('Le nom du conteneur a changé. Actualise la carte avant de continuer.', 409);
    if (
      ['capture', 'observer', 'diagnostic', 'startup', 'backup'].includes(
        info.Config?.Labels?.['io.dockertracer.role'],
      )
    )
      throw failure('Les sondes de diagnostic ne sont pas des conteneurs applicatifs.');
    if (running && (!info.State?.Running || info.State.Paused))
      throw failure(
        'Démarre le conteneur avant d’ouvrir un terminal ou de parcourir ses dossiers.',
        409,
      );
    return { docker, container, info, name: currentName };
  }
  session(hostId, id, sessionId) {
    recordId.parse(hostId);
    containerId.parse(id);
    z.string().uuid().parse(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session || session.hostId !== hostId || session.containerId !== id)
      throw failure('Session introuvable ou terminée.', 404);
    return session;
  }
  async open(hostId, id, input) {
    const body = z
      .object({
        expectedName,
        shell: shellSchema.default('/bin/sh'),
        cols: terminalColumns.optional(),
        columns: terminalColumns.optional(),
        rows: terminalRows.default(30),
      })
      .strict()
      .refine(
        (value) =>
          value.cols === undefined || value.columns === undefined || value.cols === value.columns,
        'cols et columns doivent correspondre.',
      )
      .parse(input);
    const cols = body.cols ?? body.columns ?? 120;
    if (this.sessions.size + this.opening >= 6)
      throw failure('Six terminaux sont déjà ouverts. Ferme une session pour continuer.', 429);
    this.opening++;
    let stream, sessionId;
    try {
      const { container, name } = await this.target(hostId, id, body.expectedName, true);
      let exec;
      try {
        exec = await withDeadline(
          container.exec({
            Cmd: [body.shell, '-i'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: ['TERM=xterm-256color'],
          }),
        );
        stream = await withDeadline(
          exec.start({ hijack: true, stdin: true, Tty: true }),
          12000,
          (late) => {
            late.end?.('\x03\nexit\n\x04');
            late.destroy?.();
          },
        );
      } catch (error) {
        throw failure(
          `Le shell ${body.shell} est indisponible ou Docker a refusé la session. Essaie l’autre shell ; les images sans shell restent gérables via leurs fichiers et leur configuration. ${error.message}`,
        );
      }
      disableIdleTimeout(stream);
      const created = this.now();
      const session = {
        id: randomUUID(),
        hostId,
        containerId: id,
        expectedName: name,
        exec,
        stream,
        chunks: [],
        offset: 0,
        start: 0,
        created,
        touched: created,
        closed: false,
        reason: null,
      };
      this.sessions.set(session.id, session);
      sessionId = session.id;
      stream.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        session.chunks.push(bytes);
        session.offset += bytes.length;
        while (session.offset - session.start > OUTPUT_LIMIT && session.chunks.length) {
          const head = session.chunks[0],
            excess = session.offset - session.start - OUTPUT_LIMIT;
          if (head.length <= excess) {
            session.chunks.shift();
            session.start += head.length;
          } else {
            session.chunks[0] = head.subarray(excess);
            session.start += excess;
          }
        }
      });
      const closed = (reason) => {
        session.closed = true;
        session.reason ||= reason;
      };
      stream.on('end', () => closed('Shell terminé.'));
      stream.on('close', () => closed('Connexion fermée.'));
      stream.on('error', (error) => closed(`Connexion interrompue : ${error.message}`));
      // Docker can send a failed exec as a successful hijacked HTTP connection
      // followed by OCI error text, instead of rejecting exec.start().
      const started = await withDeadline(exec.inspect());
      if (
        started.Running === false &&
        Number.isInteger(started.ExitCode) &&
        started.ExitCode !== 0
      ) {
        throw failure(
          `Le shell ${body.shell} n’a pas pu démarrer dans cette image. Essaie l’autre shell ; l’ouverture des fichiers par chemin exact reste disponible sans shell.`,
        );
      }
      await withDeadline(exec.resize({ w: cols, h: body.rows }));
      this.emit({ type: 'container-terminal', hostId, containerId: id, action: 'opened' });
      return {
        id: session.id,
        shell: body.shell,
        cols,
        rows: body.rows,
        user: 'Utilisateur configuré dans le conteneur',
        expiresAt: created + this.lifetimeMs,
      };
    } catch (error) {
      if (sessionId && this.sessions.has(sessionId)) this.close(hostId, id, sessionId);
      else stream?.destroy();
      throw error;
    } finally {
      this.opening--;
    }
  }
  async shells(hostId, id, name) {
    const { container } = await this.target(hostId, id, name, true);
    // Docker metadata only: never execute discovery commands in the user's session.
    const inspectExecutable = async (filename) => {
      const visited = new Set();
      let target = filename;
      for (let count = 0; count < 8; count++) {
        if (visited.has(target)) return false;
        visited.add(target);
        let response;
        try {
          response = await withDeadline(container.infoArchive({ path: target }), 12000, (late) =>
            late.destroy?.(),
          );
        } catch (error) {
          if (error.statusCode === 404) return false;
          throw error;
        }
        response.resume?.();
        let stat;
        try {
          stat = JSON.parse(
            Buffer.from(
              response.headers?.['x-docker-container-path-stat'] || '',
              'base64',
            ).toString('utf8'),
          );
        } catch {
          throw failure('Docker ne fournit pas les métadonnées des shells.');
        }
        if (!Number.isInteger(stat.mode)) throw failure('Métadonnées du shell invalides.');
        if ((stat.mode >>> 0) & SYMLINK) {
          if (
            typeof stat.linkTarget !== 'string' ||
            !stat.linkTarget ||
            /[\x00-\x1f\x7f]/.test(stat.linkTarget)
          )
            return false;
          target = path.posix.resolve(path.posix.dirname(target), stat.linkTarget);
          continue;
        }
        return ((stat.mode >>> 0) & TYPE_MASK) === 0 && !!(stat.mode & 0o111);
      }
      return false;
    };
    const candidates = await Promise.all(
      shellChoices.map(async (shell) => ({
        ...shell,
        present: await inspectExecutable(shell.path),
      })),
    );
    const labels = new Set();
    const shells = candidates
      .filter((shell) => {
        if (!shell.present || labels.has(shell.label)) return false;
        labels.add(shell.label);
        return true;
      })
      .map(({ path, label }) => ({ path, label }));
    return { shells, preferred: shells[0]?.path || null };
  }
  readSession(hostId, id, sessionId, cursor = 0) {
    const session = this.session(hostId, id, sessionId);
    const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(cursor);
    session.touched = this.now();
    const buffer = Buffer.concat(session.chunks).subarray(Math.max(0, offset - session.start));
    return {
      output: buffer.toString('utf8'),
      dataBase64: buffer.toString('base64'),
      cursor: session.offset,
      truncated: offset < session.start,
      closed: session.closed,
      reason: session.reason,
    };
  }
  async input(hostId, id, sessionId, input) {
    const body = z
      .object({ data: z.string().min(1).max(8192) })
      .strict()
      .parse(input);
    const session = this.session(hostId, id, sessionId);
    if (session.closed) throw failure(session.reason || 'La session est terminée.', 409);
    await this.target(hostId, id, session.expectedName, true);
    if (session.stream.writableLength > 32768)
      throw failure('Le terminal est occupé. Attends avant d’envoyer la suite.', 429);
    session.touched = this.now();
    session.stream.write(body.data);
    return { ok: true };
  }
  async resize(hostId, id, sessionId, input) {
    const body = terminalSize.parse(input);
    const session = this.session(hostId, id, sessionId);
    if (session.closed) throw failure(session.reason || 'La session est terminée.', 409);
    await this.target(hostId, id, session.expectedName, true);
    await withDeadline(session.exec.resize({ w: body.cols, h: body.rows }));
    session.touched = this.now();
    return { ok: true, cols: body.cols, rows: body.rows };
  }
  close(hostId, id, sessionId, reason = 'Session fermée.') {
    const session = this.session(hostId, id, sessionId);
    session.closed = true;
    session.reason = reason;
    // TTY interrupt followed by a normal shell exit; no unrelated container process is killed.
    if (!session.stream.destroyed) {
      try {
        session.stream.write('\x03\nexit\n\x04');
        session.stream.end();
      } catch {}
      const timer = setTimeout(() => session.stream.destroy(), 1000);
      timer.unref?.();
    }
    this.sessions.delete(sessionId);
    return { ok: true };
  }
  sweep() {
    for (const session of this.sessions.values())
      if (
        this.now() - session.touched > this.idleMs ||
        this.now() - session.created > this.lifetimeMs
      )
        this.close(session.hostId, session.containerId, session.id, 'Session expirée.');
  }
  async files(hostId, id, value) {
    const directory = pathname.parse(value);
    const { docker, container } = await this.target(hostId, id, undefined, true);
    await inspectPath(container, directory, { directory: true });
    // Arguments never become shell source. POSIX globbing also works in BusyBox images.
    const script =
      '[ -r "$1" ] && [ -x "$1" ] || { printf "Permission refusee pour ce dossier.\\n" >&2; exit 1; }; count=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; count=$((count+1)); [ "$count" -le 1000 ] || exit 42; if [ -L "$p" ]; then t=link; elif [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=special; fi; printf "%s\\000%s\\000" "$t" "${p##*/}"; done';
    const output = await commandOutput(docker, container, [
      '/bin/sh',
      '-c',
      script,
      'docker-tracer-list',
      directory,
    ]);
    const parts = output.split('\0');
    const entries = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const type = parts[index],
        name = parts[index + 1];
      if (!['file', 'directory', 'link', 'special'].includes(type) || !name || name.includes('/'))
        throw failure('Réponse du dossier invalide.');
      entries.push({
        name,
        type,
        path: path.posix.join(directory, name),
        accessible: !/[\x00-\x1f\x7f\\]/.test(name) && ['file', 'directory'].includes(type),
      });
    }
    return {
      path: directory,
      entries: entries.sort(
        (a, b) =>
          (a.type !== 'directory') - (b.type !== 'directory') || a.name.localeCompare(b.name),
      ),
      limit: 1000,
    };
  }
  async readFile(hostId, id, value) {
    const filename = pathname.parse(value);
    const { container } = await this.target(hostId, id);
    const result = await readArchive(container, filename);
    return { path: filename, content: result.content, hash: result.hash, bytes: result.bytes };
  }
  async writeFile(hostId, id, input) {
    const body = z
      .object({
        expectedName,
        path: pathname,
        content: z.string().max(FILE_LIMIT),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    const content = Buffer.from(body.content, 'utf8');
    if (content.length > FILE_LIMIT) throw failure('Le fichier dépasse la limite de 256 Kio.', 413);
    readableText(content);
    const key = `${hostId}:${id}:${body.path}`;
    if (this.writes.has(key)) throw failure('Une écriture est déjà en cours sur ce fichier.', 409);
    this.writes.add(key);
    try {
      const { container } = await this.target(hostId, id, body.expectedName);
      const previous = await readArchive(container, body.path);
      if (previous.hash !== body.hash)
        throw failure(
          'Ce fichier a changé depuis son ouverture. Recharge-le avant d’enregistrer pour conserver les autres modifications.',
          409,
        );
      await inspectPath(container, body.path);
      const pack = tar.pack(),
        chunks = [];
      const encoded = (async () => {
        for await (const chunk of pack) chunks.push(chunk);
        return Buffer.concat(chunks);
      })();
      pack.entry(
        {
          name: path.posix.basename(body.path),
          type: 'file',
          mode: previous.header.mode & 0o777,
          uid: previous.header.uid,
          gid: previous.header.gid,
          size: content.length,
        },
        content,
      );
      pack.finalize();
      const controller = new AbortController();
      try {
        await withDeadline(
          container.putArchive(await encoded, {
            path: path.posix.dirname(body.path),
            noOverwriteDirNonDir: true,
            abortSignal: controller.signal,
          }),
          15000,
        );
      } catch (error) {
        throw failure(
          `L’enregistrement n’a pas pu être confirmé. Recharge le fichier pour vérifier son contenu avant de réessayer. ${error.message}`,
          error.statusCode || 502,
        );
      } finally {
        controller.abort();
      }
      const result = await readArchive(container, body.path);
      if (result.hash !== hash(content))
        throw failure(
          'Le contenu a changé pendant l’enregistrement. Recharge le fichier et vérifie son contenu.',
          409,
        );
      this.emit({
        type: 'container-file',
        hostId,
        containerId: id,
        action: 'saved',
        path: body.path,
      });
      return { path: body.path, content: result.content, hash: result.hash, bytes: result.bytes };
    } finally {
      this.writes.delete(key);
    }
  }
  async uploadFile(hostId, id, input, content) {
    const body = uploadMetadata.parse(input);
    if (!Buffer.isBuffer(content))
      throw failure('Envoie un fichier avec le type application/octet-stream.', 415);
    if (content.length > UPLOAD_LIMIT)
      throw failure('Le fichier dépasse la limite de 20 Mio.', 413);
    const key = `${hostId}:${id}:${body.path}`;
    if (this.writes.has(key)) throw failure('Une écriture est déjà en cours sur ce fichier.', 409);
    this.writes.add(key);
    try {
      let { container } = await this.target(hostId, id, body.expectedName);
      const parent = path.posix.dirname(body.path);
      await inspectPath(container, parent, { directory: true });
      await requireAbsent(container, body.path);
      // Recheck immediately before Docker extraction. Docker does not provide an
      // atomic create-exclusive option; the target application can still race us.
      ({ container } = await this.target(hostId, id, body.expectedName));
      await inspectPath(container, parent, { directory: true });
      await requireAbsent(container, body.path);
      const pack = tar.pack(),
        controller = new AbortController();
      pack.on('error', () => {});
      pack.entry(
        {
          name: path.posix.basename(body.path),
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: content.length,
        },
        content,
      );
      pack.finalize();
      try {
        await withDeadline(
          container.putArchive(pack, {
            path: parent,
            noOverwriteDirNonDir: true,
            abortSignal: controller.signal,
          }),
          30000,
        );
      } catch (error) {
        throw failure(
          `Import non confirmé. Vérifie le dossier avant de réessayer. ${error.message}`,
          error.statusCode || 502,
        );
      } finally {
        controller.abort();
        pack.destroy();
      }
      await verifyUploadedFile(container, body.path, content);
      this.emit({
        type: 'container-file',
        hostId,
        containerId: id,
        action: 'uploaded',
        path: body.path,
      });
      return { path: body.path, bytes: content.length, hash: hash(content) };
    } finally {
      this.writes.delete(key);
    }
  }
  shutdown() {
    clearInterval(this.timer);
    for (const session of this.sessions.values())
      this.close(session.hostId, session.containerId, session.id);
  }
}

export function mountContainerWorkbench(app, { hosts, labBusy = () => false, emit, ...options }) {
  const service = new ContainerWorkbenchService(hosts, { emit, ...options });
  const base = '/api/hosts/:hostId/containers/:id/workbench';
  const route =
    (fn, mutation = false) =>
    async (req, res) => {
      try {
        if (mutation && labBusy(req.params.hostId))
          throw failure('Une modification est en cours sur cet hôte. Réessaie après sa fin.', 409);
        const result = await fn(req);
        res.json(result);
      } catch (error) {
        res.status(error instanceof z.ZodError ? 400 : error.statusCode || 400).json({
          error:
            error instanceof z.ZodError
              ? error.issues.map((issue) => issue.message).join(' ')
              : error.message,
        });
      }
    };
  app.post(
    base + '/terminal',
    route((r) => service.open(r.params.hostId, r.params.id, r.body), true),
  );
  app.get(
    base + '/terminal/shells',
    route((r) => service.shells(r.params.hostId, r.params.id, r.query.expectedName)),
  );
  app.get(
    base + '/terminal/:sessionId',
    route((r) =>
      service.readSession(r.params.hostId, r.params.id, r.params.sessionId, r.query.cursor ?? 0),
    ),
  );
  app.post(
    base + '/terminal/:sessionId/input',
    route((r) => service.input(r.params.hostId, r.params.id, r.params.sessionId, r.body), true),
  );
  app.post(
    base + '/terminal/:sessionId/resize',
    route((r) => service.resize(r.params.hostId, r.params.id, r.params.sessionId, r.body), true),
  );
  app.delete(
    base + '/terminal/:sessionId',
    route((r) => service.close(r.params.hostId, r.params.id, r.params.sessionId)),
  );
  app.get(
    base + '/files',
    route((r) => service.files(r.params.hostId, r.params.id, r.query.path || '/')),
  );
  app.get(
    base + '/file',
    route((r) => service.readFile(r.params.hostId, r.params.id, r.query.path)),
  );
  app.put(
    base + '/file',
    route((r) => service.writeFile(r.params.hostId, r.params.id, r.body), true),
  );
  let uploads = 0;
  const parseUpload = express.raw({
    type: 'application/octet-stream',
    limit: UPLOAD_LIMIT,
    inflate: false,
  });
  app.post(base + '/upload', (req, res) => {
    if (labBusy(req.params.hostId))
      return res
        .status(409)
        .json({ error: 'Une modification est en cours sur cet hôte. Réessaie après sa fin.' });
    if (!req.is('application/octet-stream'))
      return res.status(415).json({ error: 'Choisis un fichier à importer.' });
    if (uploads >= 2)
      return res
        .status(429)
        .json({ error: 'Deux imports sont déjà en cours. Réessaie après leur fin.' });
    uploads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        uploads--;
      }
    };
    res.once('close', release);
    parseUpload(req, res, async (error) => {
      try {
        if (error)
          return res.status(error.status || 400).json({
            error:
              error.status === 413
                ? 'Le fichier dépasse la limite de 20 Mio.'
                : 'Le fichier n’a pas pu être reçu.',
          });
        await route(
          (r) =>
            service.uploadFile(r.params.hostId, r.params.id, r.query, r.body || Buffer.alloc(0)),
          true,
        )(req, res);
      } finally {
        release();
      }
    });
  });
  return service;
}
