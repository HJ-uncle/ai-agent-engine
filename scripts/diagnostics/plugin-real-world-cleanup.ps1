param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.e2e-tmp/plugin-real-world-20261112/ai'))
$runNames = @('2026-11-12T06-16-27-001Z-d935d40e', '2026-11-12T06-23-59-954Z-e2f8ed3d', '2026-11-12T06-23-59-955Z-d742d5d1')
$roots = @($runNames | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $taskRoot $_)) })
function Assert-OwnedPath([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  if (-not $absolute.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path escaped exact task root' }
  for ($cursor = $absolute; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup path traverses a link or junction' }
    }
  }
  return $absolute
}
function Assert-NoTreeLinks([string]$Directory) {
  foreach ($entry in Get-ChildItem -Force -LiteralPath $Directory) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Credential profile contains a link or junction' }
    if ($entry.PSIsContainer) { Assert-NoTreeLinks $entry.FullName }
  }
}
function Assert-Stopped {
  $owned = @(Get-CimInstance Win32_Process | Where-Object {
    $line = $_.CommandLine
    if (-not $line) { return $false }
    $normalized = $line.Replace('/', '\')
    $running = $false
    foreach ($root in $roots) {
      if ($normalized.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $running = $true }
    }
    return $running -or $normalized.Contains('plugin-real-world-credentials.cjs')
  })
  if ($owned.Count -ne 0) { throw ('Owned model process still running: ' + (($owned | ForEach-Object { $_.ProcessId }) -join ',')) }
}
$databaseCleanup = @'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const path=process.argv[1],execute=process.argv[2]==='execute',model='deepseek-v4.1-flash-1017';
const db=new DatabaseSync(path,{readOnly:!execute});
let before,after;
try {
  const count=()=>Number(db.prepare('SELECT count(*) AS n FROM models WHERE model_id=?').get(model).n);
  before=count();
  const other=Number(db.prepare('SELECT count(*) AS n FROM models WHERE model_id<>?').get(model).n);
  assert.equal(other,0,'Unexpected model record in isolated DB');
  assert(before<=1,'Unexpected duplicate model rows');
  if(execute){
    db.exec('PRAGMA secure_delete=ON');
    assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete,1);
    db.prepare('DELETE FROM models WHERE model_id=?').run(model);
    assert.equal(count(),0);
    const checkpoint=()=>{const row=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();assert.equal(row.busy,0,'WAL checkpoint was blocked');};
    checkpoint();db.exec('VACUUM');checkpoint();
  }
  after=count();
} finally { db.close(); }
if(execute){const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(Number(check.prepare('SELECT count(*) AS n FROM models WHERE model_id=?').get(model).n),0);}finally{check.close();}}
console.log(JSON.stringify({database:path,selectedModelRowsBefore:before,selectedModelRowsAfter:after,secureDeleteAndVacuum:execute,readOnlyReopenVerified:execute}));
'@
Assert-Stopped
$checks = @()
foreach ($root in $roots) {
  $root = Assert-OwnedPath $root
  $database = Assert-OwnedPath (Join-Path $root 'state/agent.db')
  $key = Assert-OwnedPath (Join-Path $root 'isolated-engine-key.encrypted.json')
  $profile = Assert-OwnedPath (Join-Path $root 'credential-profile')
  $report = Get-Content -Raw -LiteralPath (Join-Path $root 'report.json') | ConvertFrom-Json
  if ($report.status -ne 'passed') { throw 'Final author report is not passed' }
  foreach ($scenario in $report.scenarios.PSObject.Properties.Value) {
    if ($scenario.status -ne 'passed' -or $scenario.selectedUse.status -ne 'passed') { throw 'Final scenario is not accepted' }
    $zip = Assert-OwnedPath $scenario.export.zipPath
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $scenario.export.sha256) { throw 'Final export hash changed' }
  }
  if (Test-Path -LiteralPath $profile) { Assert-NoTreeLinks $profile }
  $mode = if ($Execute) { 'execute' } else { 'check' }
  $dbOutput = & node --input-type=module -e $databaseCleanup $database $mode
  if ($LASTEXITCODE -ne 0) { throw 'Isolated credential database cleanup failed' }
  $result = $dbOutput | ConvertFrom-Json
  if ($Execute) {
    Assert-Stopped
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath (Assert-OwnedPath $key) -Force }
    if (Test-Path -LiteralPath $profile) {
      $profile = Assert-OwnedPath $profile
      Assert-NoTreeLinks $profile
      Remove-Item -LiteralPath $profile -Recurse -Force
    }
    if ((Test-Path -LiteralPath $key) -or (Test-Path -LiteralPath $profile)) { throw 'Private test credential files remain' }
  }
  $checks += [ordered]@{ root=$root; database=$result; keyPath=$key; keyAbsent=(-not (Test-Path -LiteralPath $key)); profilePath=$profile; profileAbsent=(-not (Test-Path -LiteralPath $profile)); status=$(if ($Execute) { 'cleaned' } else { 'checked' }) }
}
$receipt = [ordered]@{ completedAt=[DateTime]::UtcNow.ToString('o'); executed=[bool]$Execute; sourceDevelopmentProfileModified=$false; scope='Only three exact owned isolated AI acceptance runs'; processesStopped=$true; runs=$checks; portablePackagesPreserved=$true; originalSessionResumeRequiresNewAuthorizedBootstrap=[bool]$Execute }
$receiptPath = Join-Path $taskRoot $(if ($Execute) { 'private-cleanup-receipt.json' } else { 'private-cleanup-preflight.json' })
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output ($receipt | ConvertTo-Json -Depth 10)
