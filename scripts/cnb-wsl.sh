#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 8 ]; then echo 'Invalid CNB WSL build parameters' >&2; exit 1; fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
out=$(wslpath -u "$1")
repo=$2
expected_bun=$3
commit=$4
key=$5
case "$key" in *[!0-9a-f]*|'') echo 'Invalid CNB cache identity' >&2; exit 1 ;; esac
if [ "${#key}" -ne 64 ]; then echo 'Invalid CNB cache identity' >&2; exit 1; fi
unset CNB_TOKEN
export RELEASE_VERSION="$6"
export UPDATE_REPOSITORY="$7"
cd "$repo"
actual_bun=$(bun --version)
if [ "$actual_bun" != "$expected_bun" ]; then
  echo "WSL Bun $actual_bun must match Windows Bun $expected_bun; install Bun $expected_bun before publishing." >&2
  exit 1
fi
actual_revision=$(bun -e 'process.stdout.write(Bun.revision)')
if [ "$actual_revision" != "$8" ]; then
  echo 'WSL Bun revision must match Windows Bun revision; install the same Bun build before publishing.' >&2
  exit 1
fi
ensure_source() {
  if [ "$(git rev-parse HEAD)" != "$commit" ]; then
    echo 'WSL source commit changed during publication' >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" ]; then
    echo 'WSL working tree has uncommitted changes; refusing to publish' >&2
    exit 1
  fi
}
cache="$HOME/.cache/omp-cnb/linux-x64-baseline-glibc2.17"
mkdir -p "$cache"
if ! mkdir "$cache/lock" 2>/dev/null; then echo 'CNB WSL worktree is locked' >&2; exit 1; fi
completed="$cache/completed/$key"
binary="$completed/omp-linux-x64"
marker="$completed/complete"
cleanup() {
  rm -f -- "$marker.tmp"
  rmdir "$cache/lock"
}
trap cleanup EXIT
ensure_source
started=$SECONDS
stored_key=
if [ -f "$marker" ]; then stored_key=$(<"$marker"); fi
if [ "$stored_key" = "$key" ] && [ -f "$binary" ] && [ -s "$binary" ]; then
  echo "Linux completed-binary cache hit (linux-x64-baseline-glibc2.17); native/package skipped; lookup elapsed: $((SECONDS - started))s"
else
  echo "Linux completed-binary cache miss (linux-x64-baseline-glibc2.17); lookup elapsed: $((SECONDS - started))s"
  mkdir -p "$completed"
  rm -f -- "$marker" "$binary"
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/omp-cargo-target}"
  export OMP_RELEASE_NATIVE_DIR="$cache/native"
  export OMP_RELEASE_BINARY_DIR="$completed"
  export OMP_BUILD_CACHE_DIR="$cache/build-assets"
  started=$SECONDS
  bun install --frozen-lockfile
  echo "Linux dependencies elapsed: $((SECONDS - started))s"
  started=$SECONDS
  bun scripts/build-release-native.ts
  echo "Linux native elapsed: $((SECONDS - started))s"
  started=$SECONDS
  bun scripts/ci-release-build-binaries.ts --targets linux-x64
  echo "Linux package elapsed: $((SECONDS - started))s"
  if [ ! -f "$binary" ] || [ ! -s "$binary" ]; then
    echo 'Linux packaging did not produce a non-empty binary' >&2
    exit 1
  fi
  ensure_source
  printf '%s' "$key" > "$marker.tmp"
  mv -- "$marker.tmp" "$marker"
fi
started=$SECONDS
cp -- "$binary" "$out"
echo "Linux upload staging elapsed: $((SECONDS - started))s"
