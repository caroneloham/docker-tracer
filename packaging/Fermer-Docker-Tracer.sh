#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
pid_file="$root/data/server.pid"
if [ ! -f "$pid_file" ]; then
  echo 'Aucun serveur Docker Tracer lance par ce paquet.'
  exit 0
fi

pid=$(cat -- "$pid_file")
case "$pid" in
  ''|*[!0-9]*) echo 'Fichier PID invalide.' >&2; exit 1 ;;
esac

if [ -d "/proc/$pid" ]; then
  actual_exe=$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)
  actual_cwd=$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)
  command_line=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if [ "$actual_exe" = "$root/runtime/node" ] && [ "$actual_cwd" = "$root" ]; then
    case "$command_line" in
      *server/index.mjs*--production*) kill "$pid"; echo 'Docker Tracer est ferme.' ;;
      *) echo 'Le processus indique ne correspond plus a Docker Tracer.' >&2; exit 1 ;;
    esac
  else
    echo 'Le serveur initial est deja arrete ou son PID a ete reutilise.'
  fi
else
  echo 'Le serveur initial est deja arrete.'
fi
rm -- "$pid_file"
rm -f -- "$root/data/server.reopen"
