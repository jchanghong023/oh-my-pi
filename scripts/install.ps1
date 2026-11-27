# OMP Coding Agent Installer for Windows
# Requires Windows PowerShell 5.1 or PowerShell 7+ (x64).
# Usage: .\scripts\install.ps1 [-Ref <tag>]
#
# Binary fallback uses Invoke-WebRequest -UseBasicParsing so Windows
# PowerShell 5.1 can run without Internet Explorer.

param(
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"
$InstallerSourcePath = $PSCommandPath

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
$script:InstallLogLevels = @{ ERROR = 0; WARN = 1; INFO = 2; DEBUG = 3 }
$configuredLevel = ([string]$env:OMP_LOG_LEVEL).Trim().ToUpperInvariant()
$script:InstallLogThreshold = if ($script:InstallLogLevels.ContainsKey($configuredLevel)) {
    $script:InstallLogLevels[$configuredLevel]
} elseif (([string]$env:OMP_OFFLINE).Trim() -match '\A(?:1|true|yes|on)\z') {
    $script:InstallLogLevels.WARN
} else {
    $script:InstallLogLevels.DEBUG
}

function Write-InstallLog {
    param([string]$Level, [string]$Event, [hashtable]$Fields = @{})
    if (-not $script:InstallLogPath -or $script:InstallLogLevels[$Level] -gt $script:InstallLogThreshold) { return }
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
        # IsPathRooted alone accepts drive-relative C:foo and root-relative \foo.
        $absoluteRoot = '^(?:[A-Za-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)'
        $configDir = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { ".omp" }
        $root = "$homeDir\$configDir"
        $explicitRoot = $env:OMP_CONFIG_ROOT
        if ($explicitRoot) { $explicitRoot = $explicitRoot.Trim() }
        if ($explicitRoot -eq "~") { $explicitRoot = $homeDir }
        elseif ($explicitRoot -match '^~[/\\]') { $explicitRoot = $homeDir + $explicitRoot.Substring(1) }
        if ($explicitRoot -match $absoluteRoot) { $root = $explicitRoot }
        $profile = if (Test-Path Env:OMP_PROFILE) { $env:OMP_PROFILE } else { $env:PI_PROFILE }
        if ($profile) { $profile = $profile.Trim() }
        if ($profile -and $profile -ne "default" -and $profile -cmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -and
            $profile -notmatch '\.$|^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') {
            $profileSuffix = "profiles\$profile\logs"
        } else { $profileSuffix = "logs" }
        $fallbackRoot = if ($env:LOCALAPPDATA -match $absoluteRoot) { "$env:LOCALAPPDATA\omp" } else { "$homeDir\.omp" }
        $cacheRoot = $env:OMP_CACHE_DIR
        if ($cacheRoot) { $cacheRoot = $cacheRoot.Trim() }
        if ($cacheRoot -eq "~") { $cacheRoot = $homeDir }
        elseif ($cacheRoot -match '^~[/\\]') { $cacheRoot = $homeDir + $cacheRoot.Substring(1) }
        $name = "omp.install.{0}.{1}.{2}.log" -f $script:InstallStarted.ToString("yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture), $script:InstallStarted.ToUnixTimeMilliseconds(), $PID
        $fallback = $false
        # Compose candidates without consulting the PowerShell drive table.
        # An unavailable drive must fail only inside its own fallback attempt.
        foreach ($logRoot in @($cacheRoot, $root, $fallbackRoot)) {
            if ($logRoot -notmatch $absoluteRoot) { continue }
            try {
                $directory = [IO.Path]::GetFullPath("$logRoot\$profileSuffix")
                [IO.Directory]::CreateDirectory($directory) | Out-Null
                $logPath = [IO.Path]::Combine($directory, $name)
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
        # The transport returns HTTP diagnostics separately from its message.
        $isolatedFailure = $Failure.Exception.Data["OmpInstallHttpFailure"]
        if ($isolatedFailure) {
            $fields.error_type = $isolatedFailure.error_type
            $fields.error_code = $isolatedFailure.error_code
            if ($isolatedFailure.http_status -is [int]) { $fields.http_status = $isolatedFailure.http_status }
        } elseif ($Failure.Exception.Response -and $Failure.Exception.Response.StatusCode) {
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

function New-InstallHttpFailure {
    param([hashtable]$Fields)
    # Server error bodies and redirect URLs are never safe to echo.
    $failure = [Exception]::new("CNB web request failed ($($Fields.error_type), HTTP $($Fields.http_status)).")
    $failure.Data["OmpInstallHttpFailure"] = $Fields
    return $failure
}

# Only downloads may bypass certificate validation: their bytes are checked
# against the digest from trusted release metadata before execution. Isolate
# legacy TLS settings so neither request changes the caller's host settings.
function Invoke-InstallWebRequest {
    param([Uri]$Uri, [int]$TimeoutSec, [string]$OutFile, [hashtable]$Headers = @{}, [switch]$Redirect)

    if ($PSVersionTable.PSVersion.Major -ge 7) {
        if ($OutFile) {
            Invoke-WebRequest -Uri $Uri.AbsoluteUri -OutFile $OutFile -TimeoutSec $TimeoutSec -UseBasicParsing -SkipCertificateCheck -MaximumRedirection 0
            return
        }

        # Keep both authenticated requests on the original connection, over
        # verified TLS. In particular, never follow the signed asset redirect.
        $status = "unavailable"
        try {
            $handler = [Net.Http.HttpClientHandler]::new()
            $handler.AllowAutoRedirect = $false
            $client = [Net.Http.HttpClient]::new($handler)
            try {
                $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
                $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
                try {
                    foreach ($key in $Headers.Keys) { $request.Headers.Add($key, [string]$Headers[$key]) }
                    $completion = if ($Redirect) { [Net.Http.HttpCompletionOption]::ResponseHeadersRead } else { [Net.Http.HttpCompletionOption]::ResponseContentRead }
                    $response = $client.SendAsync($request, $completion).GetAwaiter().GetResult()
                    try {
                        $status = [int]$response.StatusCode
                        if ($Redirect) { return @{ status = $status; location = [string]$response.Headers.Location } }
                        if ($status -ne 200) { throw [Net.WebException]::new("Expected HTTP 200.") }
                        $json = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                        return (ConvertFrom-Json -InputObject $json)
                    } finally { $response.Dispose() }
                } finally { $request.Dispose() }
            } finally { $client.Dispose() }
        } catch {
            $failureFields = Get-InstallFailureFields $_
            $failureFields.http_status = $status
            throw (New-InstallHttpFailure $failureFields)
        }
        return
    }

    # Windows PowerShell 5.1 has no per-request skip flag. Start-Job runs in
    # a child PowerShell process, not in another runspace of this process.
    if ($OutFile) {
        $OutFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
    }
    # The child inherits OS settings, but not the host's process-local proxy.
    $callerProxy = [Net.WebRequest]::DefaultWebProxy
    $proxyAddress = ""
    $proxyCredentials = @{}
    $useDefaultProxyCredentials = $false
    if ($callerProxy -and -not $callerProxy.IsBypassed($Uri)) {
        $proxyUri = $callerProxy.GetProxy($Uri)
        $proxyAddress = $proxyUri.AbsoluteUri
        $credentials = $callerProxy.Credentials
        if ($credentials) {
            $useDefaultProxyCredentials = [object]::ReferenceEquals($credentials, [Net.CredentialCache]::DefaultNetworkCredentials)
            if (-not $useDefaultProxyCredentials) {
                # Snapshot only credentials selected for this proxy and each
                # registered auth scheme. Keep passwords as SecureStrings
                # across the job boundary; never stringify or log them.
                foreach ($module in [Net.AuthenticationManager]::RegisteredModules) {
                    $scheme = $module.AuthenticationType
                    $credential = $credentials.GetCredential($proxyUri, $scheme)
                    if ($credential) {
                        $proxyCredentials[$scheme] = @{
                            UseDefault = [object]::ReferenceEquals($credential, [Net.CredentialCache]::DefaultNetworkCredentials)
                            UserName = $credential.UserName
                            Password = $credential.SecurePassword
                            Domain = $credential.Domain
                        }
                    }
                }
            }
        }
    }
    $job = Start-Job -ArgumentList @($Uri.AbsoluteUri, $TimeoutSec, $OutFile, $proxyAddress, ($null -eq $callerProxy), $useDefaultProxyCredentials, $proxyCredentials, $Headers, [bool]$Redirect) -ScriptBlock {
        param([Uri]$Uri, [int]$TimeoutSec, [string]$OutFile, [string]$ProxyAddress, [bool]$ProxyDisabled,
            [bool]$UseDefaultProxyCredentials, [hashtable]$ProxyCredentials, [hashtable]$Headers, [bool]$Redirect)
        $ErrorActionPreference = "Stop"
        $ProgressPreference = "SilentlyContinue"
        try {
            $childProxy = [Net.WebRequest]::DefaultWebProxy
            if ($ProxyAddress) {
                # Keep the OS proxy object (including redirect routing) if it
                # already selects the same endpoint for this request.
                if (-not $childProxy -or $childProxy.IsBypassed($Uri) -or
                    $childProxy.GetProxy($Uri).AbsoluteUri -ne $ProxyAddress) {
                    $childProxy = [Net.WebProxy]::new([Uri]$ProxyAddress)
                    [Net.WebRequest]::DefaultWebProxy = $childProxy
                }
                if ($UseDefaultProxyCredentials) {
                    $childProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
                } elseif ($ProxyCredentials.Count) {
                    $cache = [Net.CredentialCache]::new()
                    foreach ($scheme in $ProxyCredentials.Keys) {
                        $entry = $ProxyCredentials[$scheme]
                        $credential = if ($entry.UseDefault) { [Net.CredentialCache]::DefaultNetworkCredentials } else {
                            [Net.NetworkCredential]::new($entry.UserName, $entry.Password, $entry.Domain)
                        }
                        $cache.Add([Uri]$ProxyAddress, $scheme, $credential)
                    }
                    $childProxy.Credentials = $cache
                }
            } elseif ($ProxyDisabled -or ($childProxy -and -not $childProxy.IsBypassed($Uri))) {
                [Net.WebRequest]::DefaultWebProxy = $null
            }

            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            if ($OutFile) {
                # A PowerShell scriptblock cannot run on the TLS worker thread.
                Add-Type -TypeDefinition @'
namespace Omp {
    public static class InstallerTls {
        public static readonly System.Net.Security.RemoteCertificateValidationCallback Callback =
            (sender, certificate, chain, errors) => true;
    }
}
'@
                [Net.ServicePointManager]::ServerCertificateValidationCallback = [Omp.InstallerTls]::Callback
                Invoke-WebRequest -Uri $Uri -OutFile $OutFile -TimeoutSec $TimeoutSec -UseBasicParsing -MaximumRedirection 0
                @{ success = $true }
            } else {
                $request = [Net.HttpWebRequest]::CreateHttp($Uri)
                $request.AllowAutoRedirect = $false
                $request.Timeout = $TimeoutSec * 1000
                $request.ReadWriteTimeout = $TimeoutSec * 1000
                foreach ($key in $Headers.Keys) {
                    if ($key -eq "Accept") { $request.Accept = $Headers[$key] }
                    else { $request.Headers[$key] = $Headers[$key] }
                }
                $response = $request.GetResponse()
                try {
                    $status = [int]$response.StatusCode
                    if ($Redirect) {
                        @{ success = $true; status = $status; location = $response.Headers["Location"] }
                    } elseif ($status -ne 200) {
                        @{ success = $false; error_type = "WebException"; error_code = 0; http_status = $status }
                    } else {
                        # Relay the JSON body without job-serializing nested assets.
                        $reader = [IO.StreamReader]::new($response.GetResponseStream())
                        try { @{ success = $true; release_json = $reader.ReadToEnd() } }
                        finally { $reader.Dispose() }
                    }
                } finally { $response.Dispose() }
            }
        } catch {
            $errorException = $_.Exception
            while ($errorException -is [System.Management.Automation.MethodInvocationException] -and $errorException.InnerException) {
                $errorException = $errorException.InnerException
            }
            $failure = @{
                success = $false
                http_status = "unavailable"
                error_code = $errorException.HResult
                error_type = $errorException.GetType().Name
            }
            if ($errorException -is [Net.WebException] -and $errorException.Response -is [Net.HttpWebResponse]) {
                $failure.http_status = [int]$errorException.Response.StatusCode
                $errorException.Response.Dispose()
            }
            $failure
        }
    }
    try {
        $result = Receive-Job -Job $job -Wait
    } finally {
        Remove-Job -Job $job -Force
    }
    if (-not $result) { throw "The installer web request process returned no result." }
    if (-not $result.success) {
        throw (New-InstallHttpFailure $result)
    }
    if ($Redirect) { return @{ status = $result.status; location = $result.location } }
    if (-not $OutFile) { return (ConvertFrom-Json -InputObject $result.release_json) }
}

$CnbApi = "https://api.cnb.cool/jchanghong/bin"
$VersionPattern = '(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
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
# gate on $LASTEXITCODE. Global "Stop" stays in effect for cmdlet operations.
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

# curl does not read Windows Internet proxy settings. Resolve the same default
# proxy as PowerShell, while leaving explicit proxy environment variables first.
function Save-InstallBinary {
    param([Uri]$Uri, [string]$OutFile)

    $curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
    $curlExit = $null
    if ($curlExe) {
        Set-InstallStage "download_proxy"
        $proxyArguments = @()
        $environmentProxy = [Environment]::GetEnvironmentVariable($Uri.Scheme + "_PROXY")
        if (-not $environmentProxy -and -not $env:ALL_PROXY) {
            $systemProxy = [System.Net.WebRequest]::DefaultWebProxy
            if ($systemProxy -and -not $systemProxy.IsBypassed($Uri)) {
                $proxyArguments = @("--proxy", $systemProxy.GetProxy($Uri).AbsoluteUri)
                Write-Host "Using Windows system proxy for binary download."
            }
        }
        Set-InstallStage "download_curl"
        Write-InstallLog INFO http_request_started @{ method = "GET"; endpoint = "release_asset"; transport = "curl"; attempt = 1; connect_timeout_ms = 10000; low_speed_timeout_ms = 30000 }
        try {
            # CNB signed URLs are validated as HTTPS before reaching this helper.
            # Pin curl to the requested HTTP(S) scheme without following redirects.
            $curlProtocol = if ($Uri.Scheme -eq "http") { "=http" } else { "=https" }
            Invoke-Native { & $curlExe.Source -q -fg --proto $curlProtocol --insecure --ssl-no-revoke --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar @proxyArguments $Uri.AbsoluteUri -o $OutFile }
            $curlExit = $LASTEXITCODE
        } catch [System.Management.Automation.ApplicationFailedException] {
            # No process exited: do not reuse a previous native command's exit code.
            $curlExit = -1
        }
        if ($curlExit -ne 0) {
            $kind = switch ($curlExit) { 22 { "http" }; 28 { "timeout" }; 6 { "dns" }; 7 { "connect" }; 35 { "tls" }; 60 { "tls" }; default { "network" } }
            Write-InstallLog WARN http_request_failed @{ result = "failed"; curl_exit = $curlExit; error_type = $kind; http_status = "unavailable"; endpoint = "release_asset"; transport = "curl"; attempt = 1 }
            $downloadCleanupErrors = @()
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue -ErrorVariable +downloadCleanupErrors
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
        Write-InstallLog INFO http_request_started @{ method = "GET"; endpoint = "release_asset"; transport = "Invoke-WebRequest"; timeout_ms = 900000; attempt = $(if ($curlExe) { 2 } else { 1 }) }
        try {
            Invoke-InstallWebRequest -Uri $Uri -OutFile $OutFile -TimeoutSec 900
            Write-InstallLog INFO http_request_completed @{ result = "success"; endpoint = "release_asset"; transport = "Invoke-WebRequest"; http_status = "success" }
        } catch {
            $webFailure = Get-InstallFailureFields $_
            Write-InstallLog ERROR http_request_failed $webFailure
            $downloadCleanupErrors = @()
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue -ErrorVariable +downloadCleanupErrors
            $cleanupLevel = if ($downloadCleanupErrors.Count) { "WARN" } else { "INFO" }
            Write-InstallLog $cleanupLevel candidate_cleanup_completed @{ result = $(if ($downloadCleanupErrors.Count) { "partial" } else { "removed_or_absent" }); reason = "download_failed"; error_count = $downloadCleanupErrors.Count }
            $curlDetail = if ($curlExe) { "curl exit $curlExit`n" } else { "" }
            throw "CNB binary download failed.`n${curlDetail}Invoke-WebRequest: $($webFailure.error_type), HTTP $($webFailure.http_status)"
        }
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

    # An omp earlier on PATH (a previous `bun install -g`, Scoop, ...) keeps
    # winning over this install: $InstallDir is appended to PATH, not prepended.
    $Active = Get-Command omp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Active -and $Active.Source -ne [System.IO.Path]::GetFullPath((Join-Path $InstallDir "omp.exe"))) {
        Write-Host "[WARN] 'omp' still resolves to $($Active.Source); remove that install or move $InstallDir ahead of it on PATH." -ForegroundColor Yellow
    }

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

function Get-InstallFileSha256 {
    param([string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

# True when the binary at the install target already matches a release tag.
# `omp --version` starts with `omp/<version>` and release tags start with `v`.
function Test-InstalledBinaryVersion {
    param(
        [string]$TargetPath,
        [string]$ReleaseTag
    )
    $script:InstallProbeDetail = "The binary is missing: $TargetPath"

    $probeTarget = if ([IO.Path]::GetFileName($TargetPath).StartsWith(".omp.tmp.")) { "candidate" } else { "installed" }
    Set-InstallStage "${probeTarget}_version"
    Write-InstallLog INFO binary_probe_started @{ target = $probeTarget; argument = "version" }
    if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        Write-InstallLog INFO binary_probe_completed @{ target = $probeTarget; result = "absent" }
        return $false
    }

    try {
        $versionOutput = @(Invoke-Native { & $TargetPath --version 2>&1 })
        $exitCode = $LASTEXITCODE
        $stdout = @($versionOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
        $expectedVersion = $ReleaseTag -creplace '\Av', ''
        $script:InstallProbeDetail = "Expected omp/$expectedVersion; exit code: $exitCode; output:`n$(($versionOutput | Out-String).Trim())"
        $versionMatch = if ($stdout.Count -eq 1) { [regex]::Match([string]$stdout[0], "\Aomp/($VersionPattern)\z") }
        if ($exitCode -ne 0 -or -not $versionMatch -or -not $versionMatch.Success) {
            $probeLevel = if ($probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
            Write-InstallLog $probeLevel binary_probe_failed @{ target = $probeTarget; result = "invalid_or_failed"; exit_code = $exitCode }
            return $false
        }
        $matchesRelease = $versionMatch.Groups[1].Value -ceq $expectedVersion
        $probeLevel = if (-not $matchesRelease -and $probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
        Write-InstallLog $probeLevel binary_probe_completed @{ target = $probeTarget; result = $(if ($matchesRelease) { "matches" } else { "mismatch" }); exit_code = $exitCode }
        return $matchesRelease
    } catch {
        $probeLevel = if ($probeTarget -eq "candidate") { "ERROR" } else { "INFO" }
        $fields = Get-InstallFailureFields $_
        $fields.target = $probeTarget
        Write-InstallLog $probeLevel binary_probe_failed $fields
        $script:InstallProbeDetail = $_.Exception.Message
        return $false
    }
}

function Move-InstallFile {
    param([string]$Source, [string]$Destination)

    # Use an exact destination. Unlike Move-Item, this fails atomically if
    # another entry is already there, including directories and symlinks.
    [IO.File]::Move($Source, $Destination)
}

function Install-Binary {
    $downloaded = $false
    $verified = $false
    $installed = $false
    $failedStage = $null
    $renameFailure = $null
    $swapFailure = $null
    try {
    Set-InstallStage "install_target"
    $InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
    $OutPath = Join-Path $InstallDir "omp.exe"
    if (Test-Path -LiteralPath $OutPath -PathType Container) {
        throw "Refusing to replace a directory at $OutPath"
    }
    Set-InstallStage "release_metadata"
    $ReleaseTag = if ($Ref) { $Ref } else { "omp" }
    if ($ReleaseTag -cnotmatch '\A[A-Za-z0-9._+/-]+\z' -or $ReleaseTag -eq "." -or $ReleaseTag.Contains("..")) {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "invalid_requested_tag" }
        throw "Invalid release tag: $ReleaseTag"
    }
    if ([string]::IsNullOrEmpty($env:CNB_TOKEN)) {
        throw "Set CNB_TOKEN with repo-release:r permission to install from CNB."
    }
    if ($env:CNB_TOKEN -cnotmatch '\A[A-Za-z0-9._~+/-]+=*\z') {
        throw "CNB_TOKEN is not a valid bearer token."
    }
    # Send these headers only to fixed CNB OpenAPI routes, never to the signed URL.
    $headers = @{ Accept = "application/vnd.cnb.api+json"; Authorization = "Bearer $env:CNB_TOKEN" }
    $refPath = [Uri]::EscapeDataString($ReleaseTag)
    Write-Host "Fetching CNB release $ReleaseTag..."
    Write-InstallLog INFO http_request_started @{ method = "GET"; host = "api.cnb.cool"; endpoint = "release_tag"; timeout_ms = 60000; attempt = 1 }
    try {
        $Release = Invoke-InstallWebRequest -Uri "$CnbApi/-/releases/tags/$refPath" -TimeoutSec 60 -Headers $headers
    } catch {
        $failureFields = Get-InstallFailureFields $_
        Write-InstallLog ERROR http_request_failed $failureFields
        if ($failureFields.http_status -eq 404) {
            throw "Release tag not found: $ReleaseTag`nOnly published CNB release tags are supported."
        }
        if ($failureFields.http_status -in 401, 403) {
            Write-Host "CNB release access was denied. Set CNB_TOKEN with repo-release:r permission."
        }
        throw
    }
    Write-InstallLog INFO http_request_completed @{ result = "success"; host = "api.cnb.cool"; endpoint = "release_tag"; http_status = "success" }

    if ($Release.tag_name -isnot [string] -or $Release.tag_name -cne $ReleaseTag) {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "unexpected_tag" }
        throw "CNB metadata did not match the requested release tag."
    }
    $semver = "\Av?$VersionPattern\z"
    $tagVersion = if ($ReleaseTag -cmatch $semver) { $ReleaseTag -creplace '\Av', '' }
    $titleVersion = if ($Release.name -is [string]) {
        if ($Release.name -cmatch $semver) { $Release.name -creplace '\Av', '' }
        elseif ($Release.name -cmatch ' \[omp:v([^][]*)\]\z') {
            $declared = $Matches[1]
            if ($declared -cmatch "\A$VersionPattern\z") { $declared }
            else {
                Write-InstallLog ERROR release_metadata_invalid @{ result = "invalid_version" }
                throw "CNB release $ReleaseTag contains invalid binary version metadata."
            }
        }
    }
    if ((-not $tagVersion -and -not $titleVersion) -or ($tagVersion -and $titleVersion -and $tagVersion -cne $titleVersion)) {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "invalid_version" }
        throw "CNB release $ReleaseTag has no unambiguous binary version. Ask the release owner to republish with version metadata."
    }
    $Latest = if ($titleVersion) { $titleVersion } else { $tagVersion }
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

    Set-InstallStage "release_asset_digest"
    $assets = @($Release.assets | Where-Object { $_.name -is [string] -and [string]::Equals($_.name, $BinaryName, [StringComparison]::Ordinal) })
    if ($assets.Count -ne 1) {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "asset_missing_or_ambiguous"; asset = $BinaryName }
        throw "Expected exactly one $BinaryName asset in release $Latest."
    }
    $digest = $assets[0].hash_value
    if ($assets[0].hash_algo -isnot [string] -or $assets[0].hash_algo -notmatch '\Asha-?256\z' -or
        $digest -isnot [string] -or $digest -cnotmatch '\A[0-9a-fA-F]{64}\z') {
        Write-InstallLog ERROR release_metadata_invalid @{ result = "invalid_asset_digest"; asset = $BinaryName }
        throw "Release $Latest does not provide a valid SHA-256 digest for $BinaryName."
    }
    $expectedHash = $digest

    Set-InstallStage "download_url"
    Write-InstallLog INFO http_request_started @{ method = "GET"; host = "api.cnb.cool"; endpoint = "release_asset_url"; timeout_ms = 60000; attempt = 1 }
    try {
        $redirect = Invoke-InstallWebRequest -Uri "$CnbApi/-/releases/download/$refPath/$BinaryName" -TimeoutSec 60 -Headers $headers -Redirect
    } catch {
        $failureFields = Get-InstallFailureFields $_
        Write-InstallLog ERROR http_request_failed $failureFields
        if ($failureFields.http_status -in 401, 403) {
            Write-Host "CNB release access was denied. Set CNB_TOKEN with repo-release:r permission."
        }
        throw
    }
    $BinaryUrl = $null
    if ($redirect.status -ne 302 -or -not [Uri]::TryCreate($redirect.location, [UriKind]::Absolute, [ref]$BinaryUrl) -or
        $BinaryUrl.Scheme -ne "https" -or -not $BinaryUrl.Host -or $BinaryUrl.UserInfo) {
        Write-InstallLog ERROR http_request_failed @{ result = "invalid_redirect"; endpoint = "release_asset_url"; http_status = $redirect.status }
        if ($redirect.status -in 401, 403) {
            throw "CNB release access was denied. Set CNB_TOKEN with repo-release:r permission."
        }
        throw "CNB did not return an HTTPS binary download redirect."
    }
    Write-InstallLog INFO http_request_completed @{ result = "success"; host = "api.cnb.cool"; endpoint = "release_asset_url"; http_status = 302 }

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
    Write-Host "Downloading $BinaryName..."
    $TmpPath = Join-Path $InstallDir (".omp.tmp.{0}.{1}.exe" -f $PID, [System.Guid]::NewGuid().ToString("N"))
    $renamedAside = $false
    $rollbackFailed = $false
    $hadExisting = $false
    try {
        Save-InstallBinary -Uri $BinaryUrl -OutFile $TmpPath
        $downloaded = $true

        Set-InstallStage "candidate_sha256"
        $actualHash = Get-InstallFileSha256 -Path $TmpPath
        if (-not [string]::Equals($actualHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The downloaded $BinaryName SHA-256 digest does not match release $Latest; the existing install was not changed."
        }

        if (-not (Test-InstalledBinaryVersion -TargetPath $TmpPath -ReleaseTag $Latest)) {
            throw "The downloaded omp binary failed validation; the existing install was not changed.`n$script:InstallProbeDetail"
        }
        $verified = $true

        $OldPath = Join-Path $InstallDir (".omp.old.{0}.exe" -f [System.Guid]::NewGuid().ToString("N"))
        $rollbackGuard = "$OldPath.rollback"
        Set-InstallStage "old_binary_rename"
        $hadExisting = Test-Path -LiteralPath $OutPath -PathType Leaf
        if ($hadExisting) {
            # The aside is not stale until the candidate is committed. Create
            # its guard before the rename so other installs cannot sweep it.
            [IO.File]::WriteAllText($rollbackGuard, "")
            try {
                Write-InstallLog INFO old_binary_rename_started @{ target = "installed"; result = "started" }
                Move-InstallFile -Source $OutPath -Destination $OldPath
                $renamedAside = $true
                Write-InstallLog INFO old_binary_rename_completed @{ result = "success"; old_image = "retained_aside" }
            } catch {
                $renameFailure = $_
                Write-InstallLog WARN old_binary_rename_failed (Get-InstallFailureFields $_)
                Stop-RunningOmp -TargetPath $OutPath
                Set-InstallStage "fallback_rename"
                Write-InstallLog WARN old_binary_rename_started @{ result = "started"; reason = "after_kill_fallback"; attempt = 2 }
                Move-InstallFile -Source $OutPath -Destination $OldPath
                $renamedAside = $true
                Write-InstallLog INFO old_binary_rename_completed @{ result = "success"; old_image = "retained_aside"; attempt = 2 }
            }
        }
        try {
            Set-InstallStage "atomic_replace"
            Write-InstallLog INFO atomic_replace_started @{ target = "installed"; strategy = "move_candidate" }
            Move-InstallFile -Source $TmpPath -Destination $OutPath
            $installed = $true
            Write-InstallLog INFO atomic_replace_completed @{ result = "success" }
        } catch {
            $swapFailure = $_
            $failedStage = "atomic_replace"
            Write-InstallLog ERROR atomic_replace_failed (Get-InstallFailureFields $_)
            if ($renamedAside) {
                try {
                    Set-InstallStage "rollback"
                    Write-InstallLog WARN rollback_started @{ target = "installed"; source = "old_image" }
                    Move-InstallFile -Source $OldPath -Destination $OutPath
                    $renamedAside = $false
                    Write-InstallLog INFO rollback_completed @{ result = "restored" }
                } catch {
                    Write-InstallLog ERROR rollback_failed (Get-InstallFailureFields $_)
                    # Rollback failed too: the aside is the only old copy
                    # and the fresh download is the other recovery path.
                    $rollbackFailed = $true
                    $failedStage = "rollback"
                    Write-InstallLog WARN recovery_files_retained @{ result = "retained"; old_image = $true; candidate = $true }
                    throw
                }
            }
            throw
        }
        # Best-effort cleanup of the renamed-aside binary and stale asides from
        # earlier installs. A still-running omp keeps its image locked, so its
        # aside simply survives until the next install.
        Clear-InstallAsides -CommittedGuard $(if ($renamedAside) { $rollbackGuard })
    } catch {
        if (-not $failedStage) { $failedStage = $script:InstallStage }
        throw
    } finally {
        if ($hadExisting -and -not $renamedAside) {
            Remove-Item -LiteralPath $rollbackGuard -Force -ErrorAction SilentlyContinue
        }
        # Keep a verified download after any failed replacement, including a
        # successful rollback, so the error report can offer a usable binary.
        if (-not ($verified -and (Test-Path -LiteralPath $TmpPath -PathType Leaf))) {
            $cleanupErrors = @()
            if (Test-Path -LiteralPath $TmpPath) {
                Remove-Item -LiteralPath $TmpPath -Force -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors
            }
            if ($cleanupErrors.Count) {
                Write-Host "[WARN] Could not remove the temporary download: $TmpPath" -ForegroundColor Yellow
                foreach ($cleanupError in $cleanupErrors) { Write-Host $cleanupError.Exception.Message }
                $temporaryLiteral = "'" + $TmpPath.Replace("'", "''") + "'"
                Write-Host "After resolving the file-lock or permission error, remove this temporary file:"
                Write-Host "Remove-Item -LiteralPath $temporaryLiteral -Force"
            }
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

    $needsRestart = Set-InstallEnvironment
    Write-Host ""
    Write-Host "[OK] Installed omp to $OutPath" -ForegroundColor Green
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
    Complete-InstallLog "success"
    } catch {
        if ($_.Exception -isnot [System.Management.Automation.PipelineStoppedException]) {
            Write-InstallLog ERROR stage_failed (Get-InstallFailureFields $_)
            if ($downloaded) {
                $failure = $_
                if (-not $failedStage) { $failedStage = $script:InstallStage }
                Write-Host ""
                Write-Host "[ERROR] Installation failed after download. Stage: $failedStage" -ForegroundColor Red
                Write-Host "Error: $($failure.Exception.Message)"
                Write-Host "Type: $($failure.Exception.GetType().FullName); code: $($failure.Exception.HResult); category: $($failure.CategoryInfo.Category)"
                if ($failure.InvocationInfo.PositionMessage) { Write-Host $failure.InvocationInfo.PositionMessage }
                if ($renameFailure) { Write-Host "Old binary rename error: $($renameFailure.Exception.Message)" }
                if ($swapFailure -and $rollbackFailed) { Write-Host "Replacement error before rollback: $($swapFailure.Exception.Message)" }
                Write-Host "Install target: $OutPath"
                if ($script:InstallLogPath) { Write-Host "Diagnostic log: $script:InstallLogPath" }
                $targetLiteral = "'" + $OutPath.Replace("'", "''") + "'"
                if ($installed) {
                    Write-Host "The new binary is installed, but setup did not finish. Run it directly:"
                    Write-Host "& $targetLiteral --version"
                    Write-Host "& $targetLiteral"
                } elseif ($verified -and (Test-Path -LiteralPath $TmpPath -PathType Leaf)) {
                    $candidateLiteral = "'" + $TmpPath.Replace("'", "''") + "'"
                    Write-Host "Verified download retained: $TmpPath"
                    Write-Host "You can use it without replacing the installed executable:"
                    Write-Host "& $candidateLiteral --version"
                    Write-Host "& $candidateLiteral"
                } else {
                    Write-Host "The downloaded binary was not verified; do not use it. The previous install was not replaced."
                }
                if ($rollbackFailed -and (Test-Path -LiteralPath $OldPath -PathType Leaf)) {
                    $oldLiteral = "'" + $OldPath.Replace("'", "''") + "'"
                    Write-Host "Previous binary retained: $OldPath"
                    Write-Host "To restore it only if the install target is still missing:"
                    $guardLiteral = "'" + $rollbackGuard.Replace("'", "''") + "'"
                    Write-Host "try { [IO.File]::Move($oldLiteral, $targetLiteral); Remove-Item -LiteralPath $guardLiteral -Force } catch { throw }"
                } elseif (-not $installed -and $verified -and (Test-Path -LiteralPath $OutPath -PathType Leaf)) {
                    Write-Host "The previous installed binary is still available at $OutPath"
                }
                $installLiteral = "'" + $InstallDir.Replace("'", "''") + "'"
                $releaseLiteral = "'" + $ReleaseTag.Replace("'", "''") + "'"
                $retryScript = if ($InstallerSourcePath) { $InstallerSourcePath } else { ".\scripts\install.ps1" }
                $retryLiteral = "'" + $retryScript.Replace("'", "''") + "'"
                if (-not $InstallerSourcePath) {
                    Write-Host "Retry from a local checkout of the current CNB installer:"
                } else {
                    Write-Host "Resolve the reported error, then retry with this installer:"
                }
                Write-Host "`$env:PI_INSTALL_DIR = $installLiteral; & $retryLiteral -Binary -Ref $releaseLiteral"
                Write-Host "After retrying, verify the installed file and the command found on PATH:"
                Write-Host "& $targetLiteral --version; Get-Command omp; omp --version"
            }
        }
        Complete-InstallLog "failed" $_
        throw
    }
}

function Clear-InstallAsides {
    param([string]$CommittedGuard)

    Set-InstallStage "aside_cleanup"
    Write-InstallLog INFO aside_cleanup_started @{ target = "old_images" }
    $cleanupErrors = @()
    if ($CommittedGuard) {
        Remove-Item -LiteralPath $CommittedGuard -Force -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors
        if ($cleanupErrors.Count) {
            $guardLiteral = "'" + $CommittedGuard.Replace("'", "''") + "'"
            Write-Host "After resolving the error, make this committed old image eligible for cleanup:"
            Write-Host "Remove-Item -LiteralPath $guardLiteral -Force"
        }
    }
    $oldImageName = '^\.omp\.old\.[0-9a-f]{32}\.exe\z'
    Get-ChildItem -LiteralPath $InstallDir -Filter ".omp.old.*.exe" -File -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors |
        Where-Object Name -CMatch $oldImageName |
        ForEach-Object {
            try {
                if (-not (Test-Path -LiteralPath "$($_.FullName).rollback" -ErrorAction Stop)) {
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue -ErrorVariable +cleanupErrors
                }
            } catch { $cleanupErrors += $_ }
        }
    if ($cleanupErrors.Count) {
        Write-InstallLog WARN aside_cleanup_completed @{ result = "partial"; error_count = $cleanupErrors.Count; locked_images_may_remain = $true }
        Write-Host "[WARN] Old-image cleanup is incomplete; this does not undo binary installation." -ForegroundColor Yellow
        foreach ($cleanupError in $cleanupErrors) { Write-Host $cleanupError.Exception.Message }
        $installLiteral = "'" + $InstallDir.Replace("'", "''") + "'"
        Write-Host "Files still used by running sessions can stay until those sessions exit. Then retry cleanup without stopping processes:"
        Write-Host "Get-ChildItem -LiteralPath $installLiteral -Filter '.omp.old.*.exe' -File | Where-Object Name -CMatch '$oldImageName' | ForEach-Object { if (-not (Test-Path -LiteralPath (`$_.FullName + '.rollback') -ErrorAction Stop)) { Remove-Item -LiteralPath `$_.FullName -Force -ErrorAction Continue } }"
    } else {
        Write-InstallLog INFO aside_cleanup_completed @{ result = "success" }
    }
}

# This installer only downloads published release binaries.
Install-Binary
