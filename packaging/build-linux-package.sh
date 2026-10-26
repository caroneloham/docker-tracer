#!/usr/bin/env bash
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
source_dir=$(CDPATH= cd -- "$here/.." && pwd -P)
outputs="$source_dir/release"
version=0.12.1
node_version=24.14.0
node_name="node-v${node_version}-linux-x64.tar.xz"
node_sha256=41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df
name="Docker-Tracer-${version}-Linux-x64"
stage_root=$(mktemp -d "$here/stage-linux.XXXXXXXX")
package="$stage_root/$name"
node_archive="$stage_root/$node_name"
node_full="$stage_root/node-full"
if [ ! -f "$source_dir/dist/index.html" ]; then
  echo 'Interface locale absente. Executez npm ci puis npm run build a la racine du depot.' >&2
  exit 1
fi
mkdir -p "$package/notices/brands" "$package/runtime" "$node_full"
mkdir -p "$outputs"

cp -a "$source_dir/server" "$source_dir/shared" "$source_dir/dist" "$package/"
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/VERIFICATION.md" "$package/"
cp "$source_dir/LICENSE" "$package/"
cp "$source_dir/src/assets/brands/sources.json" "$source_dir"/src/assets/brands/LICENSE-*.txt "$package/notices/brands/"
cp "$here/Lancer-Docker-Tracer.sh" "$here/Fermer-Docker-Tracer.sh" "$package/"
cp "$here/README-Linux.md" "$package/README.md"
sed 's/runtime Windows x64/runtime Linux x64/' "$here/THIRD_PARTY_NOTICES.txt" > "$package/THIRD_PARTY_NOTICES.txt"

curl --fail --location --retry 3 --silent --show-error \
  "https://nodejs.org/dist/v${node_version}/${node_name}" -o "$node_archive"
printf '%s  %s\n' "$node_sha256" "$node_archive" | sha256sum --check --status
tar -xJf "$node_archive" --strip-components=1 -C "$node_full"
cp "$node_full/bin/node" "$package/runtime/node"
cp "$node_full/LICENSE" "$package/runtime/NODE-LICENSE.txt"

(
  cd "$package"
  PATH="$node_full/bin:$PATH" "$node_full/bin/node" \
    "$node_full/lib/node_modules/npm/bin/npm-cli.js" ci \
    --omit=dev --ignore-scripts --no-audit --no-fund
)

# Les fixtures de test de ssh2 contiennent des clés de démonstration inutiles.
fixtures="$package/node_modules/ssh2/test"
if [ -d "$fixtures" ]; then
  resolved_fixtures=$(realpath -e -- "$fixtures")
  case "$resolved_fixtures" in
    "$package"/*) rm -rf -- "$resolved_fixtures" ;;
    *) echo "Chemin fixtures hors paquet : $resolved_fixtures" >&2; exit 1 ;;
  esac
fi

staged_archive="$stage_root/$name.tar.gz"
python3 - "$package" "$staged_archive" <<'PY'
import pathlib
import sys
import tarfile

package = pathlib.Path(sys.argv[1])
archive = pathlib.Path(sys.argv[2])

def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = 'root'
    info.gname = 'root'
    if info.isdir():
        info.mode = 0o755
    elif info.issym():
        info.mode = 0o777
    elif info.name.endswith(('.sh', '/runtime/node')):
        info.mode = 0o755
    else:
        info.mode = 0o644
    return info

with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as output:
    output.add(package, arcname=package.name, filter=normalize)
PY

final_archive="$outputs/$name.tar.gz"
mv -f -- "$staged_archive" "$final_archive"
hash=$(sha256sum "$final_archive" | cut -d' ' -f1)
printf '%s  %s\n' "$hash" "$name.tar.gz" > "$outputs/$name.sha256"
printf 'Archive: %s\nSHA256: %s\nTaille: %s octets\nStage: %s\n' \
  "$final_archive" "$hash" "$(stat -c %s "$final_archive")" "$package"
