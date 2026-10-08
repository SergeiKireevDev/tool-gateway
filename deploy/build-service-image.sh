#!/usr/bin/env bash
# Builds a service box rootfs (ext4) and its manifest from deploy/services/<name>/Dockerfile.
# Needs Docker; no root.
#   deploy/build-service-image.sh <name> [output dir] [size]
# Install both files in vmd's service directory (/var/lib/launchpad/services by default).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${1:?usage: deploy/build-service-image.sh <name> [output dir] [size]}
OUTDIR=${2:-.}
SIZE=${3:-2G}
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "invalid service name: $NAME" >&2; exit 1; }
CONTEXT=deploy/services/$NAME
[ -f "$CONTEXT/Dockerfile" ] || { echo "missing $CONTEXT/Dockerfile" >&2; exit 1; }

TAG=launchpad-service-$NAME:latest
docker build -t "$TAG" "$CONTEXT"
mkdir -p "$OUTDIR"
outdir=$(cd "$OUTDIR" && pwd)
work=$(mktemp -d)
container=$(docker create "$TAG")
trap 'docker rm -f "$container" >/dev/null; rm -rf "$work"' EXIT
docker inspect "$TAG" >"$work/inspect.json"
cp deploy/service-image/service-box-init deploy/service-image/pack.sh "$work/"
# Unpack and format as root inside a throwaway container so file ownership is preserved.
docker export "$container" | docker run --rm -i -v "$outdir:/out" -v "$work:/work:ro" \
  debian:bookworm-slim sh /work/pack.sh "$NAME" "$SIZE" "$(id -u)" "$(id -g)"
echo "Service image written to $outdir/$NAME.ext4 (+ $NAME.json);" \
  "install both in /var/lib/launchpad/services"
