$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\src' | Resolve-Path
$files = Get-ChildItem -Path $root -Recurse -Include *.ts, *.tsx -File
$rules = @(
    @{ Pattern = "from\s+['""](?:\.\./)+store/agents['""]";          Replacement = "from '@core/store/agents'" },
    @{ Pattern = "from\s+['""](?:\.\./)+store/explorer['""]";        Replacement = "from '@core/store/explorer'" },
    @{ Pattern = "from\s+['""](?:\.\./)+store/session['""]";         Replacement = "from '@core/store/session'" },
    @{ Pattern = "from\s+['""](?:\.\./)+store/terminal['""]";        Replacement = "from '@core/store/terminal'" },
    @{ Pattern = "from\s+['""](?:\.\./)+api(/index)?['""]";          Replacement = "from '@core/api'" },
    @{ Pattern = "from\s+['""](?:\.\./)+types(/index)?['""]";        Replacement = "from '@core/types'" },
    @{ Pattern = "from\s+['""](?:\.\./)+hooks/useBreakpoint['""]";   Replacement = "from '@core/hooks/useBreakpoint'" },
    @{ Pattern = "from\s+['""](?:\.\./)+hooks/useChat['""]";         Replacement = "from '@core/hooks/useChat'" },
    @{ Pattern = "from\s+['""](?:\.\./)+hooks/useFileIndex['""]";    Replacement = "from '@core/hooks/useFileIndex'" }
)
$total = 0
foreach ($f in $files) {
    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $f.FullName
    if ($null -eq $content) { continue }
    $orig = $content
    foreach ($r in $rules) {
        $content = [regex]::Replace($content, $r.Pattern, $r.Replacement)
    }
    if ($content -ne $orig) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($f.FullName, $content, $utf8NoBom)
        $total++
        $rel = $f.FullName.Substring($root.Path.Length + 1)
        Write-Host ('updated: ' + $rel)
    }
}
Write-Host ''
Write-Host ('Total files updated: ' + $total)
