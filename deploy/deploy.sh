#!/usr/bin/env bash
#
# AI Combinator — Deploy / Update Supervisor
#
# Deploys the supervisor to the production VM. Can be run locally
# (pushes via SSH) or on the VM itself.
#
# Usage:
#   ./deploy/deploy.sh                    # Deploy to VM via SSH
#   ./deploy/deploy.sh --local            # Run directly on the VM
#   ./deploy/deploy.sh --build-only       # Only build images, don't restart
#
set -euo pipefail

# ─── Config ──────────────────────────────────────────────
VM_USER="${VM_USER:-aicombinator}"
VM_HOST="${VM_HOST:-}"                    # Set this or pass as env var
VM_DIR="/srv/aicombinator"
SUPERVISOR_DIR="$VM_DIR/supervisor"
STAGING_DIR="/tmp/aic-supervisor-deploy"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()  { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

require_remote_env() {
  ssh "$VM_USER@$VM_HOST" "test -f '$SUPERVISOR_DIR/.env'" >/dev/null 2>&1 \
    || die "Remote supervisor .env is missing at $SUPERVISOR_DIR/.env"
}

require_local_env() {
  [[ -f "$SUPERVISOR_DIR/.env" ]] || die "Local supervisor .env is missing at $SUPERVISOR_DIR/.env"
}

wait_for_local_health() {
  local attempts=20
  local delay=2
  for ((i=1; i<=attempts; i++)); do
    if curl -sf http://localhost:8787/health >/dev/null 2>&1; then
      curl -s http://localhost:8787/health | jq . 2>/dev/null || curl -s http://localhost:8787/health
      return 0
    fi
    sleep "$delay"
  done

  warn "Supervisor health check failed after $((attempts * delay))s"
  journalctl -u aicombinator-supervisor -n 80 --no-pager || true
  return 1
}

wait_for_remote_health() {
  local attempts=20
  local delay=2
  for ((i=1; i<=attempts; i++)); do
    if ssh "$VM_USER@$VM_HOST" "curl -sf http://localhost:8787/health" >/dev/null 2>&1; then
      ssh "$VM_USER@$VM_HOST" "curl -sf http://localhost:8787/health | jq . 2>/dev/null || curl -sf http://localhost:8787/health"
      return 0
    fi
    sleep "$delay"
  done

  warn "Supervisor health check failed after $((attempts * delay))s"
  ssh "$VM_USER@$VM_HOST" "sudo journalctl -u aicombinator-supervisor -n 80 --no-pager" || true
  return 1
}

# ─── Parse args ──────────────────────────────────────────
LOCAL=false
BUILD_ONLY=false

for arg in "$@"; do
  case $arg in
    --local)      LOCAL=true ;;
    --build-only) BUILD_ONLY=true ;;
    *)            die "Unknown argument: $arg" ;;
  esac
done

# ─── Local deploy (run on VM) ────────────────────────────
deploy_local() {
  log "Deploying supervisor locally..."
  require_local_env

  # 1. Pull latest code
  cd "$SUPERVISOR_DIR"
  if [[ -d .git ]]; then
    log "Pulling latest changes..."
    git pull --ff-only
  else
    log "Not a git repo — assuming code was copied manually"
  fi

  # 2. Install dependencies
  log "Installing dependencies..."
  npm ci --omit=dev

  # 3. Build TypeScript
  log "Building TypeScript..."
  npm run build

  # 4. Build agent container image
  log "Building agent container image..."
  docker build -t aic-agent:latest "$SUPERVISOR_DIR/container"

  if [[ "$BUILD_ONLY" == "true" ]]; then
    log "Build complete (--build-only). Skipping restart."
    return
  fi

  # 5. Restart supervisor
  if systemctl is-active --quiet aicombinator-supervisor; then
    log "Restarting supervisor via systemd..."
    sudo systemctl restart aicombinator-supervisor
  elif docker ps -q --filter name=aic-supervisor | grep -q .; then
    log "Restarting supervisor via Docker Compose..."
    cd "$VM_DIR"
    docker compose -f docker-compose.prod.yml up -d --force-recreate supervisor
  else
    warn "No running supervisor found. Start with:"
    warn "  systemctl start aicombinator-supervisor"
    warn "  — or —"
    warn "  docker compose -f $VM_DIR/docker-compose.prod.yml up -d"
  fi

  # 6. Health check
  log "Waiting for supervisor to start..."
  wait_for_local_health || die "Supervisor deploy did not become healthy"

  log "Deploy complete!"
}

# ─── Remote deploy (push via SSH) ────────────────────────
deploy_remote() {
  [[ -n "$VM_HOST" ]] || die "VM_HOST not set. Usage: VM_HOST=1.2.3.4 ./deploy/deploy.sh"

  log "Deploying to $VM_USER@$VM_HOST..."
  require_remote_env

  # 1. Build locally first
  log "Building supervisor locally..."
  cd "$(dirname "$0")/../supervisor"
  npm ci
  npm run build

  # 2. Sync files to a writable staging directory on the VM
  log "Syncing supervisor to VM staging directory..."
  ssh "$VM_USER@$VM_HOST" "rm -rf '$STAGING_DIR' && mkdir -p '$STAGING_DIR'"
  rsync -avz --delete \
    --exclude node_modules \
    --exclude .env \
    --exclude "*.ts" \
    --exclude src/ \
    ./ "$VM_USER@$VM_HOST:$STAGING_DIR/"

  # 3. Copy staged build into the protected deploy directory, preserving the
  #    remote .env file and working around ownership drift from older manual copies.
  log "Installing staged build on VM..."
  ssh "$VM_USER@$VM_HOST" "\
    sudo mkdir -p '$SUPERVISOR_DIR' && \
    sudo rsync -av --delete --filter='protect .env' '$STAGING_DIR/' '$SUPERVISOR_DIR/' && \
    cd '$SUPERVISOR_DIR' && \
    npm ci --omit=dev && \
    sudo systemctl restart aicombinator-supervisor \
  "

  # 4. Remote health check
  log "Checking health..."
  wait_for_remote_health || die "Supervisor deploy did not become healthy"

  log "Deploy complete!"
}

# ─── Run ─────────────────────────────────────────────────
if [[ "$LOCAL" == "true" ]]; then
  deploy_local
else
  deploy_remote
fi
