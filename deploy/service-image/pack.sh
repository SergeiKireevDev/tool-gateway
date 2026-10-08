#!/bin/sh
# Runs inside a throwaway Debian container (see build-service-image.sh): turns the exported
# image on stdin into /out/<name>.ext4, with the service init, its command and /out/<name>.json.
#   pack.sh <name> <size> <owner uid> <owner gid>
set -eu
NAME=$1
SIZE=$2
apt-get update -qq && apt-get install -y -qq e2fsprogs jq >/dev/null
mkdir /rootfs && tar -x -C /rootfs
rm -f /rootfs/.dockerenv

install -D -m 0755 /work/service-box-init /rootfs/sbin/service-box-init
install -d /rootfs/etc/service-box
jq -r '.[0].Config as $c
  | (($c.Entrypoint // []) + ($c.Cmd // [])) as $cmd
  | if ($cmd | length) == 0 then error("the Dockerfile sets no CMD or ENTRYPOINT") else . end
  | (($c.Env // [])[] | "export \(. | @sh)"),
    "cd \(($c.WorkingDir // "") | if . == "" then "/" else . end | @sh)",
    "SERVICE_USER=\(($c.User // "") | @sh)",
    "set -- \($cmd | @sh)"' /work/inspect.json >/rootfs/etc/service-box/command
printf '127.0.0.1\tlocalhost %s\n' "$NAME" >/rootfs/etc/hosts
echo "$NAME" >/rootfs/etc/hostname

# The manifest vmd lists: the TCP ports the Dockerfile EXPOSEs.
jq '{ports: [(.[0].Config.ExposedPorts // {}) | keys[] | select(endswith("/tcp"))
  | split("/")[0] | tonumber]}' /work/inspect.json >"/out/$NAME.json.tmp"
mkfs.ext4 -q -L "$NAME" -d /rootfs -F "/out/$NAME.ext4.tmp" "$SIZE"
mv "/out/$NAME.ext4.tmp" "/out/$NAME.ext4"
mv "/out/$NAME.json.tmp" "/out/$NAME.json"
chown "$3:$4" "/out/$NAME.ext4" "/out/$NAME.json"
