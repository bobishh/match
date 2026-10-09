#!/usr/bin/env bash
set -euo pipefail

apt_root="${APT_ROOT:-/etc/apt}"
source_dir="$apt_root/sources.list.d"
source_files=()
targets=()

for candidate in "$apt_root/sources.list" "$source_dir"/*.list "$source_dir"/*.sources; do
  [[ -f "$candidate" ]] || continue
  source_files+=("$candidate")
  targets+=("$candidate")
done

if ((${#source_files[@]} == 0)); then
  printf 'No APT source files found under %s\n' "$apt_root" >&2
  exit 1
fi

for source in "${source_files[@]}"; do
  while IFS= read -r mirror_uri; do
    mirror_path="${mirror_uri#mirror+file:}"
    [[ "$mirror_path" == /* && -f "$mirror_path" ]] || continue
    targets+=("$mirror_path")
  done < <(grep -Eo 'mirror\+file:[^[:space:]]+' "$source" || true)
done

seen=()
found_archive=false
for target in "${targets[@]}"; do
  duplicate=false
  for previous in "${seen[@]-}"; do
    [[ "$previous" == "$target" ]] && duplicate=true && break
  done
  [[ "$duplicate" == true ]] && continue
  seen+=("$target")
  if grep -Fq 'azure.archive.ubuntu.com' "$target"; then
    if [[ -w "$target" ]]; then
      perl -pi -e 's/azure\.archive\.ubuntu\.com/archive.ubuntu.com/g' "$target"
    else
      sudo perl -pi -e 's/azure\.archive\.ubuntu\.com/archive.ubuntu.com/g' "$target"
    fi
  fi
  if grep -Fq 'azure.archive.ubuntu.com' "$target"; then
    printf 'Azure Ubuntu mirror remains in %s\n' "$target" >&2
    exit 1
  fi
  grep -Fq 'archive.ubuntu.com' "$target" && found_archive=true
done

if [[ "$found_archive" != true ]]; then
  printf 'No official Ubuntu archive mirror found in APT sources or referenced mirrorlists\n' >&2
  exit 1
fi
