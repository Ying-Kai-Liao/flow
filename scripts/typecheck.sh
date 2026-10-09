#!/bin/sh
# Type-check the plugin in any worktree: installs the pinned TypeScript when missing and links the
# engine-written .claude-plugin/types from the main checkout. Safe to run repeatedly.
set -eu
cd "$(dirname "$0")/.."

if [ ! -x node_modules/.bin/tsc ]; then
  npm ci --no-audit --no-fund
fi

types=.claude-plugin/types
if [ ! -f "$types/tsconfig.json" ]; then
  main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  src="$main/$types"
  if [ ! -f "$src/tsconfig.json" ]; then
    echo "typecheck: no $types here and none in the main checkout ($src)." >&2
    echo "Open a session in the main checkout with 'claude --plugin-dir .' once so Claude Code writes them." >&2
    exit 1
  fi
  # Only a link is replaced (a stale one, target gone); a real directory is never touched.
  if [ -L "$types" ]; then rm "$types"; fi
  if [ -e "$types" ]; then
    echo "typecheck: $types exists but is incomplete; remove it or reload the plugin from this folder." >&2
    exit 1
  fi
  ln -s "$src" "$types"
fi

exec node_modules/.bin/tsc -p .
