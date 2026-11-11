#!/bin/sh
# Copy the plugin into a vault and reload it in the running Obsidian.
# Usage: ./install.sh [vault path]   (default: ~/КэАли)
set -e
cd "$(dirname "$0")"
VAULT="${1:-$HOME/КэАли}"
DEST="$VAULT/.obsidian/plugins/tz-format"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "Installed to $DEST"
if command -v obsidian >/dev/null 2>&1; then
  obsidian plugin:reload id=tz-format >/dev/null 2>&1 && echo "Reloaded in Obsidian" || true
fi
