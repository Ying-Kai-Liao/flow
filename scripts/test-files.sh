#!/bin/sh
# Run only the named test files, optionally a few at a time:
#   sh scripts/test-files.sh tests/a.test.ts tests/b.test.ts
#   sh scripts/test-files.sh --jobs 3 --all        # every test, at most 3 runner processes at once
# `claude plugin test` takes a folder, never files, runs every *.test.ts under it and starts
# min(files, CPU cores) child processes at once with no flag or variable to lower that. So this
# builds a scratch mod folder that holds a copy of the plugin and of just the named tests (plus
# tests/support.ts and other non-test helpers), and runs that. With --jobs N it runs the files in
# chunks of N, one chunk after the other, which caps the child processes at N; every file still runs.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
usage() { echo "usage: sh scripts/test-files.sh [--jobs N] (--all | tests/<name>.test.ts ...)" >&2; exit 2; }

jobs=0
all=0
while [ $# -gt 0 ]; do
  case $1 in
    --jobs) [ $# -ge 2 ] || usage; jobs=$2; shift 2 ;;
    --all) all=1; shift ;;
    -*) usage ;;
    *) break ;;
  esac
done
case $jobs in ''|*[!0-9]*) usage ;; esac
if [ "$all" = 1 ]; then
  [ $# -eq 0 ] || usage
  set -- "$root"/tests/*.test.ts "$root"/tests/*.test.tsx
fi
[ $# -gt 0 ] || usage

tmp=$(mktemp -d "${TMPDIR:-/tmp}/flow-test-files.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# The plugin is copied, not linked: the runner refuses a hooks module that resolves outside the folder.
mkdir "$tmp/mod"
# Only what the plugin loads and the tests read: .claude (worktrees, gigabytes) and docs stay out.
for e in .claude-plugin hooks types agents skills commands scripts package.json tsconfig.json; do
  [ -e "$root/$e" ] && cp -R "$root/$e" "$tmp/mod/"
done
[ -e "$root/node_modules" ] && ln -s "$root/node_modules" "$tmp/mod/node_modules"
mkdir "$tmp/mod/tests"
for f in "$root"/tests/*; do
  case $f in *.test.ts|*.test.tsx) ;; *) cp -R "$f" "$tmp/mod/tests/" ;; esac
done

: > "$tmp/list"
for f in "$@"; do
  case $f in *'*'*) continue ;; esac
  case $f in *.test.ts|*.test.tsx) ;; *) echo "test-files: not a *.test.ts file: $f" >&2; exit 2 ;; esac
  case $f in /*) src=$f ;; *) src=$PWD/$f ;; esac
  [ -f "$src" ] || { echo "test-files: no such file: $f" >&2; exit 2; }
  echo "$src" >> "$tmp/list"
done
[ -s "$tmp/list" ] || { echo "test-files: no test files" >&2; exit 2; }

# jobs 0: one chunk with everything.
mkdir "$tmp/chunks"
if [ "$jobs" -gt 0 ]; then split -l "$jobs" "$tmp/list" "$tmp/chunks/c."; else cp "$tmp/list" "$tmp/chunks/c.a"; fi

status=0
for c in "$tmp"/chunks/c.*; do
  rm -f "$tmp"/mod/tests/*.test.ts "$tmp"/mod/tests/*.test.tsx
  while IFS= read -r src; do cp "$src" "$tmp/mod/tests/"; done < "$c"
  [ -n "${FLOW_TEST_FILES_SIZE:-}" ] && du -sh "$tmp/mod" >&2
  claude plugin test "$tmp/mod" || status=1
done
exit $status
