import ssh2 from 'ssh2';
import { randomUUID } from 'node:crypto';

export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

// Source and explicit variables travel over SSH stdin, never in a process argument.
// Compose runs beside the remote engine: relative binds/configs/builds refer to that server.
export function remoteComposeScript(settings, args, timeout) {
  if (settings.directory && !settings.directory.startsWith('/'))
    throw Error('Le dossier Compose SSH doit être un chemin Linux absolu sur le serveur.');
  const delimiter = 'DTR_' + randomUUID().replaceAll('-', '');
  return `set -eu
umask 077
command -v docker >/dev/null || { echo 'Docker CLI absent sur le serveur SSH.' >&2; exit 1; }
command -v timeout >/dev/null || { echo 'La commande timeout est requise sur le serveur SSH.' >&2; exit 1; }
job=$(mktemp -d /tmp/docker-tracer-compose.XXXXXXXXXX)
cleanup() { case "$job" in /tmp/docker-tracer-compose.*) rm -rf -- "$job";; esac; }
trap cleanup EXIT HUP INT TERM
cat > "$job/compose.yaml" <<'${delimiter}'
${settings.source.trimEnd()}
${delimiter}
: > "$job/empty.env"
directory=${settings.directory ? shellQuote(settings.directory) : '"$job"'}
[ -d "$directory" ] || { echo 'Dossier Compose introuvable sur le serveur SSH.' >&2; exit 1; }
cd "$directory"
endpoint=${'${'}DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*) ;; *) echo 'Compose SSH requiert un socket Docker local au serveur.' >&2; exit 1;; esac
env -i PATH="$PATH" HOME="$HOME" COMPOSE_MENU=false COMPOSE_ANSI=never COMPOSE_PROGRESS=plain ${Object.entries(
    settings.variables,
  )
    .map(([k, v]) => shellQuote(k + '=' + v))
    .join(' ')} \
timeout -k 5 ${Math.ceil(timeout / 1000)} docker --host "$endpoint" compose --ansi never --progress plain --parallel 4 \
--project-directory "$directory" --project-name ${shellQuote(settings.projectName)} \
--env-file ${settings.useDotEnv ? '"$directory/.env"' : '"$job/empty.env"'} --file "$job/compose.yaml" \
${[...settings.profiles.flatMap((p) => ['--profile', p]), ...args].map(shellQuote).join(' ')}
`;
}

export function runRemoteCompose(
  options,
  settings,
  args,
  active,
  { timeout = 900000, notify = () => {}, json = false } = {},
) {
  const script = remoteComposeScript(settings, args, timeout);
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let stdout = '',
      stderr = '',
      finished = false,
      timer;
    const job = { stop: () => finish(Error('Connexion Compose SSH interrompue.')), done: null };
    let closed;
    job.done = new Promise((r) => {
      closed = r;
    });
    active.add(job);
    function finish(error, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.destroy();
      active.delete(job);
      closed();
      if (error || code !== 0)
        reject(
          Object.assign(error || Error(stderr.trim() || `Compose SSH s’est arrêté (${code}).`), {
            output: (stdout + '\n' + stderr).slice(-64000),
            inconclusive: !!error || code === 124 || code === 137,
          }),
        );
      else resolve({ stdout, stderr, code });
    }
    // The remote timeout also bounds orphaned jobs if this application loses SSH.
    timer = setTimeout(
      () => finish(Error('Délai Compose SSH dépassé. Vérifie l’état réel du projet.')),
      timeout + 15000,
    );
    client.on('error', (e) => finish(e));
    client.on('close', () => finish(Error('Connexion SSH interrompue pendant Compose.')));
    client.on('ready', () =>
      client.exec('sh -s', (error, stream) => {
        if (error) return finish(error);
        stream.on('data', (b) => {
          stdout += b.toString();
          if (Buffer.byteLength(stdout) > 8 * 1024 * 1024)
            return finish(Error('Sortie Compose trop volumineuse.'));
          if (!json) notify(b.toString());
        });
        stream.stderr.on('data', (b) => {
          stderr = (stderr + b.toString()).slice(-64000);
          if (!json) notify(b.toString());
        });
        stream.on('error', (e) => finish(e));
        stream.on('close', (code) => finish(null, code));
        stream.end(script);
      }),
    );
    client.connect(options);
  });
}
