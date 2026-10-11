#!/usr/bin/env bash
# Builds the rootfs (ext4) of a guest environment from an admin's Dockerfile. vmd runs it for each
# environment the admin adds; it needs Docker and the runner bundle (guest/dist, `npm run build`).
#   deploy/build-custom-image.sh <Dockerfile> <output file> [size]
# The launchpad's own layers are added on top of the Dockerfile's last stage: the runner, its
# init and the unprivileged `agent` user. The image must provide what they need (Node 22, tini,
# iproute2) and the agent CLIs: start it `FROM launchpad-guest:latest` to get all of them.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DOCKERFILE=$1
OUT=$2
SIZE=${3:-6G}

if [ ! -f "$ROOT/guest/dist/runner.js" ]; then
  echo "Missing $ROOT/guest/dist/runner.js: run npm run build first" >&2
  exit 1
fi
ctx=$(mktemp -d)
iid=""
cleanup() {
  rm -rf "$ctx"
  if [ -n "$iid" ]; then docker image rm "$iid" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

mkdir -p "$ctx/guest"
cp -r "$ROOT/guest/dist" "$ctx/guest/dist"
cp "$ROOT/deploy/guest-image/launchpad-init" "$ctx/launchpad-init"
{
  cat "$DOCKERFILE"
  cat <<'LAYERS'

# Added by the launchpad: the runner, its init and the unprivileged agent user.
USER root
COPY guest/dist/ /opt/launchpad/
COPY launchpad-init /sbin/launchpad-init
RUN chmod 0755 /sbin/launchpad-init && chmod -R a+rX /opt/launchpad \
 && (id -u agent >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash agent)
LAYERS
} >"$ctx/Dockerfile"

echo "Building the environment's image"
docker build --iidfile "$ctx/iid" -f "$ctx/Dockerfile" "$ctx"
iid=$(cat "$ctx/iid")
echo "Writing its root filesystem"
"$ROOT/deploy/rootfs-from-image.sh" "$iid" "$OUT" "$SIZE"
echo "Guest environment written to $OUT"
