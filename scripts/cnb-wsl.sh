#!/usr/bin/env bash
set -eu

out=$(wslpath -u "$1")
repo=$2
expected_bun=$3
cd "$repo"
actual_bun=$(bun --version)
if [ "$actual_bun" != "$expected_bun" ]; then
  echo "WSL Bun $actual_bun must match Windows Bun $expected_bun; install Bun $expected_bun before publishing." >&2
  exit 1
fi
cache="$HOME/.cache/omp-cnb"
mkdir -p "$cache"
if ! mkdir "$cache/direct-lock" 2>/dev/null; then echo 'CNB WSL worktree is locked' >&2; exit 1; fi
backup=$(mktemp -d "$cache/direct-backup.XXXXXXXX")
cleanup() {
  for name in omp-linux-x64 pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node embedded-client.generated.txt; do
    case "$name" in
      omp-linux-x64) destination="$repo/packages/coding-agent/binaries/$name" ;;
      embedded-client.generated.txt) destination="$repo/packages/stats/src/$name" ;;
      *) destination="$repo/packages/natives/native/$name" ;;
    esac
    if [ -f "$backup/$name" ]; then
      rm -f -- "$destination"
      mv -- "$backup/$name" "$destination"
    fi
  done
  rmdir "$backup"
  rmdir "$cache/direct-lock"
}
trap cleanup EXIT
for name in pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node; do
  file="$repo/packages/natives/native/$name"
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Existing native output is not a regular file' >&2; exit 1; }
    mv -- "$file" "$backup/$name"
  fi
done
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS OMP_NATIVE_BUILD_BACKEND CARGO_TARGET_DIR
if [ -d "$HOME/omp-cargo-target" ]; then export CARGO_TARGET_DIR="$HOME/omp-cargo-target"; fi
bun install --frozen-lockfile
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native --skip-load-probe -- --lockfile_mode=error
for file in "$repo/packages/coding-agent/binaries/omp-linux-x64" "$repo/packages/stats/src/embedded-client.generated.txt"; do
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Existing build output is not a regular file' >&2; exit 1; }
    mv -- "$file" "$backup/$(basename "$file")"
  fi
done
bun run ci:release:build-binaries --targets linux-x64
[ -s packages/coding-agent/binaries/omp-linux-x64 ] || exit 1
cp packages/coding-agent/binaries/omp-linux-x64 "$out"
