#!/usr/bin/env bash
# Turns a Docker image into an agent VM rootfs (ext4). Needs Docker; no root.
#   deploy/rootfs-from-image.sh <image> <output file> [size]
set -euo pipefail
IMAGE=$1
OUT=$2
SIZE=${3:-6G}

container=$(docker create "$IMAGE")
trap 'docker rm -f "$container" >/dev/null' EXIT
outdir=$(cd "$(dirname "$OUT")" && pwd)
name=$(basename "$OUT")
# Unpack and format as root inside a throwaway container so file ownership is preserved.
docker export "$container" | docker run --rm -i -v "$outdir:/out" debian:bookworm-slim sh -c "
  set -e
  apt-get update -qq && apt-get install -y -qq e2fsprogs >/dev/null
  mkdir /rootfs && tar -x -C /rootfs
  rm -f /rootfs/.dockerenv
  mkfs.ext4 -q -L rootfs -d /rootfs -F /out/$name.tmp $SIZE
  mv /out/$name.tmp /out/$name
  chown $(id -u):$(id -g) /out/$name
"
