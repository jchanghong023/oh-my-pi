# OMP Coding Agent Installer for Windows
# Requires Windows PowerShell 5.1 or PowerShell 7+ (x64).
# Usage: irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref 'v18.0.6+fork.123'
#
# Web requests use Invoke-RestMethod plus Invoke-WebRequest -UseBasicParsing:
# the HTML parsing engine PowerShell 5.1 otherwise loads needs Internet
# Explorer, which is absent on current Windows builds and Server Core.

param(
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

# Bootstrap-only diagnostics. These scripts cannot depend on Bun or an installed
# omp; use the application data-root conventions and a bounded per-attempt file.
$script:InstallStarted = [DateTimeOffset]::UtcNow
$script:InstallOperationId = "install-{0}-{1}-{2}" -f $script:InstallStarted.ToUnixTimeMilliseconds(), $PID, [Guid]::NewGuid().ToString("N")
$script:InstallStage = "initialization"
$script:InstallStageStarted = $script:InstallStarted
$script:InstallLogPath = $null
$script:InstallTerminalLogged = $false
$script:InstallPlatform = "windows-unknown"
$script:InstallVersion = "unspecified"

function Write-InstallLog {
    param([string]$Level, [string]$Event, [hashtable]$Fields = @{})
    if (-not $script:InstallLogPath) { return }
    try {
        $now = [DateTimeOffset]::UtcNow
        $record = [ordered]@{
            timestamp = $now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
            level = $Level
            pid = $PID
            component = "installer"
            event = $Event
            message = $Event
            operation_id = $script:InstallOperationId
            stage = $script:InstallStage
            elapsed_ms = [Math]::Max(0, [long]($now - $script:InstallStageStarted).TotalMilliseconds)
            platform = $script:InstallPlatform
            target_version = $script:InstallVersion
        }
        foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
        [IO.File]::AppendAllText($script:InstallLogPath, (($record | ConvertTo-Json -Compress -Depth 3) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    } catch {
        $script:InstallLogPath = $null
        try { [Console]::Error.WriteLine("omp installer: diagnostic log writing unavailable; continuing without file logging.") } catch {}
    }
}

function Initialize-InstallLog {
    try {
        $homeDir = [Environment]::GetFolderPath("UserProfile")
        $configDir = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { ".omp" }
        $root = Join-Path $homeDir $configDir
        $explicitRoot = $env:OMP_CONFIG_ROOT
        if ($explicitRoot -eq "~") { $explicitRoot = $homeDir }
        elseif ($explicitRoot -match '^~[/\\]') { $explicitRoot = Join-Path $homeDir $explicitRoot.Substring(2) }
        # IsPathRooted alone accepts drive-relative C:foo and root-relative \foo.
        if ($explicitRoot -match '^(?:[A-Za-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)') { $root = $explicitRoot }
        $profile = if (Test-Path Env:OMP_PROFILE) { $env:OMP_PROFILE } else { $env:PI_PROFILE }
        if ($profile) { $profile = $profile.Trim() }
        if ($profile -and $profile -ne "default" -and $profile -cmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -and
            $profile -notmatch '\.$|^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') {
            $root = Join-Path (Join-Path $root "profiles") $profile
            $profileSuffix = "profiles\$profile\logs"
        } else { $profileSuffix = "logs" }
        $fallbackRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "omp" } else { Join-Path $homeDir ".omp" }
        $name = "omp.install.{0}.{1}.{2}.log" -f $script:InstallStarted.ToString("yyyy-MM-dd"), $script:InstallStarted.ToUnixTimeMilliseconds(), $PID
        $fallback = $false
        foreach ($directory in @((Join-Path $root "logs"), (Join-Path $fallbackRoot $profileSuffix))) {
            try {
                [IO.Directory]::CreateDirectory($directory) | Out-Null
                $logPath = Join-Path $directory $name
                [IO.File]::AppendAllText($logPath, "", (New-Object Text.UTF8Encoding($false)))
                $script:InstallLogPath = $logPath
                break
            } catch { $fallback = $true }
        }
        if (-not $script:InstallLogPath) {
            [Console]::Error.WriteLine("omp installer: diagnostic log directories unavailable; continuing without file logging.")
            return
        }
        if ($fallback) { Write-InstallLog WARN log_directory_fallback @{ result = "fallback" } }
        # Only our bootstrap files; retain 20 completed attempts and five days.
        try {
            $logs = @(Get-ChildItem -LiteralPath $directory -Filter "omp.install.*.log" -File -ErrorAction Stop | Sort-Object Name -Descending)
            $removed = 0
            $retained = 0
            foreach ($file in $logs) {
                if ($file.Name -notmatch '^omp\.install\.\d{4}-\d{2}-\d{2}\.\d+\.(\d+)\.log$') { continue }
                if (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue) { continue }
                $retained++
                if ($retained -gt 20 -or $file.LastWriteTimeUtc -lt [DateTime]::UtcNow.Date.AddDays(-4)) {
                    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
                    $removed++
                }
            }
            Write-InstallLog INFO log_retention_completed @{ result = "success"; removed_count = $removed }
        } catch { Write-InstallLog WARN log_retention_failed @{ result = "partial" } }
    } catch {
        try { [Console]::Error.WriteLine("omp installer: diagnostic logging initialization unavailable; continuing installation.") } catch {}
    }
}

function Set-InstallStage {
    param([string]$Stage)
    $script:InstallStage = $Stage
    $script:InstallStageStarted = [DateTimeOffset]::UtcNow
}

function Set-InstallLogVersion {
    param([string]$Version)
    $script:InstallVersion = "redacted"
    if ($Version -cmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:\+fork\.[0-9]+)?$' -and $Version.Length -le 64) { $script:InstallVersion = $Version }
}

function Get-InstallFailureFields {
    param($Failure)
    # Never copy exception messages, error bodies, URLs or command stderr.
    $fields = @{ result = "failed"; error_type = "exception"; http_status = "unavailable" }
    try {
        $fields.error_type = $Failure.Exception.GetType().Name
        $fields.error_code = $Failure.Exception.HResult
        if ($Failure.InvocationInfo -and $Failure.InvocationInfo.ScriptLineNumber -gt 0) {
            $fields.source_file = "install.ps1"
            $fields.source_line = [int]$Failure.InvocationInfo.ScriptLineNumber
        }
        if ($Failure.Exception.Response -and $Failure.Exception.Response.StatusCode) {
            $fields.http_status = [int]$Failure.Exception.Response.StatusCode
        }
    } catch {}
    return $fields
}

function Complete-InstallLog {
    param([string]$Result, $Failure = $null)
    if ($script:InstallTerminalLogged) { return }
    if ($Failure -and $Failure.Exception -is [System.Management.Automation.PipelineStoppedException]) { $Result = "cancelled" }
    $script:InstallTerminalLogged = $true
    $fields = if ($Failure) { Get-InstallFailureFields $Failure } else { @{ result = $Result } }
    $fields.result = $Result
    $script:InstallStageStarted = $script:InstallStarted
    if ($Result -eq "failed") { Write-InstallLog ERROR install_failed $fields }
    elseif ($Result -eq "cancelled") { Write-InstallLog INFO install_cancelled $fields }
    else { Write-InstallLog INFO install_completed $fields }
}

Initialize-InstallLog
Write-InstallLog INFO install_started @{ result = "started"; version_selection = "pending" }
# Covers initialization failures before Install-Binary can establish its boundary.
trap { Complete-InstallLog "failed" $_; break }
Set-InstallStage "environment"

# Fail fast on hosts older than Windows PowerShell 5.1: cmdlets used below
# (e.g. Invoke-WebRequest -TimeoutSec) are missing or unreliable there and
# fail with cryptic errors halfway through the install. Anything newer,
# including PowerShell 7+, passes this check.
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Windows PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion)). Install PowerShell 7 from https://aka.ms/powershell and re-run the installer."
}

$Repo = "jchanghong023/oh-my-pi"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
# Read the OS architecture from environment variables for compatibility with Windows PowerShell 5.1 and PowerShell 7+.
# A 32-bit host on 64-bit Windows reports PROCESSOR_ARCHITEW6432; only x64 is supported.
$RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not $RawArchitecture) {
    throw "Unable to determine Windows architecture"
}
$NativeArchitecture = switch ($RawArchitecture.ToUpperInvariant()) {
    "AMD64" { "x64" }
    default { throw "Unsupported Windows architecture: $RawArchitecture. Only x64 is supported." }
}
$BinaryName = "omp-windows-x64.exe"
$script:InstallPlatform = "windows-$NativeArchitecture"
Set-InstallLogVersion $Ref
Write-InstallLog INFO platform_selected @{ result = "selected" }

# PowerShell 5.1 raises a terminating NativeCommandError for any line a native
# executable writes to stderr while $ErrorActionPreference is "Stop", regardless
# of the process exit code. `omp --version` and curl.exe both report progress on
# stderr, so run them with the preference relaxed to "Continue" and let callers
# gate on $LASTEXITCODE. Global "Stop" stays in effect for the cmdlet-driven
# operations (Invoke-WebRequest/Invoke-RestMethod) that depend on it.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command
    } finally {
        $ErrorActionPreference = $previous
    }
}

# PATH configuration shared by the install and repair paths.
function Set-InstallEnvironment {
    Set-InstallStage "environment"
    Write-InstallLog INFO environment_update_started @{ target = "user_path" }
    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    # Literal membership, not a wildcard match: an install dir containing `[`, `]`,
    # `*` or `?` would otherwise match a different PATH entry (or never match),
    # so the entry would be added on every run — or never added at all.
    $needsRestart = -not (($UserPath -split ";") -contains $InstallDir)
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        # A missing user PATH (or one ending in ";") must not produce an empty
        # entry: Windows resolves empty PATH entries as the current directory.
        $trimmedUserPath = "$UserPath".TrimEnd(";")
        if ($trimmedUserPath) {
            [Environment]::SetEnvironmentVariable("Path", "$trimmedUserPath;$InstallDir", "User")
        } else {
            [Environment]::SetEnvironmentVariable("Path", $InstallDir, "User")
        }
    }
    Write-InstallLog INFO environment_update_completed @{ result = "success"; changed = $needsRestart }

    return $needsRestart
}

# Windows locks a running executable. Stop only processes whose executable path
# matches the install target; unrelated omp.exe processes must remain untouched.
function Stop-RunningOmp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    Set-InstallStage "kill_fallback"
    Write-InstallLog WARN kill_fallback_started @{ target = "installed"; match_policy = "exact_executable_path"; timeout_ms = 10000 }
    $running = @(Get-Process -Name "omp" -ErrorAction SilentlyContinue)
    if (-not $running) {
        Write-InstallLog INFO kill_fallback_completed @{ result = "absent"; matched_count = 0 }
        return
    }

    $normalizedTarget = [System.IO.Path]::GetFullPath($TargetPath)
    $matching = @()
    $unreadableProcessIds = @()
    foreach ($process in $running) {
        try {
            $processPath = $process.Path
            if ([string]::IsNullOrWhiteSpace($processPath)) {
                throw "Executable path is unavailable."
            }
            $normalizedProcessPath = [System.IO.Path]::GetFullPath($processPath)
        } catch {
            Write-InstallLog WARN process_path_unavailable @{ peer_pid = $process.Id; result = "unreadable" }
            $unreadableProcessIds += $process.Id
            continue
        }

        if ([System.StringComparer]::OrdinalIgnoreCase.Equals($normalizedProcessPath, $normalizedTarget)) {
            $matching += $process
        }
    }

    if ($unreadableProcessIds) {
        Write-InstallLog ERROR kill_fallback_failed @{ result = "unsafe_identity"; unreadable_count = $unreadableProcessIds.Count }
        $processIds = $unreadableProcessIds -join ", "
        throw "Cannot safely identify running omp processes because their executable paths are unavailable (PIDs: $processIds)."
    }
    if (-not $matching) {
        Write-InstallLog INFO kill_fallback_completed @{ result = "no_matching_processes"; matched_count = 0 }
        return
    }

    $processIds = ($matching | ForEach-Object { $_.Id }) -join ", "
    Write-Host "[WARN] Force-stopping omp processes running from $normalizedTarget (PIDs: $processIds)." -ForegroundColor Yellow
    $stopErrors = @()
    $matching | Stop-Process -Force -ErrorAction SilentlyContinue -ErrorVariable +stopErrors
    $matching | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue -ErrorVariable +stopErrors
    if ($stopErrors.Count) {
        Write-InstallLog WARN kill_fallback_partial @{ result = "partial"; error_count = $stopErrors.Count; matched_count = $matching.Count }
    }

    $remaining = @($matching | Where-Object { -not $_.HasExited })
    if ($remaining) {
        Write-InstallLog ERROR kill_fallback_failed @{ result = "processes_remaining"; remaining_count = $remaining.Count }
        $processIds = ($remaining | ForEach-Object { $_.Id }) -join ", "
        throw "Failed to stop omp processes running from $normalizedTarget (PIDs: $processIds)."
    }
    Write-InstallLog INFO kill_fallback_completed @{ result = "stopped"; matched_count = $matching.Count }
}

# True when the binary at the install target already matches a release tag.
# `omp --version` starts with `omp/<version>` and release tags start with `v`.
function Test-InstalledBinaryVersion {
    param(
        [string]$TargetPath,
        [string]$ReleaseTag
    )

    $probeTarget = if ([IO.Path]::GetFileName($TargetPath).StartsWith(".omp.tmp.")) { "candidate" } else { "installed" }
    Set-InstallStage "${probeTarget}_version"
    Write-InstallLog INFO binary_probe_started @{ target = $probeTarget; argument = "version" }
    if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        Write-InstallLog INFO binary_probe_completed @{ target = $probeTarget; result = "absent" }
        return $false
    }

    try {
        $versionOutput = Invoke-Native { & $TargetPath --version 2>$null }
        $exitCode = $LASTEXITCODE
        $versionText = $versionOutput | Select-Object -First 1
        if ($exitCode -ne 0 -or $versionText -notmatch '^omp/(\S+)') {
            $probeLevel = if ($probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
            Write-InstallLog $probeLevel binary_probe_failed @{ target = $probeTarget; result = "invalid_or_failed"; exit_code = $exitCode }
            return $false
        }
        $matchesRelease = $Matches[1] -eq ($ReleaseTag -replace '^v', '')
        $probeLevel = if (-not $matchesRelease -and $probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
        Write-InstallLog $probeLevel binary_probe_completed @{ target = $probeTarget; result = $(if ($matchesRelease) { "matches" } else { "mismatch" }); exit_code = $exitCode }
        return $matchesRelease
    } catch {
        $probeLevel = if ($probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
        $fields = Get-InstallFailureFields $_
        $fields.target = $probeTarget
        Write-InstallLog $probeLevel binary_probe_failed $fields
        return $false
    }
}

function Install-Binary {
    try {
    Set-InstallStage "install_target"
    $OutPath = Join-Path $InstallDir "omp.exe"
    if (Test-Path -LiteralPath $OutPath -PathType Container) {
        throw "Refusing to replace a directory at $OutPath"
    }
    if ($Ref) {
        Set-InstallStage "release_metadata"
        Write-InstallLog INFO http_request_started @{ method = "GET"; host = "api.github.com"; endpoint = "release_tag"; timeout_ms = 60000; attempt = 1 }
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref" -TimeoutSec 60
        } catch {
            Write-InstallLog ERROR http_request_failed (Get-InstallFailureFields $_)
            throw "Release tag not found: $Ref`nOnly published release tags are supported."
        }
    } else {
        Write-Host "Fetching latest release..."
        Set-InstallStage "release_metadata"
        Write-InstallLog INFO http_request_started @{ method = "GET"; host = "api.github.com"; endpoint = "release_latest"; timeout_ms = 60000; attempt = 1 }
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 60
        } catch {
            Write-InstallLog ERROR http_request_failed (Get-InstallFailureFields $_)
            throw
        }
    }
    Write-InstallLog INFO http_request_completed @{ result = "success"; host = "api.github.com"; endpoint = "release_metadata"; http_status = "success" }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "missing_tag" }
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"
    Set-InstallLogVersion $Latest
    Write-InstallLog INFO release_selected @{ result = "selected" }

    if (Test-InstalledBinaryVersion -TargetPath $OutPath -ReleaseTag $Latest) {
        Write-Host "omp $Latest is already installed at $OutPath"
        # A previous update can leave its old image locked by a live session.
        # Retry cleanup even when no new download is needed.
        Clear-InstallAsides
        if (Set-InstallEnvironment) {
            Write-Host "Restart your terminal, then run 'omp' to get started!"
        }
        Complete-InstallLog "already_installed"
        return
    }

    Set-InstallStage "prepare_candidate"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Windows cannot overwrite omp.exe in place, but renaming the running
    # executable itself is permitted (only deleting its still-mapped image is
    # not — see replaceBinaryForUpdate). Download to a unique same-directory
    # temp file first so failed downloads leave the old install working, then
    # rename the old binary aside so live sessions keep running, move the new
    # one in, and roll back if that move fails. If the rename is blocked (e.g.
    # by antivirus), fall back to force-stopping only processes running the
    # install target. Prefer the in-box curl.exe (Windows 10 1803+) for a live
    # progress bar; fall back to Invoke-WebRequest when curl is unavailable or
    # fails.
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $TmpPath = Join-Path $InstallDir (".omp.tmp.{0}.{1}.exe" -f $PID, [System.Guid]::NewGuid().ToString("N"))
    $curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
    $curlExit = $null
    $renamedAside = $false
    $rollbackFailed = $false
    $hadExisting = $false
    try {
        if ($curlExe) {
            Set-InstallStage "download_curl"
            Write-InstallLog INFO http_request_started @{ method = "GET"; host = "github.com"; endpoint = "release_asset"; transport = "curl"; attempt = 1; connect_timeout_ms = 10000; low_speed_timeout_ms = 30000 }
            Invoke-Native { & $curlExe.Source -fL --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar $BinaryUrl -o $TmpPath }
            $curlExit = $LASTEXITCODE
            if ($curlExit -ne 0) {
                $kind = switch ($curlExit) { 22 { "http" }; 28 { "timeout" }; 6 { "dns" }; 7 { "connect" }; 35 { "tls" }; 60 { "tls" }; default { "network" } }
                Write-InstallLog WARN http_request_failed @{ result = "failed"; curl_exit = $curlExit; error_type = $kind; http_status = "unavailable"; endpoint = "release_asset"; transport = "curl"; attempt = 1 }
                $downloadCleanupErrors = @()
                Remove-Item -LiteralPath $TmpPath -Force -ErrorAction SilentlyContinue -ErrorVariable +downloadCleanupErrors
                $cleanupLevel = if ($downloadCleanupErrors.Count) { "WARN" } else { "INFO" }
                Write-InstallLog $cleanupLevel candidate_cleanup_completed @{ result = $(if ($downloadCleanupErrors.Count) { "partial" } else { "removed_or_absent" }); reason = "curl_fallback"; error_count = $downloadCleanupErrors.Count }
                Write-Host "[WARN] curl download failed (exit $curlExit); retrying with Invoke-WebRequest..." -ForegroundColor Yellow
            } else {
                Write-InstallLog INFO http_request_completed @{ result = "success"; endpoint = "release_asset"; transport = "curl"; attempt = 1; http_status = "success" }
            }
        }

        if (-not $curlExe -or $curlExit -ne 0) {
            Write-InstallLog WARN download_transport_fallback @{ result = "fallback"; from = "curl"; to = "Invoke-WebRequest"; reason = $(if ($curlExe) { "curl_failed" } else { "curl_absent" }) }
            Set-InstallStage "download_webrequest"
            Write-InstallLog INFO http_request_started @{ method = "GET"; host = "github.com"; endpoint = "release_asset"; transport = "Invoke-WebRequest"; timeout_ms = 900000; attempt = $(if ($curlExe) { 2 } else { 1 }) }
            try {
                Invoke-WebRequest -Uri $BinaryUrl -OutFile $TmpPath -TimeoutSec 900 -UseBasicParsing
                Write-InstallLog INFO http_request_completed @{ result = "success"; endpoint = "release_asset"; transport = "Invoke-WebRequest"; http_status = "success" }
            } catch {
                Write-InstallLog ERROR http_request_failed (Get-InstallFailureFields $_)
                $downloadCleanupErrors = @()
                Remove-Item -LiteralPath $TmpPath -Force -ErrorAction SilentlyContinue -ErrorVariable +downloadCleanupErrors
                $cleanupLevel = if ($downloadCleanupErrors.Count) { "WARN" } else { "INFO" }
                Write-InstallLog $cleanupLevel candidate_cleanup_completed @{ result = $(if ($downloadCleanupErrors.Count) { "partial" } else { "removed_or_absent" }); reason = "download_failed"; error_count = $downloadCleanupErrors.Count }
                $curlDetail = if ($curlExe) { "curl exit $curlExit`n" } else { "" }
                throw "Download failed: $BinaryUrl`n${curlDetail}Invoke-WebRequest: $($_.Exception.Message)"
            }
        }

        if (-not (Test-InstalledBinaryVersion -TargetPath $TmpPath -ReleaseTag $Latest)) {
            throw "The downloaded omp binary cannot start or does not report $Latest; the existing install was not changed."
        }

        $OldPath = Join-Path $InstallDir (".omp.old.{0}.exe" -f [System.Guid]::NewGuid().ToString("N"))
        Set-InstallStage "old_binary_rename"
        $hadExisting = Test-Path -LiteralPath $OutPath
        if ($hadExisting) {
            try {
                Write-InstallLog INFO old_binary_rename_started @{ target = "installed"; result = "started" }
                Move-Item -LiteralPath $OutPath -Destination $OldPath
                $renamedAside = $true
                Write-InstallLog INFO old_binary_rename_completed @{ result = "success"; old_image = "retained_aside" }
            } catch {
                Write-InstallLog WARN old_binary_rename_failed (Get-InstallFailureFields $_)
                Stop-RunningOmp -TargetPath $OutPath
                Set-InstallStage "fallback_remove"
                Write-InstallLog WARN old_binary_remove_started @{ result = "started"; reason = "rename_blocked" }
                Remove-Item -LiteralPath $OutPath -Force
                Write-InstallLog INFO old_binary_remove_completed @{ result = "success" }
            }
        }
        try {
            Set-InstallStage "atomic_replace"
            Write-InstallLog INFO atomic_replace_started @{ target = "installed"; strategy = "move_candidate" }
            Move-Item -LiteralPath $TmpPath -Destination $OutPath
            Write-InstallLog INFO atomic_replace_completed @{ result = "success" }
        } catch {
            Write-InstallLog ERROR atomic_replace_failed (Get-InstallFailureFields $_)
            if ($renamedAside) {
                try {
                    Set-InstallStage "rollback"
                    Write-InstallLog WARN rollback_started @{ target = "installed"; source = "old_image" }
                    Move-Item -LiteralPath $OldPath -Destination $OutPath
                    Write-InstallLog INFO rollback_completed @{ result = "restored" }
                } catch {
                    Write-InstallLog ERROR rollback_failed (Get-InstallFailureFields $_)
                    # Rollback failed too: the aside binary is the only restored
                    # copy and the fresh download below is the other recovery
                    # path, so the finally must keep it.
                    $rollbackFailed = $true
                    Write-InstallLog WARN recovery_files_retained @{ result = "retained"; old_image = $true; candidate = $true }
                    throw
                }
            }
            throw
        }
        # Best-effort cleanup of the renamed-aside binary and stale asides from
        # earlier installs. A still-running omp keeps its image locked, so its
        # aside simply survives until the next install.
        Clear-InstallAsides
    } finally {
        # A failed swap must not leave the install directory without any omp
        # binary: when the old one is gone (kill fallback or a failed rollback)
        # keep the downloaded file so re-running the installer — or renaming it
        # back manually — recovers.
        if (-not ($hadExisting -and (-not $renamedAside -or $rollbackFailed) -and -not (Test-Path -LiteralPath $OutPath))) {
            Remove-Item -LiteralPath $TmpPath -Force -ErrorAction SilentlyContinue
            try {
                $candidateRetained = [bool](Test-Path -LiteralPath $TmpPath)
                $cleanupLevel = if ($candidateRetained) { "WARN" } else { "INFO" }
                Write-InstallLog $cleanupLevel candidate_cleanup_completed @{ result = $(if ($candidateRetained) { "retained" } else { "removed_or_absent" }) }
            } catch {
                Write-InstallLog WARN candidate_cleanup_unavailable @{ result = "unknown" }
            }
        } else {
            Write-InstallLog WARN recovery_files_retained @{ result = "retained"; candidate = $true; old_image = $rollbackFailed }
        }
    }

    Write-Host ""
    Write-Host "[OK] Installed omp to $OutPath" -ForegroundColor Green

    if (Set-InstallEnvironment) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
    Complete-InstallLog "success"
    } catch {
        if ($_.Exception -isnot [System.Management.Automation.PipelineStoppedException]) {
            Write-InstallLog ERROR stage_failed (Get-InstallFailureFields $_)
        }
        Complete-InstallLog "failed" $_
        throw
    }
}

function Clear-InstallAsides {
    Set-InstallStage "aside_cleanup"
    Write-InstallLog INFO aside_cleanup_started @{ target = "old_images" }
    $cleanupErrors = @()
    Get-ChildItem -LiteralPath $InstallDir -Filter ".omp.old.*" -File -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors |
        Remove-Item -Force -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors
    if ($cleanupErrors.Count) {
        Write-InstallLog WARN aside_cleanup_completed @{ result = "partial"; error_count = $cleanupErrors.Count; locked_images_may_remain = $true }
    } else {
        Write-InstallLog INFO aside_cleanup_completed @{ result = "success" }
    }
}

# This installer only downloads published release binaries.
Install-Binary
