#!/usr/bin/env bash
#
# AI Combinator — VM Setup Script
#
# Provisions a fresh Ubuntu/Debian VM with everything needed to run
# the supervisor and agent containers.
#
# Usage:
#   curl -sSL <url>/setup-vm.sh | bash
#   — or —
#   scp setup-vm.sh root@<vm-ip>:~ && ssh root@<vm-ip> bash setup-vm.sh
#
# What it does:
#   1. Installs Docker Engine + Docker Compose plugin
#   2. Installs Node.js 22 via NodeSource
#   3. Installs cloudflared (Cloudflare Tunnel daemon)
#   4. Creates the aicombinator service user
#   5. Creates the directory structure under /srv/aicombinator
#   6. Creates the Docker bridge network
#   7. Builds the agent container base image
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
die()  { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

# ─── Pre-flight ──────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "This script must be run as root."

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_DEB="amd64" ;;
  aarch64) ARCH_DEB="arm64" ;;
  *)       die "Unsupported architecture: $ARCH" ;;
esac

log "Architecture: $ARCH ($ARCH_DEB)"

# ─── 1. Install Docker ──────────────────────────────────
if command -v docker &>/dev/null; then
  log "Docker already installed: $(docker --version)"
else
  log "Installing Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Detect distro (works for Ubuntu and Debian)
  . /etc/os-release
  echo \
    "deb [arch=$ARCH_DEB signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
    ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

  systemctl enable --now docker
  log "Docker installed: $(docker --version)"
fi

# ─── 2. Install Node.js 22 ──────────────────────────────
if command -v node &>/dev/null && node --version | grep -q "v22"; then
  log "Node.js 22 already installed: $(node --version)"
else
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js installed: $(node --version)"
fi

# ─── 3. Install cloudflared ─────────────────────────────
if command -v cloudflared &>/dev/null; then
  log "cloudflared already installed: $(cloudflared --version)"
else
  log "Installing cloudflared..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH_DEB}.deb" \
    -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
  log "cloudflared installed: $(cloudflared --version)"
fi

# ─── 4. Create service user ─────────────────────────────
if id "aicombinator" &>/dev/null; then
  log "User 'aicombinator' already exists"
else
  log "Creating service user 'aicombinator'..."
  useradd --system --create-home --shell /bin/bash aicombinator
  usermod -aG docker aicombinator
  log "User 'aicombinator' created and added to docker group"
fi

# ─── 5. Create directory structure ───────────────────────
log "Creating directory structure..."
mkdir -p /srv/aicombinator/{supervisor,companies,mcp-servers/{email,browser,finance,domain,social},logs}

# Set ownership
chown -R aicombinator:aicombinator /srv/aicombinator

log "Directory structure:"
find /srv/aicombinator -maxdepth 2 -type d | head -20

# ─── 6. Create Docker network ───────────────────────────
if docker network inspect aicombinator &>/dev/null; then
  log "Docker network 'aicombinator' already exists"
else
  log "Creating Docker network 'aicombinator'..."
  docker network create aicombinator
  log "Docker network created"
fi

# ─── 7. Build agent container image ─────────────────────
CONTAINER_DIR="/srv/aicombinator/supervisor/container"
if [[ -f "$CONTAINER_DIR/Dockerfile" ]]; then
  log "Building agent container image..."
  docker build -t aic-agent:latest "$CONTAINER_DIR"
  log "Agent container image built"
else
  warn "No Dockerfile found at $CONTAINER_DIR/Dockerfile — skipping image build."
  warn "Copy the supervisor code to /srv/aicombinator/supervisor first, then run:"
  warn "  docker build -t aic-agent:latest /srv/aicombinator/supervisor/container"
fi

# ─── 8. Install basic utilities ─────────────────────────
log "Installing utilities..."
apt-get install -y -qq htop jq logrotate fail2ban ufw

# ─── 9. Configure firewall ──────────────────────────────
log "Configuring firewall (UFW)..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
if [[ "${ALLOW_SUPERVISOR_PORT:-0}" == "1" ]]; then
  ufw allow 8787/tcp
  log "Firewall enabled: SSH + supervisor API inbound"
else
  # No need to open 8787 — Cloudflare Tunnel handles inbound traffic
  log "Firewall enabled: SSH only inbound"
fi
ufw --force enable

# ─── Done ────────────────────────────────────────────────
echo ""
log "========================================="
log "  VM setup complete!"
log "========================================="
echo ""
log "Next steps:"
log "  1. Copy supervisor code to /srv/aicombinator/supervisor/"
log "  2. Copy .env file with secrets to /srv/aicombinator/supervisor/.env"
log "  3. Set up Cloudflare Tunnel:"
log "       cloudflared tunnel login"
log "       cloudflared tunnel create aicombinator"
log "       cp deploy/cloudflared-config.yml /etc/cloudflared/config.yml"
log "       cloudflared service install"
log "       systemctl enable --now cloudflared"
log "  4. Install systemd service:"
log "       cp deploy/aicombinator-supervisor.service /etc/systemd/system/"
log "       systemctl daemon-reload"
log "       systemctl enable --now aicombinator-supervisor"
log "  5. Verify:"
log "       systemctl status aicombinator-supervisor"
log "       curl http://localhost:8787/health"
echo ""
