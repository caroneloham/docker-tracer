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

if "$node" -e "const c=require('node:net').connect(4310,'127.0.0.1'); c.on('connect',()=>process.exit(0)); c.on('error',()=>process.exit(1));"; then
  echo 'Le port local 4310 est deja occupe. Fermez le serveur existant.' >&2
  exit 1
fi

umask 077
mkdir -p -- "$data"
token=$("$node" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
(
  cd -- "$root"
  exec env DTR_LOCAL_BOOTSTRAP_TOKEN="$token" "$node" server/index.mjs --production >> "$data/server.log" 2>> "$data/server-error.log"
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
  echo "Docker Tracer ne demarre pas. Consultez $data/server-error.log" >&2
  exit 1
fi

printf '%s\n' "$server_pid" > "$data/server.pid"
access_url="$url/?access=$token"
opened=0
if [ "${DTR_NO_OPEN_BROWSER:-}" != 1 ] && command -v xdg-open >/dev/null 2>&1; then
  if xdg-open "$access_url" >/dev/null 2>&1; then opened=1; fi
fi
if [ "$opened" -eq 1 ]; then
  printf 'Docker Tracer : %s\n' "$url"
else
  printf 'Ouvrez Docker Tracer : %s\n' "$access_url"
fi
printf 'Pour arreter le serveur : ./Fermer-Docker-Tracer.sh\n'
printf 'Projets et journaux locaux : %s\n' "$data"
