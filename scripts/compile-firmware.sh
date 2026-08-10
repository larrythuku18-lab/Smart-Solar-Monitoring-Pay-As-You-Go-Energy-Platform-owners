#!/usr/bin/env bash
#
# compile-firmware.sh — Compile firmware/esp32-firmware.ino against the real
# ESP32 Arduino toolchain so firmware changes are validated before anything
# is flashed to hardware.
#
# Compiles TWO configurations of the same sketch:
#   1. default      (OTA_ENABLED=0) — what ships in the field
#   2. ota-enabled  (OTA_ENABLED=1) — exercises the OTA code path
# A sketch that compiles in only one configuration is a CI failure, because
# the OTA feature must never be shipped unvalidated.
#
# Requirements: curl (to fetch arduino-cli if missing). Everything else is
# downloaded on demand and cached under .tools/ (gitignored) / ~/.arduino15.
#
# Usage:
#   bash scripts/compile-firmware.sh
# Env overrides: FQBN, TOOLS_DIR, OUT_DIR, JOBS, ESP32_CORE_VERSION
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware/esp32-firmware.ino"

FQBN="${FQBN:-esp32:esp32:esp32}"   # classic ESP32 DevKitC
# Pinned espressif core. Two ESP32 cores can exist side by side (Arduino's
# own arduino:esp32 fork ships in the default index) — pinning the version
# makes the install + FQBN resolution deterministic everywhere.
ESP32_CORE_VERSION="${ESP32_CORE_VERSION:-3.3.11}"
BOARD_INDEX_URL="https://espressif.github.io/arduino-esp32/package_esp32_index.json"
TOOLS_DIR="${TOOLS_DIR:-$ROOT/.tools}"
OUT_DIR="${OUT_DIR:-$ROOT/build/firmware}"
# Cap compiler parallelism: arduino-cli defaults to one gcc job per CPU core,
# which thrashes RAM on loaded/shared machines (observed: 8 cores, <400 MB
# free -> a 10-minute build that looked hung). Override with JOBS=8 on a
# quiet machine or in CI.
JOBS="${JOBS:-2}"

step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SKETCH" ] || die "Sketch not found: $SKETCH"

# ── 1. arduino-cli (install to .tools/ if not already on PATH) ────────────
# Uses the official install script (https://arduino.github.io/arduino-cli),
# which resolves the latest release + correct platform archive itself.
if ! command -v arduino-cli >/dev/null 2>&1; then
  step "arduino-cli not found — installing to $TOOLS_DIR"
  mkdir -p "$TOOLS_DIR"
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR="$TOOLS_DIR" sh
  export PATH="$TOOLS_DIR:$PATH"
  arduino-cli version
  ok "arduino-cli installed"
else
  ok "using $(command -v arduino-cli) ($(arduino-cli version | head -n1))"
fi

# ── 2. ESP32 core (idempotent — no-op when the pinned version is present) ─
if ! arduino-cli core list 2>/dev/null | grep -q "esp32:esp32 *$ESP32_CORE_VERSION"; then
  step "Installing ESP32 core $ESP32_CORE_VERSION (one-time download, ~1 GB)"
  arduino-cli core update-index --additional-urls "$BOARD_INDEX_URL"
  arduino-cli core install "esp32:esp32@$ESP32_CORE_VERSION" --additional-urls "$BOARD_INDEX_URL"
fi
ok "ESP32 core $ESP32_CORE_VERSION installed"

# ── 3. Stage the sketch + compile default config (OTA_ENABLED=0) ─────────
# arduino-cli requires the .ino to live in a folder named after it
# (esp32-firmware/esp32-firmware.ino) — the repo keeps it as a bare file in
# firmware/, which the Arduino IDE tolerates but arduino-cli rejects with
# "main file missing from sketch". Stage a copy in a properly-named folder.
step "Staging sketch + compiling default configuration (OTA_ENABLED=0)"
grep -q '^#define OTA_ENABLED 0$' "$SKETCH" \
  || die "Expected '#define OTA_ENABLED 0' in $SKETCH — sketch layout changed?"
STAGING_DIR="$OUT_DIR/staging"
trap 'rm -rf "$STAGING_DIR"' EXIT   # never leave staged sketch copies behind
DEFAULT_SKETCH="$STAGING_DIR/esp32-firmware/esp32-firmware.ino"
mkdir -p "$(dirname "$DEFAULT_SKETCH")"
cp "$SKETCH" "$DEFAULT_SKETCH"
arduino-cli compile --fqbn "$FQBN" --warnings all --jobs "$JOBS" \
  --output-dir "$OUT_DIR/default" "$STAGING_DIR/esp32-firmware"
ok "default firmware compiled"

# ── 4. Compile OTA-enabled configuration (OTA_ENABLED=1) ──────────────────
# Deterministic variant: build a temp copy of the sketch with the flag
# flipped, so the OTA code path is guaranteed to be compiled regardless of
# toolchain build-property support. The repo's tracked file is never touched.
step "Compiling OTA-enabled configuration (OTA_ENABLED=1)"
# Same folder-name rule: the .ino must sit in a folder called esp32-firmware/
# (the basename), so the OTA variant gets its own sub-folder with that name.
OTA_SKETCH="$STAGING_DIR/ota/esp32-firmware/esp32-firmware.ino"
mkdir -p "$(dirname "$OTA_SKETCH")"
sed 's/^#define OTA_ENABLED 0$/#define OTA_ENABLED 1/' "$SKETCH" > "$OTA_SKETCH"

# A fleet build MUST bake in the OTA root public key — with an empty
# FIRMWARE_ROOT_PUBKEY the device accepts unsigned binaries, which defeats
# the whole signature chain. Warn loudly (dev builds legitimately omit it,
# so this is a warning, not a failure).
if grep -q '^#define FIRMWARE_ROOT_PUBKEY ""$' "$OTA_SKETCH"; then
  warn "OTA-enabled sketch has an EMPTY FIRMWARE_ROOT_PUBKEY — devices flashed " \
       "from this build will accept UNSIGNED firmware. Run \`node " \
       "scripts/generate-ota-keys.js\` and paste the root key before a fleet build."
fi
arduino-cli compile --fqbn "$FQBN" --warnings all --jobs "$JOBS" \
  --output-dir "$OUT_DIR/ota-enabled" "$STAGING_DIR/ota/esp32-firmware"
ok "OTA-enabled firmware compiled"

# ── 5. Summary ────────────────────────────────────────────────────────────
step "Done"
# (staging cleanup is handled by the EXIT trap)
# arduino-cli names the app image after the .ino file, hence the .ino.bin suffix.
DEFAULT_BIN="$OUT_DIR/default/esp32-firmware.ino.bin"
OTA_BIN="$OUT_DIR/ota-enabled/esp32-firmware.ino.bin"
echo "Default:      $DEFAULT_BIN"
echo "OTA-enabled:  $OTA_BIN"
echo
echo "Both configurations compiled successfully against $FQBN."
echo "Flash targets (USB):"
echo "  default     -> esptool.py write_flash 0x10000 $DEFAULT_BIN"
echo "  ota-enabled -> esptool.py write_flash 0x10000 $OTA_BIN"
