# OMP Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Source -Ref 'v18.0.6+fork.123'
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref 'v18.0.6+fork.123'

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "jchanghong023/oh-my-pi"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$BinaryName = "omp-windows-x64.exe"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new. ConvertFrom-Json -AsHashtable
            # requires PowerShell 6+; build the hashtable manually so Windows
            # PowerShell 5.1 merges instead of clobbering existing settings.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $settings[$prop.Name] = $prop.Value
                    }
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "No bash shell found - OMP will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Or set a custom path in:" -ForegroundColor Cyan
            Write-Host "    $settingsFile" -ForegroundColor Cyan
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Cyan
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    if (-not (Test-GitInstalled)) {
        throw "git is required when installing from source"
    }

    $sourceRef = if ($Ref) { $Ref } else { "main" }
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-install-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

    try {
        $repoUrl = "https://github.com/$Repo.git"
        $cloneOk = $false
        try {
            git clone --depth 1 --branch $sourceRef $repoUrl $tmpRoot | Out-Null
            $cloneOk = $true
        } catch {
            $cloneOk = $false
        }

        if (-not $cloneOk) {
            git clone $repoUrl $tmpRoot | Out-Null
            Push-Location $tmpRoot
            try {
                git checkout $sourceRef | Out-Null
            } finally {
                Pop-Location
            }
        }

        # Pull LFS files
        if (Test-GitLfsInstalled) {
            Push-Location $tmpRoot
            try {
                git lfs pull | Out-Null
            } finally {
                Pop-Location
            }
        }

        $packagePath = Join-Path $tmpRoot "packages\coding-agent"
        if (-not (Test-Path $packagePath)) {
            throw "Expected package at $packagePath"
        }

        bun install -g $packagePath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install from $packagePath via bun"
        }
    } finally {
        Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Installed omp via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'omp' to get started!"
}

# Windows locks a running executable, so replacing omp.exe fails while a
# previous instance is alive. Stop every process whose binary path is the
# install target before the new file is moved into place.
function Stop-RunningOmp {
    param([string]$TargetPath)
    try {
        $running = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { try { $_.Path -eq $TargetPath } catch { $false } }
        if ($running) {
            Write-Host "Stopping running omp..." -ForegroundColor Yellow
            $running | Stop-Process -Force -ErrorAction SilentlyContinue
            $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
        }
    } catch {
        # Process enumeration races with process exit; never block the install.
    }
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref" -TimeoutSec 60
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 60
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Windows locks a running executable, so omp.exe cannot be overwritten
    # while a previous instance is alive: download to a temp file first (a
    # failed download leaves the old install working), stop the running
    # instance, then move the new binary into place. Prefer the in-box
    # curl.exe (Windows 10 1803+) for a live progress bar; fall back to
    # Invoke-WebRequest.
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "omp.exe"
    $TmpPath = "$OutPath.tmp"
    $curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
    try {
        if ($curlExe) {
            & $curlExe.Source -fL --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar $BinaryUrl -o $TmpPath
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -Force $TmpPath -ErrorAction SilentlyContinue
                throw "Download failed: $BinaryUrl (curl exit $LASTEXITCODE)"
            }
        } else {
            try {
                Invoke-WebRequest -Uri $BinaryUrl -OutFile $TmpPath -TimeoutSec 900 -UseBasicParsing
            } catch {
                Remove-Item -Force $TmpPath -ErrorAction SilentlyContinue
                throw "Download failed: $BinaryUrl`n$($_.Exception.Message)"
            }
        }
        Stop-RunningOmp -TargetPath $OutPath
        Move-Item -Force -Path $TmpPath -Destination $OutPath
    } finally {
        Remove-Item -Force $TmpPath -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

# Main logic
if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    Install-Binary
}
