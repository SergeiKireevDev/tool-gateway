#!/usr/bin/env bash
# One-time (and at-boot) host setup for agent microVMs. Run as root.
#  - installs Firecracker + jailer and the guest kernel
#  - creates the unprivileged jail user
#  - creates the VM bridge and locks it down: VMs may only reach the gateway's VM listener
set -euo pipefail

BRIDGE=${VMD_BRIDGE:-lpbr0}
ADDRESS=${VMD_BRIDGE_ADDRESS:-172.30.0.1}
PREFIX=${VMD_PREFIX_LENGTH:-24}
GATEWAY_PORT=${GATEWAY_PORT:-7420}
JAIL_ID=${VMD_JAIL_UID:-900}
STATE_DIR=${VMD_STATE_DIR:-/var/lib/launchpad}
FC_VERSION=${FIRECRACKER_VERSION:-v1.15.0}
KERNEL_URL=${GUEST_KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/vmlinux-6.1.155}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -e /dev/kvm ] || { echo "/dev/kvm missing: KVM is required" >&2; exit 1; }

install -d -m 0755 "$STATE_DIR" "$STATE_DIR/logs"

if ! /usr/local/bin/firecracker --version 2>/dev/null | grep -q "${FC_VERSION#v}"; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-x86_64.tgz" | tar -xz -C "$tmp"
  install -m 0755 "$tmp/release-${FC_VERSION}-x86_64/firecracker-${FC_VERSION}-x86_64" /usr/local/bin/firecracker
  install -m 0755 "$tmp/release-${FC_VERSION}-x86_64/jailer-${FC_VERSION}-x86_64" /usr/local/bin/jailer
  rm -rf "$tmp"
fi

if [ ! -s "$STATE_DIR/vmlinux" ]; then
  curl -fsSL "$KERNEL_URL" -o "$STATE_DIR/vmlinux.tmp" && mv "$STATE_DIR/vmlinux.tmp" "$STATE_DIR/vmlinux"
fi

getent group launchpad-jail >/dev/null || groupadd --system -g "$JAIL_ID" launchpad-jail
id launchpad-jail >/dev/null 2>&1 || useradd --system -u "$JAIL_ID" -g "$JAIL_ID" -M -s /usr/sbin/nologin launchpad-jail
usermod -aG kvm launchpad-jail

ip link show "$BRIDGE" >/dev/null 2>&1 || ip link add "$BRIDGE" type bridge
ip addr replace "$ADDRESS/$PREFIX" dev "$BRIDGE"
ip link set "$BRIDGE" up

# VMs reach the gateway's VM listener and nothing else: not the internet (no forwarding off the
# bridge), not other host ports, not each other (taps are isolated bridge ports, see vmd).
nft -f - <<NFT
table inet launchpad
delete table inet launchpad
table inet launchpad {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "$BRIDGE" ct state established,related accept
    iifname "$BRIDGE" ip daddr $ADDRESS tcp dport $GATEWAY_PORT accept
    iifname "$BRIDGE" drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "$BRIDGE" drop
    oifname "$BRIDGE" drop
  }
}
NFT

echo "VM host ready: bridge $BRIDGE ($ADDRESS/$PREFIX), firecracker $FC_VERSION, kernel $STATE_DIR/vmlinux"
echo "Next: build the guest image (deploy/build-guest-image.sh) into $STATE_DIR/rootfs.ext4"
