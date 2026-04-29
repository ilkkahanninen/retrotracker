#!/usr/bin/env bash
#
# Build the headless `pt2-render` binary used by the accuracy test bed.
#
# Pulls a minimal slice of pt2-clone's sources (the replayer + Paula + BLEP +
# module loader) and links them against our own main.c and a small SDL2 shim.
# No real SDL2 dependency, no GUI, no audio device — just deterministic
# offline WAV rendering.
#
# Output: vendor/bin/pt2-render

set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$VENDOR_DIR/pt2-clone"
HL_DIR="$VENDOR_DIR/headless"
BIN_DIR="$VENDOR_DIR/bin"
REPO_URL="https://github.com/8bitbubsy/pt2-clone.git"

log()  { printf '[pt2-render] %s\n' "$*"; }
fail() { printf '[pt2-render] ERROR: %s\n' "$*" >&2; exit 1; }

# ─── Pre-flight ────────────────────────────────────────────────────────────
log "platform: $(uname -s) $(uname -m)"
command -v git  >/dev/null || fail "git not found"
command -v cc   >/dev/null || fail "cc not found (install Xcode CLT or build-essential)"
command -v make >/dev/null || fail "make not found"

# ─── Sources ───────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

if [ ! -d "$SRC_DIR/.git" ]; then
  log "cloning $REPO_URL → $SRC_DIR"
  git clone --depth 1 "$REPO_URL" "$SRC_DIR"
else
  log "updating $SRC_DIR"
  git -C "$SRC_DIR" fetch --depth 1 origin
  git -C "$SRC_DIR" reset --hard origin/HEAD
fi

# ─── Build ─────────────────────────────────────────────────────────────────
log "compiling pt2-render (headless, no SDL2)"
make -C "$HL_DIR" >/dev/null

[ -x "$BIN_DIR/pt2-render" ] || fail "build did not produce $BIN_DIR/pt2-render"

log "binary: $BIN_DIR/pt2-render"
log "usage:  $BIN_DIR/pt2-render in.mod out.wav [--rate=44100] [--loops=0]"
