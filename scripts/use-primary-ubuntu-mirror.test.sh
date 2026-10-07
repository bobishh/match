#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
apt_root="$(mktemp -d)"
trap 'rm -rf "$apt_root"' EXIT
mkdir -p "$apt_root/sources.list.d"

cat >"$apt_root/sources.list" <<'EOF'
deb http://azure.archive.ubuntu.com/ubuntu/ noble main
deb https://security.ubuntu.com/ubuntu noble-security main
EOF

cat >"$apt_root/sources.list.d/direct.sources" <<'EOF'
Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble
Components: main
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

cat >"$apt_root/sources.list.d/mirror.sources" <<EOF
Types: deb
URIs: mirror+file:$apt_root/apt-mirrors.txt
Suites: noble
Components: main
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

cat >"$apt_root/apt-mirrors.txt" <<'EOF'
http://azure.archive.ubuntu.com/ubuntu/ priority:1
https://archive.ubuntu.com/ubuntu/ priority:2
https://security.ubuntu.com/ubuntu/ priority:3
EOF

APT_ROOT="$apt_root" bash "$repo_root/scripts/use-primary-ubuntu-mirror.sh"

grep -Fxq 'deb http://archive.ubuntu.com/ubuntu/ noble main' "$apt_root/sources.list"
grep -Fxq 'URIs: http://archive.ubuntu.com/ubuntu/' "$apt_root/sources.list.d/direct.sources"
grep -Fxq 'URIs: mirror+file:'"$apt_root"'/apt-mirrors.txt' "$apt_root/sources.list.d/mirror.sources"
grep -Fxq 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' "$apt_root/sources.list.d/direct.sources"
grep -Fxq 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' "$apt_root/sources.list.d/mirror.sources"
grep -Fxq 'http://archive.ubuntu.com/ubuntu/ priority:1' "$apt_root/apt-mirrors.txt"
grep -Fxq 'https://archive.ubuntu.com/ubuntu/ priority:2' "$apt_root/apt-mirrors.txt"
grep -Fxq 'https://security.ubuntu.com/ubuntu/ priority:3' "$apt_root/apt-mirrors.txt"
! grep -R -Fq 'azure.archive.ubuntu.com' "$apt_root"
printf 'APT mirror fixtures passed (.list, direct .sources, mirror+file and mirrorlist)\n'
