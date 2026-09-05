#!/usr/bin/env bash
# Symlinks the plugin into opencode's autoload directory and seeds a disabled config.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
plugin_dir="$HOME/.config/opencode/plugin"
config="$HOME/.config/opencode/octx.json"

mkdir -p "$plugin_dir"
ln -sfn "$repo/plugin/octx.ts" "$plugin_dir/octx.ts"
echo "linked $plugin_dir/octx.ts -> $repo/plugin/octx.ts"

if [ ! -f "$config" ]; then
  cp "$repo/octx.example.json" "$config"
  echo "wrote $config (level: off — set it to \"basic\" or \"full\" to start capturing)"
else
  echo "$config already exists, left alone"
fi

echo
echo "add the CLI to your PATH with:"
echo "  ln -sfn $repo/cli/octx.mjs ~/.local/bin/octx"
