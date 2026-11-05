param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$statusPath = Join-Path $OutputDirectory 'status.json'
$stopPath = Join-Path $OutputDirectory 'stop'
$writer = $null

function Write-Status([string]$State, [string]$Message = '') {
    $value = @{ status = $State; pid = $PID; error = $Message } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText("$statusPath.tmp", $value, $utf8)
    Move-Item -LiteralPath "$statusPath.tmp" -Destination $statusPath -Force
}

try {
    $writer = [System.IO.StreamWriter]::new((Join-Path $OutputDirectory 'samples.jsonl'), $false, $utf8)
    $writer.AutoFlush = $true
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $nextSample = 0.0
    $ready = $false
    while (-not (Test-Path -LiteralPath $stopPath)) {
        $remaining = $nextSample - $timer.Elapsed.TotalMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($remaining)) }
        if (Test-Path -LiteralPath $stopPath) { break }
        $started = $timer.Elapsed.TotalMilliseconds
        $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
        $memory = Get-CimInstance Win32_OperatingSystem
        if ($null -eq $cpu.PercentProcessorTime -or $null -eq $memory.TotalVisibleMemorySize) {
            throw 'CPU or memory performance counters are unavailable'
        }
        $memoryTotal = [double]$memory.TotalVisibleMemorySize * 1024
        $memoryUsed = $memoryTotal - [double]$memory.FreePhysicalMemory * 1024
        $volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
            if ($_.Size -gt 0) {
                [ordered]@{
                    name = $_.DeviceID
                    totalBytes = [double]$_.Size
                    usedBytes = [double]($_.Size - $_.FreeSpace)
                    usedPercent = [double](100 * ($_.Size - $_.FreeSpace) / $_.Size)
                }
            }
        })
        $disks = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name<>'_Total'" | ForEach-Object {
            $busy = $null
            if ($null -ne $_.PercentIdleTime) {
                $busy = [Math]::Max(0.0, [Math]::Min(100.0, 100.0 - [double]$_.PercentIdleTime))
            }
            [ordered]@{
                name = $_.Name
                busyPercent = $busy
                readBytesPerSecond = [double]$_.DiskReadBytesPersec
                writeBytesPerSecond = [double]$_.DiskWriteBytesPersec
                queueLength = [double]$_.AvgDiskQueueLength
            }
        })
        $sample = [ordered]@{
            timestamp = [DateTime]::UtcNow.ToString('o')
            cpuPercent = [double]$cpu.PercentProcessorTime
            memoryTotalBytes = $memoryTotal
            memoryUsedBytes = $memoryUsed
            memoryPercent = 100 * $memoryUsed / $memoryTotal
            volumes = $volumes
            disks = $disks
            collectionMs = $timer.Elapsed.TotalMilliseconds - $started
        }
        $writer.WriteLine(($sample | ConvertTo-Json -Compress -Depth 5))
        if (-not $ready) { Write-Status 'running'; $ready = $true }
        $nextSample = [Math]::Max($started + 2000, $timer.Elapsed.TotalMilliseconds)
    }
    Write-Status 'stopped'
} catch {
    Write-Status 'failed' $_.Exception.Message
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $writer) { $writer.Dispose() }
}
