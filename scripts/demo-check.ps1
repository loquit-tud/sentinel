param(
  [int]$TimeoutSec = 12
)

$ErrorActionPreference = "Stop"

$urls = @(
  "https://sentinel-dashboard-3uy.pages.dev",
  "https://sentinel-api.apiworkersdev.workers.dev/health",
  "https://sentinel-api.apiworkersdev.workers.dev/v1/demo",
  "https://sentinel-api.apiworkersdev.workers.dev/v1/alerts/feed",
  "https://sentinel-api.apiworkersdev.workers.dev/v1/watch/catches?limit=10",
  "https://sentinel-api.apiworkersdev.workers.dev/stats"
)

Write-Host ""
Write-Host "Sentinel demo check" -ForegroundColor Cyan
Write-Host "Timeout per URL: $TimeoutSec sec" -ForegroundColor Gray
Write-Host ""

$okCount = 0

foreach ($u in $urls) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-WebRequest -Uri $u -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing
    $sw.Stop()
    $code = [int]$resp.StatusCode
    $ms = $sw.ElapsedMilliseconds
    $ct = $resp.Headers["Content-Type"]
    if ($code -ge 200 -and $code -lt 300) {
      $okCount += 1
      Write-Host ("OK   {0}ms  {1}  ({2})" -f $ms, $u, $ct) -ForegroundColor Green
    } else {
      Write-Host ("FAIL {0}ms  {1}  status={2}" -f $ms, $u, $code) -ForegroundColor Red
    }
  } catch {
    $sw.Stop()
    Write-Host ("ERR  {0}ms  {1}  {2}" -f $sw.ElapsedMilliseconds, $u, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ""
Write-Host ("Result: {0}/{1} URLs OK" -f $okCount, $urls.Count) -ForegroundColor Cyan
Write-Host ""

