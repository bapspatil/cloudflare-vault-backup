#!/usr/bin/env bash
# Copies the built plugin into a vault for manual testing.
# Usage: scripts/install-dev.sh /path/to/vault
set -euo pipefail
vault="${1:?vault path required}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$vault/.obsidian/plugins/r2-vault-sync"
mkdir -p "$dest"
cp "$root/main.js" "$root/manifest.json" "$root/styles.css" "$dest/"
echo "installed into $dest"
