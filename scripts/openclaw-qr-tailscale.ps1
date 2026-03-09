# Generate OpenClaw node setup QR using your Tailscale IP (100.122.x.x).
# Usage:
#   .\scripts\openclaw-qr-tailscale.ps1
#   .\scripts\openclaw-qr-tailscale.ps1 -Ip "100.122.231.66" -Port 18789
#   .\scripts\openclaw-qr-tailscale.ps1 -SetupCodeOnly
#
# With TLS (wss), use -UseTls (default). Without TLS use -UseTls:$false (ws).
#
# If pairing fails or "device identity required", add under gateway in ~/.openclaw/openclaw.json:
#   "controlUi": { "allowInsecureAuth": true, "allowNodeTokenOnly": true }
# Then restart the gateway.

param(
    [string] $Ip = "100.122.231.66",
    [int]    $Port = 18789,
    [switch] $UseTls = $true,
    [switch] $SetupCodeOnly,
    [switch] $Json
)

$scheme = if ($UseTls) { "wss" } else { "ws" }
$url = "${scheme}://${Ip}:${Port}"

Write-Host "Gateway URL: $url" -ForegroundColor Cyan
Write-Host ""

$args = @("qr", "--url", $url)
if ($SetupCodeOnly) { $args += "--setup-code-only" }
if ($Json)         { $args += "--json" }

& openclaw @args
