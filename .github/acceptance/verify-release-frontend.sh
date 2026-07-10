#!/usr/bin/env bash
set -euo pipefail

archive=${1:?usage: verify-release-frontend.sh file-archiver-X.Y.Z.zip}
checksum_file="${archive}.sha256"

test -s "$archive"
test -s "$checksum_file"

(
  cd "$(dirname "$archive")"
  sha256sum --check "$(basename "$checksum_file")"
)

while IFS= read -r entry; do
  case "$entry" in
    file-archiver/*) ;;
    *) echo "unexpected ZIP entry outside file-archiver/: $entry" >&2; exit 1 ;;
  esac
  case "$entry" in
    /*|*'../'*|*'\'*) echo "unsafe ZIP entry: $entry" >&2; exit 1 ;;
  esac
done < <(zipinfo -1 "$archive")

if zipinfo -l "$archive" | awk '$1 ~ /^l/ { found=1 } END { exit !found }'; then
  echo "symbolic links are not allowed in the frontend release ZIP" >&2
  exit 1
fi

extract_dir=$(mktemp -d)
trap 'rm -rf "$extract_dir"' EXIT
unzip -q "$archive" -d "$extract_dir"

manifest="$extract_dir/file-archiver/manifest.json"
test -s "$manifest"
entrypoint=$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1])); if(typeof m.entrypoint!=='string'||!m.entrypoint.endsWith('.mjs')) process.exit(1); process.stdout.write(m.entrypoint)" "$manifest")
test -s "$extract_dir/file-archiver/$entrypoint"
