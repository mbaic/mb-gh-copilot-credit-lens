<#
.SYNOPSIS
  Independent cross-check for the "GitHub Copilot Credit Lens" VS Code extension.

.DESCRIPTION
  Reads the SAME local GitHub Copilot agent debug logs that the extension meters
  (workspaceStorage\<hash>\GitHub.copilot-chat\debug-logs\**\*.jsonl) and computes
  the totals independently, so you can compare them against the dashboard.

  It mirrors the extension's rule exactly: a usage event is a line with
  type == "llm_request" whose attrs has a model and at least one of
  copilotUsageNanoAiu / inputTokens / outputTokens. Exact credits = sum of
  attrs.copilotUsageNanoAiu / 1e9. Read-only. No network.

.PARAMETER AdditionalRoots
  Extra VS Code "User" storage roots (other profiles / Insiders). Point each at
  the folder that contains "workspaceStorage" — matches copilotCreditLens.additionalRoots.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\verify-usage.ps1
#>
param([string[]]$AdditionalRoots = @())

$ErrorActionPreference = 'SilentlyContinue'
$roots = @((Join-Path $env:APPDATA 'Code\User\workspaceStorage')) + $AdditionalRoots
$files = foreach ($r in $roots) {
  if (Test-Path $r) {
    Get-ChildItem $r -Recurse -File -Filter *.jsonl |
      Where-Object { $_.FullName -match '\\GitHub\.copilot-chat\\debug-logs\\' }
  }
}

$monthStart = Get-Date -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
$all   = [pscustomobject]@{ Requests = 0; ExactCredits = 0.0; Estimated = 0; InputTokens = 0; OutputTokens = 0; CachedTokens = 0 }
$month = [pscustomobject]@{ Requests = 0; ExactCredits = 0.0 }
$byModel = @{}

function Has($obj, $name) { $null -ne $obj -and ($obj.PSObject.Properties.Name -contains $name) }

foreach ($f in $files) {
  foreach ($ln in (Get-Content -LiteralPath $f.FullName)) {
    $t = $ln.Trim(); if (-not $t) { continue }
    try { $o = $t | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($o.type -ne 'llm_request') { continue }
    $a = $o.attrs; if ($null -eq $a) { continue }
    $model = [string]$a.model
    $hasNano = Has $a 'copilotUsageNanoAiu'
    $hasTok  = (Has $a 'inputTokens') -or (Has $a 'outputTokens')
    if (-not $model -or (-not $hasNano -and -not $hasTok)) { continue }   # extension's usage filter

    $credit = if ($hasNano) { [double]$a.copilotUsageNanoAiu / 1e9 } else { $null }
    $all.Requests++
    if ($null -ne $credit) { $all.ExactCredits += $credit } else { $all.Estimated++ }
    if (Has $a 'inputTokens')  { $all.InputTokens  += [long]$a.inputTokens }
    if (Has $a 'outputTokens') { $all.OutputTokens += [long]$a.outputTokens }
    if (Has $a 'cachedTokens') { $all.CachedTokens += [long]$a.cachedTokens }

    if ($o.ts) {
      $dt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$o.ts).LocalDateTime
      if ($dt -ge $monthStart) {
        $month.Requests++
        if ($null -ne $credit) { $month.ExactCredits += $credit }
      }
    }

    if (-not $byModel.ContainsKey($model)) {
      $byModel[$model] = [pscustomobject]@{ Model = $model; Requests = 0; ExactCredits = 0.0 }
    }
    $byModel[$model].Requests++
    if ($null -ne $credit) { $byModel[$model].ExactCredits += $credit }
  }
}

Write-Host ""
Write-Host "=== Copilot Credit Lens - independent verification ===" -ForegroundColor Green
Write-Host ("Debug-log files scanned : {0}" -f @($files).Count)
Write-Host ""
Write-Host "ALL TIME  (compare to dashboard period = 'All time', estimates OFF)"
Write-Host ("  Requests (metered)    : {0}" -f $all.Requests)
Write-Host ("  Exact credits (AIU)   : {0}" -f [math]::Round($all.ExactCredits, 4))
Write-Host ("  Requests w/o exact    : {0}  (shown as estimated in the extension)" -f $all.Estimated)
Write-Host ("  Input tokens          : {0}" -f $all.InputTokens)
Write-Host ("  Output tokens         : {0}" -f $all.OutputTokens)
Write-Host ("  Cached tokens         : {0}" -f $all.CachedTokens)
Write-Host ""
Write-Host ("CURRENT PERIOD  (since {0:yyyy-MM-01}; compare to 'Current period')" -f $monthStart)
Write-Host ("  Requests              : {0}" -f $month.Requests)
Write-Host ("  Exact credits (AIU)   : {0}" -f [math]::Round($month.ExactCredits, 4))
Write-Host ""
Write-Host "BY MODEL  (all time)"
$byModel.Values |
  Sort-Object ExactCredits -Descending |
  Format-Table Model, Requests, @{ N = 'ExactCredits'; E = { [math]::Round($_.ExactCredits, 4) } } -AutoSize

Write-Host "Note: figures should match the dashboard. Small differences can occur if a"
Write-Host "scan is mid-write, or if identical duplicate events exist (the extension"
Write-Host "de-duplicates; this script does not)."
