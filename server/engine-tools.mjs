import { PassThrough } from 'node:stream';
import { disableIdleTimeout } from './streams.mjs';
import { isIP } from 'node:net';
import tar from 'tar-stream';

export const TOOL_IMAGE = 'nicolaka/netshoot:v0.14';
export async function ensureToolImage(docker) {
  try {
    await docker.getImage(TOOL_IMAGE).inspect();
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    const stream = await docker.pull(TOOL_IMAGE);
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())),
    );
  }
}
export async function execTool(docker, container, cmd, timeout = 12000) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  disableIdleTimeout(stream);
  const out = new PassThrough(),
    err = new PassThrough();
  let stdout = '',
    stderr = '';
  out.on('data', (b) => {
    stdout = (stdout + b.toString()).slice(-24000);
  });
  err.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(-12000);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(Error('Délai de la sonde dépassé.'));
    }, timeout);
    const finish = (e) => {
      clearTimeout(timer);
      e ? reject(e) : resolve();
    };
    stream.once('end', () => finish());
    stream.once('error', finish);
    stream.once('close', () => finish());
    docker.modem.demuxStream(stream, out, err);
  });
  const result = await exec.inspect();
  if (result.Running || result.ExitCode == null)
    throw Error('Sonde interrompue avant son résultat.');
  return { exitCode: result.ExitCode, stdout, stderr, output: stdout + stderr };
}
export async function archiveFile(container, file, maxBytes = 65536) {
  const stream = await container.getArchive({ path: file }),
    extract = tar.extract();
  const chunks = [];
  let size = 0,
    found = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(Error('Lecture du fichier de sonde trop lente.')), 15000);
    const fail = (e) => {
      clearTimeout(timer);
      stream.destroy();
      extract.destroy();
      reject(e);
    };
    stream.once('error', fail);
    extract.once('error', fail);
    extract.on('entry', (header, entry, next) => {
      if (header.type !== 'file' || header.name.split('/').at(-1) !== file.split('/').at(-1)) {
        entry.resume();
        entry.on('end', next);
        return;
      }
      found = true;
      entry.on('data', (b) => {
        size += b.length;
        if (size > maxBytes) fail(Error('Fichier de capture trop volumineux.'));
        else chunks.push(b);
      });
      entry.on('end', next);
      entry.on('error', fail);
    });
    extract.on('finish', () => {
      clearTimeout(timer);
      found
        ? resolve(Buffer.concat(chunks))
        : reject(Error('Fichier non disponible dans le conteneur.'));
    });
    stream.pipe(extract);
  });
}
export function resolverContext(resolv = '', hosts = '') {
  const lines = resolv.split('\n').map((l) => l.split('#')[0].trim());
  return {
    servers: lines
      .filter((l) => /^nameserver\s/.test(l))
      .map((l) => l.split(/\s+/)[1])
      .filter((v) => isIP(v))
      .slice(0, 3),
    search: lines
      .filter((l) => /^(search|domain)\s/.test(l))
      .flatMap((l) => l.split(/\s+/).slice(1))
      .filter((v) => /^[a-zA-Z0-9_.-]+$/.test(v))
      .slice(0, 3),
    hosts: hosts
      .split('\n')
      .map((l) => l.split('#')[0].trim().split(/\s+/))
      .filter((p) => isIP(p[0]))
      .map((p) => ({ ip: p[0], names: p.slice(1) })),
  };
}
export const observerLabels = (role, sessionId, hostId, instanceId) => ({
  'io.dockertracer.workspace': '1',
  'io.dockertracer.role': role,
  'io.dockertracer.session': sessionId,
  'io.dockertracer.host': hostId,
  ...(instanceId ? { 'io.dockertracer.instance': instanceId } : {}),
});
export async function removeHelper(container) {
  try {
    await container.remove({ force: true });
    return null;
  } catch (e) {
    return e.statusCode === 404 ? null : e.message;
  }
}
