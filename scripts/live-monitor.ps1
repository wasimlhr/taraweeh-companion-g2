# Live monitor backend terminal logs
# Run: .\scripts\live-monitor.ps1
# Press Ctrl+C to stop

$terminalsDir = "$env:USERPROFILE\.cursor\projects\d-G2-DEV-QuranLiveMeaning\terminals"
$files = Get-ChildItem $terminalsDir -Filter "*.txt" | Sort-Object LastWriteTime -Descending

if ($files.Count -eq 0) {
  Write-Host "No terminal files found in $terminalsDir"
  exit 1
}

# Pick terminal that contains backend output (node server / Pipeline) - skip our own
$target = $null
foreach ($f in $files) {
  $content = Get-Content $f.FullName -First 50 -ErrorAction SilentlyContinue | Out-String
  if ($content -match "node server|Pipeline|KeywordMatcher") {
    $target = $f.FullName
    break
  }
}
if (-not $target) { $target = $files[0].FullName }
Write-Host "Monitoring: $target" -ForegroundColor Cyan
Write-Host "---" -ForegroundColor DarkGray
Get-Content $target -Tail 20 -Wait
