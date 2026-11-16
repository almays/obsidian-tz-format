#!/bin/sh
# Copy the plugin into one or more vaults and reload it where Obsidian has the vault open.
# Usage: ./install.sh [vault path ...]   (default: ~/КэАли)
# Settings (data.json) stay per vault and are not touched.
set -e
cd "$(dirname "$0")"
[ $# -eq 0 ] && set -- "$HOME/КэАли"

vault_is_open() {
  node -e '
    const fs = require("fs"), path = require("path");
    const cfg = path.join(process.env.HOME, "Library/Application Support/obsidian/obsidian.json");
    const want = fs.realpathSync(process.argv[1]).normalize("NFC");
    const vaults = Object.values(JSON.parse(fs.readFileSync(cfg, "utf8")).vaults || {});
    process.exit(vaults.some((v) => v.open && v.path.normalize("NFC") === want) ? 0 : 1);
  ' "$1" 2>/dev/null
}
for VAULT in "$@"; do
  if [ ! -d "$VAULT/.obsidian" ]; then
    echo "Not a vault (no .obsidian): $VAULT" >&2
    continue
  fi
  DEST="$VAULT/.obsidian/plugins/tz-format"
  mkdir -p "$DEST"
  cp main.js manifest.json styles.css "$DEST/"
  echo "Installed to $DEST"
  # Reload only in a vault Obsidian has open, so a closed vault is not launched.
  if command -v obsidian >/dev/null 2>&1 && vault_is_open "$VAULT"; then
    obsidian vault="$(basename "$VAULT")" plugin:reload id=tz-format >/dev/null 2>&1 &&
      echo "  reloaded in Obsidian" || true
  fi
done
