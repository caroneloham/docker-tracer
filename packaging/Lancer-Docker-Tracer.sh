#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node="$root/runtime/node"
data="$root/data"
url='http://127.0.0.1:4310'

if [ ! -x "$node" ]; then
  echo 'Runtime Node.js absent. Extrayez toute l archive tar.gz.' >&2
  exit 1
fi
open_browser() {
  access_url="$url/?access=$1"
  opened=0
  if [ "${DTR_NO_OPEN_BROWSER:-}" != 1 ] && command -v xdg-open >/dev/null 2>&1; then
    if xdg-open "$access_url" >/dev/null 2>&1; then opened=1; fi
  fi
  if [ "$opened" -eq 1 ]; then
    printf 'Docker Tracer : %s\n' "$url"
  else
    printf 'Ouvrez Docker Tracer : %s\n' "$access_url"
  fi
}

if "$node" -e "const c=require('node:net').connect(4310,'127.0.0.1'); c.on('connect',()=>process.exit(0)); c.on('error',()=>process.exit(1));"; then
  pid_file="$data/server.pid"
  reopen_file="$data/server.reopen"
  if [ ! -f "$pid_file" ] || [ ! -f "$reopen_file" ] || [ -L "$reopen_file" ]; then
    echo 'Le port local 4310 est deja occupe par un serveur non identifie.' >&2
    exit 1
  fi
  pid=$(cat -- "$pid_file")
  case "$pid" in ''|*[!0-9]*) echo 'Fichier PID invalide.' >&2; exit 1 ;; esac
  actual_exe=$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)
  actual_cwd=$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)
  command_line=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if [ "$actual_exe" != "$node" ] || [ "$actual_cwd" != "$root" ]; then
    echo 'Le port local 4310 est deja occupe par un autre processus.' >&2
    exit 1
  fi
  case "$command_line" in
    *server/index.mjs*--production*) ;;
    *) echo 'Le processus indique ne correspond plus a Docker Tracer.' >&2; exit 1 ;;
  esac
  token=$("$node" -e "const s=require('node:fs').readFileSync(0,'utf8').trim(); fetch('$url/_dtr/launcher/reopen',{method:'POST',headers:{'X-Docker-Tracer-Launcher':s}}).then(async r=>{if(!r.ok)process.exit(1);const b=(await r.json()).bootstrapToken;if(!/^[a-f0-9]{64}$/.test(b))process.exit(1);process.stdout.write(b)}).catch(()=>process.exit(1))" < "$reopen_file") || {
    echo 'Impossible de rouvrir la session locale de Docker Tracer.' >&2
    exit 1
  }
  open_browser "$token"
  exit 0
fi

umask 077
mkdir -p -- "$data"
token=$("$node" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
reopen_token=$("$node" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
reopen_temp=$(mktemp "$data/.server-reopen.XXXXXXXX")
printf '%s' "$reopen_token" > "$reopen_temp"
mv -f -- "$reopen_temp" "$data/server.reopen"
(
  cd -- "$root"
  DTR_LOCAL_BOOTSTRAP_TOKEN=$token
  DTR_LOCAL_REOPEN_TOKEN=$reopen_token
  PORT=4310
  export DTR_LOCAL_BOOTSTRAP_TOKEN DTR_LOCAL_REOPEN_TOKEN PORT
  exec "$node" server/index.mjs --production >> "$data/server.log" 2>> "$data/server-error.log"
) &
server_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 40 ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  if "$node" -e "fetch('$url').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f -- "$data/server.reopen"
  echo "Docker Tracer ne demarre pas. Consultez $data/server-error.log" >&2
  exit 1
fi

printf '%s\n' "$server_pid" > "$data/server.pid"
open_browser "$token"
printf 'Pour arreter le serveur : ./Fermer-Docker-Tracer.sh\n'
printf 'Projets et journaux locaux : %s\n' "$data"
