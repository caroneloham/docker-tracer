import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import tar from 'tar-stream';
import { disableIdleTimeout } from './streams.mjs';

export async function saveArchive(
  source,
  file,
  limit,
  { timeout = 30 * 60 * 1000, progress = () => {} } = {},
) {
  let bytes = 0,
    last = 0;
  const hash = createHash('sha256'),
    controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Error('Délai de transfert de la sauvegarde dépassé.')),
    timeout,
  );
  disableIdleTimeout(source);
  const meter = new Transform({
    transform(chunk, _encoding, cb) {
      bytes += chunk.length;
      if (bytes > limit)
        return cb(Error('La sauvegarde dépasse la place disponible ou la limite configurée.'));
      hash.update(chunk);
      if (Date.now() - last > 1000) {
        progress(bytes);
        last = Date.now();
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
      signal: controller.signal,
    });
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    clearTimeout(timer);
  }
}

// Validate the complete archive before Docker receives any restore data. Never extract on the PC.
export async function verifyArchive(file, expected, { maxEntries = 250000 } = {}) {
  const hash = createHash('sha256'),
    entries = new Map();
  let bytes = 0;
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    try {
      if (
        header.name.includes('\\') ||
        header.name.includes('\0') ||
        header.name.startsWith('/') ||
        header.name.split('/').includes('..')
      )
        throw Error('Chemin non sûr dans la sauvegarde.');
      const name = path.posix.normalize(header.name).replace(/\/$/, '');
      if (!['file', 'directory', 'symlink', 'link'].includes(header.type))
        throw Error('La sauvegarde contient un fichier spécial non pris en charge.');
      if (name === '.' && header.type !== 'directory') throw Error('Racine d’archive invalide.');
      if (entries.has(name) || entries.size >= maxEntries)
        throw Error('Archive ambiguë ou trop de fichiers.');
      entries.set(name, { type: header.type, link: header.linkname });
      stream.on('error', (e) => extract.destroy(e));
      stream.on('end', next);
      stream.resume();
    } catch (e) {
      stream.resume();
      extract.destroy(e);
    }
  });
  const meter = new Transform({
    transform(chunk, _encoding, cb) {
      bytes += chunk.length;
      if (bytes > expected.bytes) return cb(Error('Taille de sauvegarde incohérente.'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(file), meter, extract);
  } catch (e) {
    throw Error('Archive illisible ou non sûre : ' + e.message, { cause: e });
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw Error('L’empreinte de la sauvegarde ne correspond plus. Restauration refusée.');
  for (const [name, entry] of entries) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (entries.has(parent) && entries.get(parent).type !== 'directory')
        throw Error('Un fichier passe par un lien dans la sauvegarde.');
      parent = path.posix.dirname(parent);
    }
    if (entry.type === 'link') {
      const link = entry.link || '';
      if (
        link.startsWith('/') ||
        link.includes('\\') ||
        link.split('/').includes('..') ||
        entries.get(path.posix.normalize(link))?.type !== 'file'
      )
        throw Error('Lien physique non sûr dans la sauvegarde.');
    }
  }
  return { entries: entries.size };
}
