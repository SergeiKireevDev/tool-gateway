#!/usr/bin/env bash
# Builds the agent VM rootfs (ext4) from deploy/guest-image/Dockerfile. Needs Docker; no root.
#   deploy/build-guest-image.sh [output file] [size]
# The image is also tagged launchpad-guest:latest: guest environments added by the admin usually
# start FROM it (see deploy/build-custom-image.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-rootfs.ext4}
SIZE=${2:-6G}

npm run build:guest
docker build -f deploy/guest-image/Dockerfile -t launchpad-guest:latest .
deploy/rootfs-from-image.sh launchpad-guest:latest "$OUT" "$SIZE"
echo "Guest image written to $OUT; install it as /var/lib/launchpad/rootfs.ext4"
