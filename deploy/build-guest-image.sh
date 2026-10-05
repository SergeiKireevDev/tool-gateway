#!/usr/bin/env bash
# Builds the agent VM rootfs (ext4) from deploy/guest-image/Dockerfile. Needs Docker; no root.
#   deploy/build-guest-image.sh [output file] [size]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-rootfs.ext4}
SIZE=${2:-6G}

npm run build:guest
docker build -f deploy/guest-image/Dockerfile -t launchpad-guest:latest .
container=$(docker create launchpad-guest:latest)
trap 'docker rm -f "$container" >/dev/null' EXIT
outdir=$(cd "$(dirname "$OUT")" && pwd)
# Unpack and format as root inside a throwaway container so file ownership is preserved.
docker export "$container" | docker run --rm -i -v "$outdir:/out" debian:bookworm-slim sh -c "
  set -e
  apt-get update -qq && apt-get install -y -qq e2fsprogs >/dev/null
  mkdir /rootfs && tar -x -C /rootfs
  rm -f /rootfs/.dockerenv
  mkfs.ext4 -q -L rootfs -d /rootfs -F /out/$(basename "$OUT").tmp $SIZE
  mv /out/$(basename "$OUT").tmp /out/$(basename "$OUT")
  chown $(id -u):$(id -g) /out/$(basename "$OUT")
"
echo "Guest image written to $OUT; install it as /var/lib/launchpad/rootfs.ext4"
