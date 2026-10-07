#!/usr/bin/env bash
# Installs and starts the local gateway (and, on hosts with KVM, the agent launchpad) on a fresh
# Debian or Ubuntu system. Run as root:
#
#   sudo deploy/install.sh                       # from a checkout: installs that code
#   curl -fsSL …/deploy/install.sh | sudo bash   # elsewhere: clones the repository
#
# Re-running updates the code and keeps the data, configuration and master key.
#
# Options (each prompt also has a flag, for unattended installs):
#   --admin-email EMAIL         admin's Google account (required; prompted when missing)
#   --public-url URL            public base URL (default http://<host>:<port>)
#   --host ADDRESS              listen address (default 127.0.0.1: put a TLS proxy in front)
#   --port PORT                 listen port (default 7420)
#   --google-client-id ID       Google OAuth client for sign-in (optional; else admin token)
#   --google-client-secret S
#   --repo URL --branch NAME    where to clone the code from when not run from a checkout
#   --launchpad                 require the agent launchpad (fail if KVM can't be enabled)
#   --no-launchpad              skip the agent launchpad (KVM, Firecracker, guest image)
#   --yes                       don't ask anything: use flags and defaults
set -euo pipefail

INSTALL_DIR=/opt/local-gateway
CONFIG_DIR=/etc/local-gateway
ENV_FILE=$CONFIG_DIR/gateway.env
STATE_DIR=/var/lib/local-gateway
SERVICE_USER=local-gateway
LAUNCHPAD_STATE_DIR=/var/lib/launchpad
VM_HOST=172.30.0.1
NODE_MAJOR=22

ADMIN_EMAIL=""
PUBLIC_URL=""
HOST=127.0.0.1
PORT=7420
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
REPO_URL=https://github.com/SergeiKireevDev/tool-gateway.git
BRANCH=main
LAUNCHPAD=auto
ASSUME_YES=0

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-email) ADMIN_EMAIL=$2; shift 2 ;;
    --public-url) PUBLIC_URL=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --google-client-id) GOOGLE_CLIENT_ID=$2; shift 2 ;;
    --google-client-secret) GOOGLE_CLIENT_SECRET=$2; shift 2 ;;
    --repo) REPO_URL=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    --launchpad) LAUNCHPAD=required; shift ;;
    --no-launchpad) LAUNCHPAD=no; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# Prompts read the terminal, so `curl … | sudo bash` still asks.
ask() {
  local prompt=$1 default=${2:-} answer
  if [ "$ASSUME_YES" = 1 ] || [ ! -r /dev/tty ]; then
    printf '%s' "$default"
    return
  fi
  read -r -p "$prompt${default:+ [$default]}: " answer </dev/tty
  printf '%s' "${answer:-$default}"
}

# ---------------------------------------------------------------- checks

[ "$(id -u)" = 0 ] || die "Run as root (sudo $0)."
command -v apt-get >/dev/null || die "Only Debian and Ubuntu (apt) are supported."
[ "$(uname -m)" = x86_64 ] || die "Only x86_64 is supported."

EXISTING_ENV=0
[ -f "$ENV_FILE" ] && EXISTING_ENV=1

if [ "$EXISTING_ENV" = 0 ]; then
  [ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL=$(ask "Admin email (the Google account that administers the gateway)")
  [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "A valid admin email is required (--admin-email)."
  ADMIN_EMAIL=$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')
  [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Invalid port: $PORT"
  DEFAULT_URL="http://$( [ "$HOST" = 0.0.0.0 ] && hostname -f 2>/dev/null || printf '%s' "$HOST"):$PORT"
  [ -n "$PUBLIC_URL" ] || PUBLIC_URL=$(ask "Public URL (how browsers reach the gateway)" "$DEFAULT_URL")
  PUBLIC_URL=${PUBLIC_URL%/}
  if [ -z "$GOOGLE_CLIENT_ID" ]; then
    echo "Google sign-in (optional): create an OAuth client of type 'Web application' with the"
    echo "redirect URI $PUBLIC_URL/auth/google/callback. Leave empty to sign in with an admin token."
    GOOGLE_CLIENT_ID=$(ask "Google OAuth client ID" "")
  fi
  if [ -n "$GOOGLE_CLIENT_ID" ] && [ -z "$GOOGLE_CLIENT_SECRET" ]; then
    GOOGLE_CLIENT_SECRET=$(ask "Google OAuth client secret" "")
    [ -n "$GOOGLE_CLIENT_SECRET" ] || die "The Google client secret is required with a client ID."
  fi
else
  say "Keeping the existing configuration in $ENV_FILE."
  PORT=$(sed -n 's/^GATEWAY_PORT=//p' "$ENV_FILE" | tail -1)
  PORT=${PORT:-7420}
fi

# ---------------------------------------------------------------- packages

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git rsync iproute2 nftables e2fsprogs procps kmod >/dev/null

# KVM is in the kernel: make /dev/kvm available (CPU support, module loaded now and at boot,
# device permissions). Firecracker runs every agent VM on it.
setup_kvm() {
  local module
  if grep -qw vmx /proc/cpuinfo; then
    module=kvm_intel
  elif grep -qw svm /proc/cpuinfo; then
    module=kvm_amd
  elif [ -e /dev/kvm ]; then
    return 0
  else
    warn "This CPU exposes no hardware virtualization (Intel VT-x / AMD-V). Enable it in the"
    warn "BIOS/UEFI, or on a cloud VM enable nested virtualization (or use a bare-metal instance)."
    return 1
  fi
  if [ ! -e /dev/kvm ]; then
    say "Enabling KVM ($module)"
    if ! modprobe "$module" 2>/tmp/kvm-modprobe.err; then
      warn "Could not load $module: $(cat /tmp/kvm-modprobe.err)"
      warn "If the kernel log says 'disabled by bios', enable virtualization in the BIOS/UEFI."
      return 1
    fi
    command -v udevadm >/dev/null && udevadm settle || true
  fi
  [ -e /dev/kvm ] || { warn "/dev/kvm did not appear after loading $module."; return 1; }
  # Loaded at every boot too.
  install -d /etc/modules-load.d
  printf 'kvm\n%s\n' "$module" >/etc/modules-load.d/kvm.conf
  getent group kvm >/dev/null || groupadd --system kvm
  chgrp kvm /dev/kvm
  chmod 0660 /dev/kvm
}

if [ "$LAUNCHPAD" != no ]; then
  if setup_kvm; then
    LAUNCHPAD=yes
    say "KVM is available: installing the agent launchpad"
  elif [ "$LAUNCHPAD" = required ]; then
    die "KVM is required for the agent launchpad (--launchpad)."
  else
    LAUNCHPAD=no
    warn "Installing without the agent launchpad (needs KVM). Re-run once KVM is available."
  fi
fi

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true; }
if [ "$(node_major)" != "$NODE_MAJOR" ]; then
  say "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN=$(command -v node)
say "Node.js $(node -v)"

if [ "$LAUNCHPAD" = yes ] && ! command -v docker >/dev/null; then
  say "Installing Docker (builds the agent VM image)"
  apt-get install -y -qq docker.io >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- user and code

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating the $SERVICE_USER system user"
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR" "$STATE_DIR/data"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
SOURCE_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ] && grep -q '"name": "local-gateway"' "$SCRIPT_DIR/../package.json"; then
  SOURCE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
fi

install -d "$INSTALL_DIR"
if [ -n "$SOURCE_DIR" ] && [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
  say "Copying the code from $SOURCE_DIR"
  rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude .env \
    --exclude dist --exclude guest/dist --exclude web/.next "$SOURCE_DIR/" "$INSTALL_DIR/"
elif [ -z "$SOURCE_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating the code ($BRANCH)"
    git -C "$INSTALL_DIR" fetch -q origin "$BRANCH" && git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
  else
    say "Cloning $REPO_URL ($BRANCH)"
    git clone -q --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
fi
as_service() { runuser -u "$SERVICE_USER" -- env HOME="$STATE_DIR" "$@"; }

# The code stays owned by root: root runs parts of it (vmd, the host setup). The service only
# writes Next.js's runtime cache.
say "Installing dependencies and building (a few minutes)"
(cd "$INSTALL_DIR" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)
(cd "$INSTALL_DIR" && npm run build >/dev/null)
chown -R root:root "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/web/.next"

# ---------------------------------------------------------------- configuration

if [ "$EXISTING_ENV" = 0 ]; then
  say "Writing $ENV_FILE"
  install -d -m 0750 -g "$SERVICE_USER" "$CONFIG_DIR"
  umask 027
  {
    echo "# Local gateway configuration (see README.md). Restart the service after editing."
    echo "GATEWAY_HOST=$HOST"
    echo "GATEWAY_PORT=$PORT"
    echo "GATEWAY_PUBLIC_URL=$PUBLIC_URL"
    echo "GATEWAY_DATA_DIR=$STATE_DIR/data"
    echo "GATEWAY_KEY_FILE=$STATE_DIR/master.key"
    echo "GATEWAY_ADMIN_EMAILS=$ADMIN_EMAIL"
    echo "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID"
    echo "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET"
    if [ "$LAUNCHPAD" = yes ]; then
      echo "GATEWAY_VM_HOST=$VM_HOST"
      echo "LAUNCHPAD_VM_DRIVER=firecracker"
      echo "LAUNCHPAD_VMD_SOCKET=/run/launchpad/vmd.sock"
    fi
  } >"$ENV_FILE"
  chgrp "$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  umask 022
fi

# An earlier install without KVM: turn the launchpad on in the kept configuration.
if [ "$LAUNCHPAD" = yes ] && ! grep -q '^LAUNCHPAD_VM_DRIVER=' "$ENV_FILE"; then
  say "Enabling the agent launchpad in $ENV_FILE"
  {
    echo "GATEWAY_VM_HOST=$VM_HOST"
    echo "LAUNCHPAD_VM_DRIVER=firecracker"
    echo "LAUNCHPAD_VMD_SOCKET=/run/launchpad/vmd.sock"
  } >>"$ENV_FILE"
fi

# The first admin token, shown once (the service would otherwise print it in the journal).
ADMIN_TOKEN=""
if [ ! -s "$STATE_DIR/data/store.enc" ]; then
  ADMIN_TOKEN=$(cd "$INSTALL_DIR" && as_service bash -c "set -a; . '$ENV_FILE'; set +a; npm run --silent admin:reset-token" 2>/dev/null | grep -o 'gwa_[A-Za-z0-9_-]*' | head -1 || true)
fi

# ---------------------------------------------------------------- agent launchpad

if [ "$LAUNCHPAD" = yes ]; then
  say "Setting up the agent VM host (Firecracker, guest kernel, bridge, firewall)"
  GATEWAY_PORT=$PORT "$INSTALL_DIR/deploy/vm-host-setup.sh"
  if [ ! -s "$LAUNCHPAD_STATE_DIR/rootfs.ext4" ]; then
    say "Building the agent VM image (Docker, several minutes)"
    (cd "$INSTALL_DIR" && deploy/build-guest-image.sh "$LAUNCHPAD_STATE_DIR/rootfs.ext4" 6G >/dev/null)
    chown root:root "$LAUNCHPAD_STATE_DIR/rootfs.ext4"
  fi
fi

# ---------------------------------------------------------------- services

if [ ! -d /run/systemd/system ]; then
  warn "systemd is not running: not installing services. Start the gateway with:"
  warn "  cd $INSTALL_DIR && sudo -u $SERVICE_USER bash -c 'set -a; . $ENV_FILE; set +a; NODE_ENV=production node dist/server/index.js'"
else
  if [ "$LAUNCHPAD" = yes ]; then
    cat >/etc/systemd/system/launchpad-vmd.service <<EOF
[Unit]
Description=Agent launchpad VM daemon (Firecracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GATEWAY_PORT=$PORT
Environment=VMD_SOCKET=/run/launchpad/vmd.sock
Environment=VMD_SOCKET_GID=$(id -g "$SERVICE_USER")
ExecStartPre=$INSTALL_DIR/deploy/vm-host-setup.sh
ExecStart=$NODE_BIN $INSTALL_DIR/dist/vmd/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  fi
  cat >/etc/systemd/system/local-gateway.service <<EOF
[Unit]
Description=Local gateway: scoped, short-lived access to tools (and the agent launchpad)
After=network-online.target$( [ "$LAUNCHPAD" = yes ] && printf ' launchpad-vmd.service')
Wants=network-online.target$( [ "$LAUNCHPAD" = yes ] && printf ' launchpad-vmd.service')

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $INSTALL_DIR/dist/server/index.js
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  if [ "$LAUNCHPAD" = yes ]; then
    systemctl enable -q launchpad-vmd.service
    systemctl restart launchpad-vmd.service
  fi
  systemctl enable -q local-gateway.service
  systemctl restart local-gateway.service

  say "Waiting for the gateway to answer"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null 2>/dev/null "http://$( [ "$HOST" = 0.0.0.0 ] && echo 127.0.0.1 || echo "$HOST"):$PORT/api/auth/config"; then
      READY=1
      break
    fi
    sleep 1
  done
  [ "${READY:-0}" = 1 ] || die "The gateway did not start: journalctl -u local-gateway -n 50"
fi

# ---------------------------------------------------------------- done

PUBLIC_URL=$(sed -n 's/^GATEWAY_PUBLIC_URL=//p' "$ENV_FILE" | tail -1)
echo
say "The local gateway is installed: $PUBLIC_URL"
echo "    code   $INSTALL_DIR"
echo "    config $ENV_FILE"
echo "    data   $STATE_DIR (back up master.key: without it the store can't be decrypted)"
if [ "$LAUNCHPAD" = yes ]; then echo "    agents on: Firecracker VMs via launchpad-vmd.service"; fi
if [ -n "$ADMIN_TOKEN" ]; then
  echo
  echo "    Admin token (shown once, store it safely): $ADMIN_TOKEN"
fi
if [ "$(sed -n 's/^GOOGLE_CLIENT_ID=//p' "$ENV_FILE" | tail -1)" = "" ]; then
  echo "    Google sign-in is off: sign in with the admin token, and set GOOGLE_CLIENT_ID/SECRET in"
  echo "    $ENV_FILE to let $(sed -n 's/^GATEWAY_ADMIN_EMAILS=//p' "$ENV_FILE" | tail -1) and members sign in with Google."
fi
if [ "$(sed -n 's/^GATEWAY_HOST=//p' "$ENV_FILE" | tail -1)" = 127.0.0.1 ]; then
  echo "    It listens on 127.0.0.1 only: put a TLS reverse proxy (or tunnel) in front for $PUBLIC_URL."
fi
