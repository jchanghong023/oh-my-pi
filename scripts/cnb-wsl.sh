#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
unset CNB_TOKEN
cd -- "$(dirname -- "$0")/.."
if [ "$#" -eq 1 ] && [ "$1" = --bun-identity ]; then
  exec bun -e 'process.stdout.write(JSON.stringify({version: Bun.version, revision: Bun.revision}))'
fi
if [ "$#" -lt 8 ]; then echo 'Invalid CNB WSL build parameters' >&2; exit 1; fi

stage=$(wslpath -u "$1")
shift
cache="$HOME/.cache/omp-cnb"
mkdir -p "$cache"
if ! mkdir "$cache/lock" 2>/dev/null; then echo 'CNB WSL worktree is locked' >&2; exit 1; fi
trap 'rmdir "$cache/lock"' EXIT
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/omp-cargo-target}"
bun scripts/cnb-build.ts "$cache" "$stage" "$@"
