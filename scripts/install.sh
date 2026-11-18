#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --binary       Install prebuilt binary (default)
#   --ref <tag>    Install a specific published release
#   -r <tag>      Shorthand for --ref

REPO="jchanghong023/oh-my-pi"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"

# Standalone bootstrap diagnostics: no Bun/omp dependency, no command output or
# untrusted release text. Fixed-size events bound each attempt; keep at most 20
# completed attempts within the same five-day window as application logs.
install_now_ms() {
    value="$(date +%s%3N 2>/dev/null)" || value=""
    case "$value" in
        ""|*[!0-9]*) value="$(date +%s 2>/dev/null)000" ;;
    esac
    case "$value" in ""|*[!0-9]*) value=0 ;; esac
    printf '%s\n' "$value"
}
INSTALL_STARTED_MS="$(install_now_ms)"
INSTALL_OPERATION_ID="install-${INSTALL_STARTED_MS}-$$"
INSTALL_STAGE=arguments
INSTALL_STAGE_MS="$INSTALL_STARTED_MS"
INSTALL_RESULT=success
INSTALL_PLATFORM=unknown
INSTALL_VERSION=unspecified
INSTALL_LOG=""
TMP_BINARY=""

install_log_emit() (
    # A subshell prevents diagnostics from changing caller state or exit status.
    [ -n "$INSTALL_LOG" ] || exit 0
    now="$(install_now_ms)"
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null)" || timestamp=""
    case "$timestamp" in
        ""|*N*) timestamp="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null)" ;;
    esac
    elapsed=$((now - INSTALL_STAGE_MS))
    [ "$elapsed" -ge 0 ] || elapsed=0
    if ! { printf 'timestamp=%s level=%s pid=%s component=installer event=%s message=%s operation_id=%s stage=%s elapsed_ms=%s platform=%s target_version=%s %s\n' \
        "$timestamp" "$1" "$$" "$2" "$2" "$INSTALL_OPERATION_ID" "$INSTALL_STAGE" "$elapsed" \
        "$INSTALL_PLATFORM" "$INSTALL_VERSION" "${3:-}" >> "$INSTALL_LOG"; } 2>/dev/null; then
        exit 1
    fi
    exit 0
)

install_log() {
    if ! install_log_emit "$@"; then
        INSTALL_LOG=""
        printf '%s\n' 'omp installer: diagnostic log writing unavailable; continuing without file logging.' >&2 || :
    fi
    return 0
}

install_log_name_valid() {
    log_candidate="${1##*/}"
    case "$log_candidate" in
        omp.install.[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].*.log) ;;
        *) return 1 ;;
    esac
    log_fields="${log_candidate#omp.install.??????????.}"
    log_epoch="${log_fields%%.*}"
    log_pid="${log_fields#*.}"
    log_pid="${log_pid%.log}"
    case "$log_epoch" in ""|*[!0-9]*) return 1 ;; esac
    case "$log_pid" in ""|*[!0-9]*) return 1 ;; esac
}

install_log_init() {
    log_root="$HOME/${PI_CONFIG_DIR:-.omp}"
    explicit_root=false
    expanded_root="$(printf '%s' "${OMP_CONFIG_ROOT:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$expanded_root" in
        "~") expanded_root="$HOME" ;;
        "~/"*) expanded_root="$HOME/${expanded_root#??}" ;;
    esac
    case "$expanded_root" in /*) log_root="$expanded_root"; explicit_root=true ;; esac
    log_profile="$(printf '%s' "${OMP_PROFILE-${PI_PROFILE:-}}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    # Invalid profile input must not make a bootstrap install fail.
    case "$log_profile" in
        ""|default) log_profile="" ;;
        *[!a-z0-9._-]*|[!a-z0-9]*|*.) log_profile="" ;;
    esac
    [ "${#log_profile}" -le 64 ] || log_profile=""
    profile_base="${log_profile%%.*}"
    case "$profile_base" in con|prn|aux|nul|com[0-9]|lpt[0-9]) log_profile="" ;; esac
    profile_suffix=""
    [ -z "$log_profile" ] || profile_suffix="/profiles/$log_profile"
    if [ "$explicit_root" = false ] && [ -n "${XDG_STATE_HOME:-}" ] && [ -d "${XDG_STATE_HOME}/omp${profile_suffix}" ]; then
        log_root="${XDG_STATE_HOME}/omp"
    fi
    cache_root="$(printf '%s' "${OMP_CACHE_DIR:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$cache_root" in
        "~") cache_root="$HOME" ;;
        "~/"*) cache_root="$HOME/${cache_root#??}" ;;
        "~\\"*) cache_root="$HOME${cache_root#?}" ;;
    esac
    case "$cache_root" in /*) ;; *) cache_root="" ;; esac
    if [ -z "$cache_root" ]; then
        offline_value="$(printf '%s' "${OMP_OFFLINE:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
        case "$offline_value" in
            1|true|yes|on)
                if [ "$(uname -s 2>/dev/null)" = Linux ]; then
                    cache_root="/dev/shm/omp-$(id -u)"
                    mkdir -m 700 "$cache_root" 2>/dev/null || :
                fi
                ;;
        esac
    elif [ "$(uname -s 2>/dev/null)" = Linux ]; then
        cache_root="${cache_root%/}/$(id -u)"
    fi
    log_name="omp.install.$(date -u +%Y-%m-%d 2>/dev/null).${INSTALL_STARTED_MS}.$$.log"
    log_fallback=false
    if [ -n "$cache_root" ]; then
        set -- "$cache_root$profile_suffix/logs" "$log_root$profile_suffix/logs" "$HOME/.local/state/omp$profile_suffix/logs"
    else
        set -- "$log_root$profile_suffix/logs" "$HOME/.local/state/omp$profile_suffix/logs"
    fi
    for log_dir; do
        if { mkdir -p "$log_dir" && (umask 077; : >> "$log_dir/$log_name"); } 2>/dev/null; then
            INSTALL_LOG="$log_dir/$log_name"
            break
        fi
        log_fallback=true
    done
    if [ -z "$INSTALL_LOG" ]; then
        printf '%s\n' 'omp installer: diagnostic log directories unavailable; continuing without file logging.' >&2
        return 0
    fi
    # Only installer logs are eligible, never application logs or live attempts.
    (
        count=0
        for old in "$log_dir"/omp.install.*.log; do
            [ -f "$old" ] && install_log_name_valid "$old" && count=$((count + 1))
        done
        for old in "$log_dir"/omp.install.*.log; do
            [ -f "$old" ] || continue
            install_log_name_valid "$old" || continue
            old_pid="${old%.log}"; old_pid="${old_pid##*.}"
            case "$old_pid" in ""|*[!0-9]*) continue ;; esac
            kill -0 "$old_pid" 2>/dev/null && continue
            if [ "$count" -gt 20 ] || [ -n "$(find "$old" -mtime +4 -print 2>/dev/null)" ]; then
                if rm -f "$old" 2>/dev/null; then count=$((count - 1)); fi
            fi
        done
        exit 0
    ) || :
    if [ "$log_fallback" = true ]; then install_log WARN log_directory_fallback 'result=fallback'; fi
}

install_finish() {
    install_exit="$1"
    if [ -n "$TMP_BINARY" ]; then
        if rm -f "$TMP_BINARY"; then
            install_log INFO cleanup_completed 'target=candidate result=removed'
        else
            install_log WARN cleanup_failed 'target=candidate result=retained'
        fi
    fi
    if [ "$install_exit" -ne 0 ] && [ "$INSTALL_RESULT" != cancelled ]; then
        install_log ERROR stage_failed "result=failed exit_code=$install_exit"
        INSTALL_RESULT=failed
    fi
    INSTALL_STAGE_MS="$INSTALL_STARTED_MS"
    if [ "$INSTALL_RESULT" = failed ]; then
        install_log ERROR install_failed "result=failed exit_code=$install_exit"
    elif [ "$INSTALL_RESULT" = cancelled ]; then
        install_log INFO install_cancelled "result=cancelled exit_code=$install_exit"
    else
        install_log INFO install_completed "result=$INSTALL_RESULT exit_code=$install_exit"
    fi
}
install_log_init || :
trap 'install_finish "$?"' EXIT
trap 'INSTALL_RESULT=cancelled; exit 130' INT
trap 'INSTALL_RESULT=cancelled; exit 143' TERM
install_log INFO install_started 'result=started version_selection=pending'

# Accept only a bounded release-version identifier in diagnostic fields.
install_log_version() {
    INSTALL_VERSION=redacted
    # grep anchors apply per line; reject control characters before matching.
    case "$1" in *[!v0-9.+fork]*) return 0 ;; esac
    if [ "${#1}" -le 64 ] && printf '%s\n' "$1" | LC_ALL=C grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(\+fork\.[0-9]+)?$'; then
        INSTALL_VERSION="$1"
    fi
    return 0
}

# curl codes classify HTTP/network failures without copying error/body text.
install_curl_failed() {
    case "$1" in
        22) kind=http ;;
        28) kind=timeout ;;
        6) kind=dns ;;
        7) kind=connect ;;
        35|60) kind=tls ;;
        *) kind=network ;;
    esac
    install_log ERROR http_request_failed "result=failed curl_exit=$1 error_type=$kind http_status=${3:-unavailable} endpoint=$2"
}

# Parse arguments
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --binary)
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
install_log_version "${REF:-}"
INSTALL_STAGE=platform
INSTALL_STAGE_MS="$(install_now_ms)"

# This fork supports Linux only through the POSIX installer.
if [ "$(uname -s)" = "Darwin" ]; then
    echo "macOS is not supported by this fork."
    exit 1
fi


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
    case "$installed_output" in
        omp/*) ;;
        *) return 1 ;;
    esac
    installed_version=${installed_output#omp/}
    installed_version=${installed_version%% *}
    [ "$installed_version" = "${1#v}" ]
}


# Detect sessions using the installed Linux binary before atomically replacing
# its directory entry. Existing processes keep their old inode and must never
# be terminated by the installer.
warn_running_omp() {
    OMP_PROCESS_DETECTION_AVAILABLE=false
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
            install_log WARN executable_path_fallback 'target=installed result=directory_resolution'
            INSTALL_OMP="$(CDPATH= cd -- "$INSTALL_DIR" 2>/dev/null && pwd -P)/omp"
        else
            INSTALL_OMP="${INSTALL_DIR}/omp"
            install_log WARN executable_path_fallback 'target=installed result=literal_path'
        fi
    else
        INSTALL_OMP="${INSTALL_DIR}/omp"
    fi

    if [ -d /proc ]; then
        OMP_PROCESS_DETECTION_AVAILABLE=true
        for EXE in /proc/[0-9]*/exe; do
            [ -r "$EXE" ] || continue
            EXE_PATH="$(readlink -f "$EXE" 2>/dev/null)" || EXE_PATH="$(readlink "$EXE" 2>/dev/null)" || continue
            # A binary replaced by a previous install resolves to
            # "/path/omp (deleted)" for the process still holding the old inode.
            case "$EXE_PATH" in
                *" (deleted)") EXE_PATH="${EXE_PATH% (deleted)}" ;;
            esac
            [ "$EXE_PATH" = "$INSTALL_OMP" ] || continue
            PID="${EXE#/proc/}"
            PIDS="$PIDS ${PID%/exe}"
        done
    fi

    [ -z "$PIDS" ] && return 0
    echo ""
    echo "⚠ Running omp sessions detected at ${INSTALL_OMP} (PIDs:${PIDS})."
    echo "  They will continue using the old inode and old version after this atomic update."
    echo "  Exit and restart those sessions to use the new version; there is no need to force-end current work."
}

# Normalize Linux host architecture to the release asset name.
host_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Report the command PATH actually resolves, or how to reach the installed binary.
report_path_hint() {
    # An omp earlier on PATH keeps winning until removed or INSTALL_DIR moves ahead.
    ACTIVE_OMP="$(command -v omp 2>/dev/null || true)"
    if [ -n "$ACTIVE_OMP" ] && ! [ "$ACTIVE_OMP" -ef "${INSTALL_DIR}/omp" ]; then
        echo "'omp' still resolves to ${ACTIVE_OMP}; remove that install or put ${INSTALL_DIR} ahead of it on PATH."
        return
    fi

    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

# Read only the top-level tag and the named asset in the top-level assets array.
# Scan JSON tokens so nesting, escaped text, and formatting cannot spoof fields.
release_asset_metadata() {
    LC_ALL=C awk -v binary="$1" '
        function next_token(    first) {
            sub(/^[ \t\r\n]+/, "", json)
            first = substr(json, 1, 1)
            if (first == "" || index("{}[],:", first)) {
                token = first
            } else if (match(json, /^"([^"\\[:cntrl:]]|\\(["\\\/bfnrt]|u[[:xdigit:]][[:xdigit:]][[:xdigit:]][[:xdigit:]]))*"/) ||
                       match(json, /^(-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)/)) {
                token = substr(json, 1, RLENGTH)
            } else {
                exit 1
            }
            json = substr(json, length(token) + 1)
        }

        function value(scope, depth,    key, child, names, digests, name, digest) {
            if (depth > 64 || (scope == "release" && token != "{")) exit 1
            if ((scope == "assets" && token != "[") || (scope == "asset" && token != "{"))
                invalid_assets = 1
            if (token == "{") {
                next_token()
                if (token != "}") {
                    while (1) {
                        # GitHub emits literal keys. Reject escaped aliases.
                        if (token !~ /^"[^\\]*"$/) exit 1
                        key = substr(token, 2, length(token) - 2)
                        next_token()
                        if (token != ":") exit 1
                        next_token()
                        child = ""
                        if (scope == "release" && key == "tag_name") {
                            tags++
                            if (token ~ /^"[^\\[:space:]]+"$/)
                                tag = substr(token, 2, length(token) - 2)
                        } else if (scope == "release" && key == "assets") {
                            asset_arrays++
                            child = "assets"
                        } else if (scope == "asset" && key == "name") {
                            names++
                            if (token ~ /^"[^\\]+"$/)
                                name = substr(token, 2, length(token) - 2)
                        } else if (scope == "asset" && key == "digest") {
                            digests++
                            if (length(token) == 73 && token ~ /^"sha256:[[:xdigit:]]+"$/)
                                digest = tolower(substr(token, 9, 64))
                        }
                        value(child, depth + 1)
                        if (token == "}") break
                        if (token != ",") exit 1
                        next_token()
                    }
                }
                if (scope == "asset") {
                    if (names != 1 || name == "") invalid_assets = 1
                    if (name == binary) {
                        matches++
                        if (digests == 1) asset_digest = digest
                    }
                }
            } else if (token == "[") {
                next_token()
                if (token != "]") {
                    while (1) {
                        value(scope == "assets" ? "asset" : "", depth + 1)
                        if (token == "]") break
                        if (token != ",") exit 1
                        next_token()
                    }
                }
            } else if (token == "" || index("}],:", token)) {
                exit 1
            }
            next_token()
        }

        { json = json $0 "\n" }
        END {
            next_token()
            value("release", 0)
            if (token != "" || tags != 1 || tag == "") exit 1
            if (invalid_assets || asset_arrays != 1 || matches != 1) asset_digest = ""
            print tag, asset_digest
        }
    '
}

# Install binary from the fork's published GitHub Releases
install_binary() {

    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux) PLATFORM="linux" ;;
        *) echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)     echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="omp-${PLATFORM}-${ARCH}"
    INSTALL_PLATFORM="${PLATFORM}-${ARCH}"
    install_log INFO platform_selected 'result=selected'
    INSTALL_STAGE=release_metadata
    INSTALL_STAGE_MS="$(install_now_ms)"
    if [ -d "${INSTALL_DIR}/omp" ]; then
        echo "Refusing to replace a directory at ${INSTALL_DIR}/omp" >&2
        exit 1
    fi
    # Fetch metadata only from the authenticated GitHub API endpoint.
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        RELEASE_ENDPOINT=release_tag
        case "$REF" in
            .|*..*) echo "Invalid release tag: $REF" >&2; exit 1 ;;
        esac
        REF_PATH="$(printf '%s' "$REF" | sed 's/%/%25/g; s|/|%2F|g; s/?/%3F/g; s/#/%23/g; s/\\/%5C/g')"
        RELEASE_URL="https://api.github.com/repos/${REPO}/releases/tags/${REF_PATH}"
    else
        echo "Fetching latest release..."
        RELEASE_ENDPOINT=release_latest
        RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"
    fi
    install_log INFO http_request_started "method=GET host=api.github.com endpoint=$RELEASE_ENDPOINT timeout_ms=60000 attempt=1"
    # -q must be the first option to ignore .curlrc. Do not follow redirects.
    if RELEASE_RESPONSE=$(curl -q -fgsS --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --write-out '\n%{http_code}' "$RELEASE_URL"); then
        RELEASE_HTTP_STATUS="${RELEASE_RESPONSE##*
}"
        if [ "$RELEASE_HTTP_STATUS" != 200 ]; then
            install_log ERROR http_request_failed "result=failed error_type=http http_status=$RELEASE_HTTP_STATUS endpoint=$RELEASE_ENDPOINT"
            echo "Failed to fetch release metadata (expected HTTP 200, got $RELEASE_HTTP_STATUS)." >&2
            exit 1
        fi
        install_log INFO http_request_completed "result=success host=api.github.com endpoint=$RELEASE_ENDPOINT http_status=$RELEASE_HTTP_STATUS"
    else
        release_exit="$?"
        RELEASE_HTTP_STATUS="${RELEASE_RESPONSE##*
}"
        install_curl_failed "$release_exit" "$RELEASE_ENDPOINT" "$RELEASE_HTTP_STATUS"
        if [ -n "$REF" ] && [ "$release_exit" -eq 22 ] && [ "$RELEASE_HTTP_STATUS" = 404 ]; then
            echo "Release tag not found: $REF" >&2
            echo "Only published release tags are supported." >&2
        else
            echo "Failed to fetch release metadata (curl exit $release_exit, HTTP $RELEASE_HTTP_STATUS)." >&2
        fi
        exit "$release_exit"
    fi
    RELEASE_JSON="${RELEASE_RESPONSE%
*}"
    if ! RELEASE_META=$(printf '%s\n' "$RELEASE_JSON" | release_asset_metadata "$BINARY"); then
        install_log ERROR release_metadata_invalid 'result=invalid_tag_or_json'
        echo "Failed to read the release tag from GitHub metadata." >&2
        exit 1
    fi
    LATEST="${RELEASE_META%% *}"
    EXPECTED_DIGEST="${RELEASE_META#* }"

    if [ -n "$REF" ] && [ "$LATEST" != "$REF" ]; then
        install_log ERROR release_metadata_invalid 'result=unexpected_tag'
        echo "GitHub metadata did not match the requested release tag." >&2
        exit 1
    fi
    echo "Using version: $LATEST"
    install_log_version "$LATEST"
    install_log INFO release_selected 'result=selected'
    INSTALL_STAGE=installed_version
    INSTALL_STAGE_MS="$(install_now_ms)"
    install_log INFO binary_probe_started 'target=installed argument=version'

    if installed_binary_matches "$LATEST"; then
        install_log INFO binary_probe_completed 'target=installed result=matches'
        INSTALL_RESULT=already_installed
        echo "omp $LATEST is already installed at ${INSTALL_DIR}/omp"
        report_path_hint
        return
    fi
    install_log INFO binary_probe_completed 'target=installed result=absent_or_mismatch'
    INSTALL_STAGE=prepare_candidate
    INSTALL_STAGE_MS="$(install_now_ms)"

    if [ -z "$EXPECTED_DIGEST" ]; then
        install_log ERROR release_metadata_invalid 'result=invalid_asset_digest'
        echo "Missing, invalid, or ambiguous SHA-256 digest for ${BINARY} in GitHub release metadata." >&2
        exit 1
    fi
    if ! command -v sha256sum >/dev/null 2>&1; then
        echo "sha256sum is required to verify the downloaded omp binary." >&2
        exit 1
    fi

    # Keep compatibility flags on the asset download only. --ssl-no-revoke
    # requires curl 7.44 or newer and only applies to Schannel.
    CURL_INFO="$(curl --version 2>/dev/null)" || CURL_INFO=""
    CURL_VERSION="$(printf '%s\n' "$CURL_INFO" | awk 'NR==1 {print $2}')"
    CURL_VERSION="${CURL_VERSION%%-*}"
    CURL_SSL_NO_REVOKE=""
    case "$CURL_INFO" in
        *Schannel*)
            if [ -n "$CURL_VERSION" ] && version_ge "$CURL_VERSION" "7.44.0"; then
                CURL_SSL_NO_REVOKE="--ssl-no-revoke"
            fi
            ;;
    esac

    # Fresh installs may not have the target directory yet; create it before
    # writing the temporary download or the final binary.
    mkdir -p "$INSTALL_DIR"

    # Download to a same-directory temp file first so a failed download keeps
    # the old install working. rename(2) atomically replaces the directory entry
    # while any running Linux process safely retains the old inode.
    TMP_BINARY="$(mktemp "${INSTALL_DIR}/.omp.tmp.XXXXXX")"
    install_log INFO candidate_created 'result=created'
    # Download binary. --progress-bar shows a live bar with speed on a TTY;
    # without -s, curl also prints the concrete failure reason (HTTP status or
    # network error) itself, which we augment with URL and target below.
    #
    # Prefer --fail-with-body (curl >= 7.76) so an HTTP error keeps the server's
    # response body; --fail discards it. Fall back to --fail when the version
    # cannot be probed.
    if [ -n "$CURL_VERSION" ] && version_ge "$CURL_VERSION" "7.76.0"; then
        CURL_FAIL_FLAG="--fail-with-body"
    else
        CURL_FAIL_FLAG="-f"
    fi
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    INSTALL_STAGE=download
    INSTALL_STAGE_MS="$(install_now_ms)"
    install_log INFO http_request_started 'method=GET host=github.com endpoint=release_asset connect_timeout_ms=10000 low_speed_timeout_ms=30000 attempt=1'
    if curl "$CURL_FAIL_FLAG" -L --insecure $CURL_SSL_NO_REVOKE --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar "$BINARY_URL" -o "$TMP_BINARY"; then
        install_log INFO http_request_completed 'result=success host=github.com endpoint=release_asset http_status=success'
    else
        install_curl_failed "$?" release_asset
        echo ""
        echo "✗ Download failed" >&2
        echo "  URL:    ${BINARY_URL}" >&2
        echo "  Target: ${INSTALL_DIR}/omp" >&2
        exit 1
    fi
    INSTALL_STAGE=verify_candidate
    INSTALL_STAGE_MS="$(install_now_ms)"
    if ! CHECKSUM="$(sha256sum < "$TMP_BINARY")" || [ "${CHECKSUM%% *}" != "$EXPECTED_DIGEST" ]; then
        install_log ERROR candidate_digest_failed 'result=failed'
        echo "SHA-256 verification failed for ${BINARY}; the existing installation was not changed." >&2
        exit 1
    fi
    install_log INFO candidate_digest_verified 'result=matches'
    INSTALL_STAGE=prepare_executable
    INSTALL_STAGE_MS="$(install_now_ms)"
    chmod +x "$TMP_BINARY"
    warn_running_omp
    install_log INFO executable_prepared 'result=success process_detection=completed'
    INSTALL_STAGE=candidate_startup
    INSTALL_STAGE_MS="$(install_now_ms)"
    install_log INFO binary_probe_started 'target=candidate argument=version'

    # Verify the downloaded binary can actually start before replacing the
    # installed one. Bun's musl-target binaries link libstdc++/libgcc
    # dynamically, which stock Alpine/musl systems do not ship, so the download
    # succeeds while the binary exits 127 with relocation errors. Smoking the
    # temp binary first keeps the previous install working when the new one
    # cannot run.
    if SMOKE_OUTPUT="$("$TMP_BINARY" --version 2>&1)"; then
        install_log INFO binary_probe_completed 'target=candidate result=started exit_code=0'
    else
        install_log ERROR binary_probe_failed "target=candidate result=failed exit_code=$?"
        echo ""
        echo "✗ The downloaded omp binary cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run the installer:"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi
    INSTALL_STAGE=candidate_version
    INSTALL_STAGE_MS="$(install_now_ms)"
    case "$SMOKE_OUTPUT" in
        omp/*) SMOKE_VERSION=${SMOKE_OUTPUT#omp/} ;;
        *) SMOKE_VERSION="" ;;
    esac
    SMOKE_VERSION=${SMOKE_VERSION%% *}
    if [ "$SMOKE_VERSION" != "${LATEST#v}" ]; then
        install_log ERROR binary_version_failed 'target=candidate result=mismatch'
        echo "Downloaded binary reports an unexpected version: $SMOKE_OUTPUT" >&2
        echo "Expected: ${LATEST#v}; existing install was not changed." >&2
        exit 1
    fi
    install_log INFO binary_version_completed 'target=candidate result=matches'
    INSTALL_STAGE=atomic_replace
    INSTALL_STAGE_MS="$(install_now_ms)"
    install_log INFO atomic_replace_started 'target=installed strategy=rename result=started'

    mv -f "$TMP_BINARY" "${INSTALL_DIR}/omp"
    TMP_BINARY=""
    install_log INFO atomic_replace_completed 'target=installed result=success'

    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"
    if [ "$OMP_PROCESS_DETECTION_AVAILABLE" != "true" ]; then
        echo "Existing omp sessions may still use the previous version; exit and restart them to use this update."
    fi

    report_path_hint
}

# This installer only downloads published release binaries.
install_binary
