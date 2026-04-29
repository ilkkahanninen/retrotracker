#!/usr/bin/env bash
#
# Render a pt2-clone reference WAV for each test fixture.
# Produces tests/fixtures/<name>.reference.wav for every <name>.mod.

set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$VENDOR_DIR/.." && pwd)"
FIX_DIR="$ROOT_DIR/tests/fixtures"
BIN="$VENDOR_DIR/bin/pt2-render"

if [ ! -x "$BIN" ]; then
  echo "pt2-render not built. Run: npm run pt2-clone:build" >&2
  exit 1
fi

shopt -s nullglob
mods=( "$FIX_DIR"/*.mod )
if [ ${#mods[@]} -eq 0 ]; then
  echo "no fixtures found in $FIX_DIR" >&2
  exit 1
fi

for mod in "${mods[@]}"; do
  ref="${mod%.mod}.reference.wav"
  echo "render: $(basename "$mod") -> $(basename "$ref")"
  "$BIN" "$mod" "$ref" --rate=44100
done

echo "done. ${#mods[@]} reference WAVs in $FIX_DIR"
