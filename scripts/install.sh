#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="jchanghong023/oh-my-pi"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done


# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

# True when the binary at the install target already matches a release tag.
# `omp --version` starts with `omp/<version>` and release tags start with `v`.
installed_binary_matches() {
    target="${INSTALL_DIR}/omp"
    [ -x "$target" ] || return 1
    installed_output=$("$target" --version 2>/dev/null) || return 1
    installed_version=${installed_output#omp/}
    installed_version=${installed_version%% *}
    [ "$installed_version" = "${1#v}" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install the fork source via bun
install_via_bun() {
    echo "Installing via bun..."
    if ! has_git; then
        echo "git is required when installing from source"
        exit 1
    fi

    SOURCE_REF="${REF:-main}"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    if git clone --depth 1 --branch "$SOURCE_REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
        :
    else
        git clone "https://github.com/${REPO}.git" "$TMP_DIR"
        (cd "$TMP_DIR" && git checkout "$SOURCE_REF")
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$TMP_DIR" && git lfs pull)
    fi

    if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${TMP_DIR}/packages/coding-agent"
        exit 1
    fi

    bun install -g "$TMP_DIR/packages/coding-agent" || {
        echo "Failed to install from source"
        exit 1
    }
    echo ""
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
}

# Stop a running omp so the installed binary can be replaced. Directly
# overwriting an executing ELF fails with ETXTBSY (curl error 23), and Windows
# locks running executables outright, so both installers stop the old process
# first. Match by resolved executable so PATH-launched instances whose argv is
# just "omp" are found too.
stop_running_omp() {
    PIDS=""
    # Resolve the install target's real path so a symlinked $INSTALL_DIR (e.g.
    # $HOME/.local) still matches the canonical /proc/<pid>/exe of a running
    # omp. readlink -f is GNU-only (macOS/BSD lack -f), so fall back to a POSIX
    # cd + pwd -P on the directory. On a fresh install the binary may not exist
    # yet, in which case keep the literal path.
    if [ -e "${INSTALL_DIR}/omp" ]; then
        if INSTALL_OMP="$(readlink -f "${INSTALL_DIR}/omp" 2>/dev/null)"; then
            :
        elif [ -d "$INSTALL_DIR" ]; then
            INSTALL_OMP="$(CDPATH= cd -- "$INSTALL_DIR" 2>/dev/null && pwd -P)/omp"
        else
            INSTALL_OMP="${INSTALL_DIR}/omp"
        fi
    else
        INSTALL_OMP="${INSTALL_DIR}/omp"
    fi

    if [ -d /proc ]; then
        for EXE in /proc/[0-9]*/exe; do
            [ -r "$EXE" ] || continue
            EXE_PATH="$(readlink -f "$EXE" 2>/dev/null)" || EXE_PATH="$(readlink "$EXE" 2>/dev/null)" || continue
            [ "$EXE_PATH" = "$INSTALL_OMP" ] || continue
            PID="${EXE#/proc/}"
            PIDS="$PIDS ${PID%/exe}"
        done
    elif command -v pgrep >/dev/null 2>&1; then
        PIDS="$(pgrep -f "${INSTALL_DIR}/omp" 2>/dev/null || true) $(pgrep -x omp 2>/dev/null || true)"
    fi
    [ -z "$PIDS" ] && return 0

    echo "Stopping running omp..."
    # TERM first, escalate to KILL after a short grace period.
    kill $PIDS 2>/dev/null || true
    # busybox built without FEATURE_FLOAT_SLEEP rejects fractional sleep under
    # set -e, so probe once and fall back to a whole-second poll on such systems.
    if sleep 0.1 2>/dev/null; then
        SLEEP_INTERVAL="0.1"
    else
        SLEEP_INTERVAL="1"
    fi
    i=0
    while [ "$i" -lt 100 ]; do
        REMAIN=""
        for PID in $PIDS; do
            kill -0 "$PID" 2>/dev/null && REMAIN="$REMAIN $PID"
        done
        [ -z "$REMAIN" ] && return 0
        if [ "$i" -eq 30 ]; then
            kill -9 $REMAIN 2>/dev/null || true
        fi
        sleep "$SLEEP_INTERVAL"
        i=$((i + 1))
    done
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    if installed_binary_matches "$LATEST"; then
        echo "omp $LATEST is already installed at ${INSTALL_DIR}/omp"
        return
    fi

    # Fresh installs may not have the target directory yet; create it before
    # writing the temporary download or the final binary.
    mkdir -p "$INSTALL_DIR"

    # If a previous omp is still running, stop it before replacing the binary.
    # Download to a temp file first so a failed download keeps the old install
    # working; rename(2) then replaces the entry without touching any inode a
    # lingering process might still hold.
    TMP_BINARY="${INSTALL_DIR}/.omp.tmp.$$"
    trap 'rm -f "$TMP_BINARY"' EXIT
    # Download binary. --progress-bar shows a live bar with speed on a TTY;
    # without -s, curl also prints the concrete failure reason (HTTP status or
    # network error) itself, which we augment with URL and target below.
    #
    # Prefer --fail-with-body (curl >= 7.76) so an HTTP error keeps the server's
    # response body; --fail discards it. Fall back to --fail when the version
    # cannot be probed.
    CURL_VERSION="$(curl --version 2>/dev/null | awk 'NR==1 {print $2}')"
    CURL_VERSION="${CURL_VERSION%%-*}"
    if [ -n "$CURL_VERSION" ] && version_ge "$CURL_VERSION" "7.76.0"; then
        CURL_FAIL_FLAG="--fail-with-body"
    else
        CURL_FAIL_FLAG="-f"
    fi
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    if ! curl "$CURL_FAIL_FLAG" -L --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar "$BINARY_URL" -o "$TMP_BINARY"; then
        echo ""
        echo "✗ Download failed" >&2
        echo "  URL:    ${BINARY_URL}" >&2
        echo "  Target: ${INSTALL_DIR}/omp" >&2
        exit 1
    fi
    chmod +x "$TMP_BINARY"
    stop_running_omp
    mv -f "$TMP_BINARY" "${INSTALL_DIR}/omp"
    trap - EXIT

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/omp" --version 2>&1)"; then
        echo ""
        echo "✗ omp was downloaded to ${INSTALL_DIR}/omp but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    binary|"")
        install_binary
        ;;
esac
