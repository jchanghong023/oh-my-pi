#!/usr/bin/env bash
set -eu

heads=$(wslpath -u "$1")
out=$(wslpath -u "$2")
repo=$3
mode=$4
expected_bun=$5
cd "$repo"
actual_bun=$(bun --version)
if [ "$actual_bun" != "$expected_bun" ]; then
  echo "WSL Bun $actual_bun must match Windows Bun $expected_bun; install Bun $expected_bun before publishing." >&2
  exit 1
fi
python3 - "$heads" <<'PY'
import json, os, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as f:
    expected_heads = json.load(f)
def gitlinks(base):
    raw = subprocess.check_output(["git", "-C", base, "ls-files", "--stage", "-z"])
    return sorted(os.fsdecode(row.split(b"\t", 1)[1]) for row in raw.split(b"\0") if row.startswith(b"160000 "))
def source_heads(base, prefix=""):
    key = prefix[:-1] if prefix else "."
    result = {key: subprocess.check_output(["git", "-C", base, "rev-parse", "HEAD"], text=True).strip()}
    for link in gitlinks(base):
        result.update(source_heads(os.path.join(base, link), prefix + link + "/"))
    return result
if subprocess.check_output(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]):
    raise SystemExit("WSL working tree has uncommitted changes; refusing to build or overwrite them")
if source_heads(".") != expected_heads:
    raise SystemExit("Windows and WSL source or submodule commits differ; synchronize them explicitly before publishing")
PY
[ "$mode" = build ] || exit 0
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
  rm -rf -- "$backup/smoke-home"
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
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native -- --lockfile_mode=error
for file in "$repo/packages/coding-agent/binaries/omp-linux-x64" "$repo/packages/stats/src/embedded-client.generated.txt"; do
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Existing build output is not a regular file' >&2; exit 1; }
    mv -- "$file" "$backup/$(basename "$file")"
  fi
done
bun run ci:release:build-binaries --targets linux-x64
[ -s packages/coding-agent/binaries/omp-linux-x64 ] || exit 1
mkdir "$backup/smoke-home"
version=$(env HOME="$backup/smoke-home" XDG_CONFIG_HOME="$backup/smoke-home/config" XDG_DATA_HOME="$backup/smoke-home/data" XDG_CACHE_HOME="$backup/smoke-home/cache" OMP_CONFIG_ROOT="$backup/smoke-home/omp" OMP_CACHE_DIR="$backup/smoke-home/omp-cache" OMP_PROFILE= PI_PROFILE= PI_CONFIG_DIR= "$repo/packages/coding-agent/binaries/omp-linux-x64" --version)
case "$version" in omp/*) ;; *) echo 'Linux binary --version returned an unexpected result' >&2; exit 1;; esac
echo "Linux --version: $version"
smoke=$(env HOME="$backup/smoke-home" XDG_CONFIG_HOME="$backup/smoke-home/config" XDG_DATA_HOME="$backup/smoke-home/data" XDG_CACHE_HOME="$backup/smoke-home/cache" OMP_CONFIG_ROOT="$backup/smoke-home/omp" OMP_CACHE_DIR="$backup/smoke-home/omp-cache" OMP_PROFILE= PI_PROFILE= PI_CONFIG_DIR= "$repo/packages/coding-agent/binaries/omp-linux-x64" --smoke-test)
case "$smoke" in *'smoke-test: ok'*) ;; *) echo 'Linux binary smoke test did not report success' >&2; exit 1;; esac
echo 'Linux smoke-test: ok'
cp packages/coding-agent/binaries/omp-linux-x64 "$out"
