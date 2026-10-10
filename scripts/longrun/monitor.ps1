[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$EnginePid,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [ValidateRange(1, 43200)][double]$MaxMinutes = 35
)

$ErrorActionPreference = 'Stop'
$intervalMs = 5000
$outputFile = [IO.Path]::GetFullPath($OutputPath)
$stopFile = [IO.Path]::GetFullPath($StopPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFile))
$writer = [IO.StreamWriter]::new($outputFile, $true, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$watch = [Diagnostics.Stopwatch]::StartNew()
$logicalProcessors = [Environment]::ProcessorCount
$previous = @{}
$previousAt = $null
$observedCpuSeconds = 0.0
$sequence = 0
$rootStartUtc = $null
$reason = 'unknown'

function Write-Record($Record) {
  $writer.WriteLine(($Record | ConvertTo-Json -Depth 8 -Compress))
}

try {
  try {
    $root = Get-Process -Id $EnginePid -ErrorAction Stop
    $rootStartUtc = $root.StartTime.ToUniversalTime()
    $root.Dispose()
  } catch {
    $reason = 'root-not-running'
    return
  }

  Write-Record ([ordered]@{
    type = 'start'; at = [DateTime]::UtcNow.ToString('o'); enginePid = $EnginePid
    engineStartTime = $rootStartUtc.ToString('o'); intervalMs = $intervalMs
    maxMinutes = $MaxMinutes; logicalProcessors = $logicalProcessors
    cpuNote = 'CPU deltas use PID + StartTime. Processes born and exited between samples are not observable.'
  })

  $nextDueMs = 0.0
  while ($true) {
    if ([IO.File]::Exists($stopFile)) { $reason = 'stop-file'; break }
    if ($watch.Elapsed.TotalMinutes -ge $MaxMinutes) { $reason = 'max-duration'; break }

    try {
      $root = Get-Process -Id $EnginePid -ErrorAction Stop
      $currentRootStart = $root.StartTime.ToUniversalTime()
      $root.Dispose()
      if ($currentRootStart -ne $rootStartUtc) { $reason = 'root-pid-reused'; break }
    } catch { $reason = 'root-exited'; break }

    $at = [DateTime]::UtcNow
    $sampleWatch = [Diagnostics.Stopwatch]::StartNew()
    $errors = [Collections.Generic.List[string]]::new()
    $processes = [Collections.Generic.List[object]]::new()
    $current = @{}
    $cpuDelta = 0.0
    $workingSet = [long]0
    $privateBytes = [long]0
    $handleCount = [long]0
    $threadCount = [long]0

    try {
      $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop)
      $children = @{}
      foreach ($entry in $all) {
        $parentKey = [string]$entry.ParentProcessId
        if (-not $children.ContainsKey($parentKey)) {
          $children[$parentKey] = [Collections.Generic.List[int]]::new()
        }
        $children[$parentKey].Add([int]$entry.ProcessId)
      }
      $ids = [Collections.Generic.HashSet[int]]::new()
      $queue = [Collections.Generic.Queue[int]]::new()
      [void]$ids.Add($EnginePid)
      $queue.Enqueue($EnginePid)
      while ($queue.Count -gt 0) {
        $parentKey = [string]$queue.Dequeue()
        if ($children.ContainsKey($parentKey)) {
          foreach ($childId in $children[$parentKey]) {
            if ($ids.Add($childId)) { $queue.Enqueue($childId) }
          }
        }
      }
    } catch {
      $errors.Add('process-tree-enumeration: ' + $_.Exception.Message)
      $ids = @($EnginePid)
    }

    foreach ($candidateId in $ids) {
      $proc = $null
      try {
        $proc = Get-Process -Id $candidateId -ErrorAction Stop
        $started = $proc.StartTime.ToUniversalTime()
        if ($started -lt $rootStartUtc) { continue }
        $identity = [string]$candidateId + ':' + [string]$started.Ticks
        $cpu = [double]$proc.TotalProcessorTime.TotalSeconds
        $delta = $null
        if ($previous.ContainsKey($identity)) {
          $delta = [Math]::Max(0.0, $cpu - [double]$previous[$identity])
        } elseif ($null -ne $previousAt -and $started -ge $previousAt) {
          $delta = $cpu
        }
        if ($null -ne $delta) { $cpuDelta += $delta }
        $rss = [long]$proc.WorkingSet64
        $private = [long]$proc.PrivateMemorySize64
        $handles = [long]$proc.HandleCount
        $threads = [long]$proc.Threads.Count
        $current[$identity] = $cpu
        $processes.Add([ordered]@{
          pid = [int]$candidateId; identity = $identity; name = $proc.ProcessName
          startTime = $started.ToString('o'); cpuSeconds = $cpu; cpuDeltaSeconds = $delta
          rssBytes = $rss; privateBytes = $private; handles = $handles; threads = $threads
        })
        $workingSet += $rss
        $privateBytes += $private
        $handleCount += $handles
        $threadCount += $threads
      } catch {
        # A short-lived descendant may exit between the process-tree and resource reads.
        $errors.Add('process ' + [string]$candidateId + ': ' + $_.Exception.Message)
      } finally {
        if ($null -ne $proc) { $proc.Dispose() }
      }
    }

    $elapsedSeconds = $null
    $cpuOneCorePercent = $null
    $cpuMachinePercent = $null
    if ($null -ne $previousAt) {
      $elapsedSeconds = ($at - $previousAt).TotalSeconds
      if ($elapsedSeconds -gt 0) {
        $cpuOneCorePercent = 100.0 * $cpuDelta / $elapsedSeconds
        $cpuMachinePercent = $cpuOneCorePercent / $logicalProcessors
      }
    }
    $observedCpuSeconds += $cpuDelta
    $sampleWatch.Stop()
    Write-Record ([ordered]@{
      type = 'sample'; at = $at.ToString('o'); sequence = $sequence; enginePid = $EnginePid
      elapsedMs = $watch.ElapsedMilliseconds; intervalSeconds = $elapsedSeconds
      sampleDurationMs = $sampleWatch.ElapsedMilliseconds; processCount = $processes.Count
      cpuDeltaSeconds = $(if ($null -ne $previousAt) { $cpuDelta } else { $null })
      observedCpuSeconds = $observedCpuSeconds; cpuOneCorePercent = $cpuOneCorePercent
      cpuMachinePercent = $cpuMachinePercent; rssBytes = $workingSet; privateBytes = $privateBytes
      handles = $handleCount; threads = $threadCount; processes = @($processes.ToArray())
      errors = @($errors.ToArray())
    })
    $previous = $current
    $previousAt = $at
    $sequence++
    $nextDueMs += $intervalMs
    # Keep a fixed cadence without a burst of catch-up samples after a slow CIM query.
    while ($nextDueMs -lt $watch.Elapsed.TotalMilliseconds) { $nextDueMs += $intervalMs }
    while ($watch.Elapsed.TotalMilliseconds -lt $nextDueMs) {
      if ([IO.File]::Exists($stopFile)) { break }
      $remaining = $nextDueMs - $watch.Elapsed.TotalMilliseconds
      Start-Sleep -Milliseconds ([int][Math]::Max(1.0, [Math]::Min(250.0, $remaining)))
    }
  }
} catch {
  $reason = 'monitor-error'
  Write-Record ([ordered]@{ type = 'error'; at = [DateTime]::UtcNow.ToString('o'); message = $_.Exception.Message })
} finally {
  Write-Record ([ordered]@{
    type = 'stop'; at = [DateTime]::UtcNow.ToString('o'); enginePid = $EnginePid; reason = $reason
    elapsedMs = $watch.ElapsedMilliseconds; samples = $sequence; observedCpuSeconds = $observedCpuSeconds
  })
  $writer.Dispose()
}
