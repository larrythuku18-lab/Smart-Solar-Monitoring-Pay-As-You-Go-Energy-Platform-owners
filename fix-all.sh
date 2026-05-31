#!/usr/bin/env bash
# fix-all.sh — Install, validate, test, build, and start the Solar PAYG platform
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[fix-all]${NC} $*"; }
warn() { echo -e "${YELLOW}[fix-all]${NC} $*"; }
fail() { echo -e "${RED}[fix-all]${NC} $*"; exit 1; }

# ── 1. Environment ────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    warn ".env not found — copying from .env.example"
    cp .env.example .env
    warn "Edit .env with real credentials before production use."
  else
    fail ".env.example missing — cannot bootstrap environment."
  fi
fi

# ── 2. Node version check ─────────────────────────────────────────────────────
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js >= 18 required (found: $(node -v))"
fi
log "Node.js $(node -v) OK"

# ── 3. Install dependencies ───────────────────────────────────────────────────
log "Installing npm dependencies..."
npm install --no-audit --no-fund

# ── 4. Syntax / build check ───────────────────────────────────────────────────
log "Running build (syntax validation)..."
npm run build

# ── 5. Lint ───────────────────────────────────────────────────────────────────
log "Running ESLint..."
npm run lint

# ── 6. Tests ──────────────────────────────────────────────────────────────────
log "Running test suite..."
npm test

# ── 7. Optional: Docker services ──────────────────────────────────────────────
if command -v docker &>/dev/null && [[ "${START_DOCKER:-0}" == "1" ]]; then
  log "Starting Docker Compose services (postgres, redis, mosquitto)..."
  docker compose up -d postgres redis mosquitto
  sleep 5
fi

# ── 8. Database migration (if postgres reachable) ─────────────────────────────
if [[ "${RUN_MIGRATE:-0}" == "1" ]]; then
  log "Running database migration..."
  npm run migrate || warn "Migration failed — ensure PostgreSQL is running."
fi

# ── 9. Start application ──────────────────────────────────────────────────────
PORT="${PORT:-3000}"
log "All checks passed. Starting server on port ${PORT}..."
log "Health: http://localhost:${PORT}/health"
log "Dashboard: http://localhost:${PORT}/dashboard.html"

exec npm start
