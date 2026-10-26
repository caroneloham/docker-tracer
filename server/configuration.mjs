import tar from 'tar-stream';
import { configurationFiles, pathsOverlap, appFileSchema } from '../shared/configuration.mjs';
async function fileStat(container, path) {
  try {
    const response = await container.infoArchive({ path });
    const header = response.headers?.['x-docker-container-path-stat'];
    response.resume?.();
    if (!header) throw Error('Docker ne fournit pas les informations du chemin ' + path);
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}
export async function installConfiguration(container, topology, node) {
  const files = configurationFiles(topology, node).map((f) => appFileSchema.parse(f));
  if (!files.length) return;
  const info = await container.inspect();
  if (info.State.Running)
    throw Error('Les fichiers doivent être installés avant le démarrage du conteneur.');
  const mounts = info.Mounts || [],
    checked = new Map(),
    newDirs = new Set();
  for (const file of files) {
    if (mounts.some((m) => pathsOverlap(m.Destination, file.path)))
      throw Error(
        'Le fichier ' +
          file.path +
          ' recouvre un volume. Choisis un chemin hors des données persistantes.',
      );
    const parts = file.path.split('/').slice(1);
    for (let i = 1; i <= parts.length; i++) {
      const target = '/' + parts.slice(0, i).join('/');
      if (!checked.has(target)) checked.set(target, await fileStat(container, target));
      const stat = checked.get(target);
      if (stat && (stat.linkTarget || stat.mode & 0x8000000))
        throw Error(
          'Le chemin ' +
            target +
            ' est un lien symbolique. Utilise un chemin direct hors des volumes.',
        );
      if (stat && i === parts.length && stat.mode & 0x80000000)
        throw Error(target + ' est un dossier, pas un fichier.');
      if (stat && i < parts.length && !(stat.mode & 0x80000000))
        throw Error(target + ' est un fichier, pas un dossier.');
      if (!stat && i < parts.length) newDirs.add(target.slice(1));
    }
  }
  const pack = tar.pack(),
    chunks = [];
  const reading = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  const entry = (header, body) =>
    new Promise((resolve, reject) => pack.entry(header, body, (e) => (e ? reject(e) : resolve())));
  try {
    for (const name of [...newDirs].sort((a, b) => a.split('/').length - b.split('/').length))
      await entry({ name, type: 'directory', mode: 0o755, uid: 0, gid: 0 }, Buffer.alloc(0));
    for (const file of files)
      await entry(
        { name: file.path.slice(1), type: 'file', mode: 0o644, uid: 0, gid: 0 },
        Buffer.from(file.content, 'utf8'),
      );
    pack.finalize();
    await container.putArchive(await reading, { path: '/', noOverwriteDirNonDir: true });
  } catch (e) {
    pack.destroy();
    await reading.catch(() => {});
    throw e;
  }
}
