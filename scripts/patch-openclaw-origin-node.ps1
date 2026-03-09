# Patch OpenClaw gateway: force-allow node connections (skip origin checks).
#
# Your default OpenClaw is the global install (e.g. C:\Program Files\nodejs\node_modules\openclaw).
# Patching there requires Administrator. Right-click PowerShell -> "Run as administrator", then:
#   & "d:\G2_DEV\QuranLiveMeaning\scripts\patch-openclaw-origin-node.ps1"
#
# If nothing changed (already patched), the script skips writing so you won't get Access Denied.
# Optional: set OPENCLAW_DIST_PATH to patch a different install.
#
# ANDROID NODE PAIRING: In ~/.openclaw/openclaw.json, under gateway add:
#   "controlUi": { "allowInsecureAuth": true, "allowNodeTokenOnly": true }
# allowInsecureAuth = allow pairing when not in a browser secure context (e.g. Tailscale).
# allowNodeTokenOnly = allow node to connect with token only when device identity verification fails.
# Then restart the gateway.

# Search order: env override, user npm, Program Files
$candidateDistPaths = @()
if ($env:OPENCLAW_DIST_PATH -and (Test-Path $env:OPENCLAW_DIST_PATH)) {
    $candidateDistPaths += $env:OPENCLAW_DIST_PATH.TrimEnd("\")
}
$userProfile = $env:USERPROFILE
$candidateDistPaths += "$userProfile\AppData\Roaming\npm\node_modules\openclaw\dist"
$candidateDistPaths += "$userProfile\.openclaw\node_modules\openclaw\dist"
$candidateDistPaths += "C:\Program Files\nodejs\node_modules\openclaw\dist"

$distPath = $null
foreach ($d in $candidateDistPaths) {
    if ((Test-Path $d) -and (Test-Path "$d\gateway-cli-CGzngtWK.js")) {
        $distPath = $d
        break
    }
}
if (-not $distPath) {
    Write-Error "OpenClaw dist not found. Tried: $($candidateDistPaths -join ', '). Set OPENCLAW_DIST_PATH to your openclaw\dist path."
    exit 1
}
Write-Host "Using OpenClaw dist: $distPath"

$gatewayFiles = @(
    "$distPath\gateway-cli-CGzngtWK.js",
    "$distPath\gateway-cli-BYMlAFfC.js"
)
$toPatch = @()
foreach ($p in $gatewayFiles) {
    if (Test-Path $p) { $toPatch += $p }
}
if ($toPatch.Count -eq 0) {
    Write-Error "No gateway bundle found in $distPath"
    exit 1
}
Write-Host "Patching $($toPatch.Count) gateway bundle(s)"

foreach ($gatewayPath in $toPatch) {
Write-Host "--- $gatewayPath ---"
$content = Get-Content $gatewayPath -Raw -Encoding UTF8
$originalContent = $content

# 0) Force-allow node: skip all origin checks when isNodeConnection
$old0 = @'
function checkBrowserOrigin(params) {
	const parsedOrigin = parseOrigin(params.origin);
'@
$new0 = @'
function checkBrowserOrigin(params) {
	if (params.isNodeConnection) return { ok: true };
	const parsedOrigin = parseOrigin(params.origin);
'@
if ($content -notlike "*if (params.isNodeConnection) return { ok: true }*") {
    $content = $content.Replace($old0, $new0)
    Write-Host "Applied patch 0: force-allow node (skip origin checks)"
} else {
    Write-Host "Patch 0 already applied (force-allow node)."
}

# 1) checkBrowserOrigin: allow private IP node when origin missing
$old1 = @'
function checkBrowserOrigin(params) {
	const parsedOrigin = parseOrigin(params.origin);
	if (!parsedOrigin) return {
		ok: false,
		reason: "origin missing or invalid"
	};
	if ((params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean).includes(parsedOrigin.origin)) return { ok: true };
'@
$new1 = @'
function checkBrowserOrigin(params) {
	const parsedOrigin = parseOrigin(params.origin);
	if (!parsedOrigin) {
		if (params.isNodeConnection && params.remoteAddress && isPrivateOrLoopbackAddress(params.remoteAddress)) return { ok: true };
		return { ok: false, reason: "origin missing or invalid" };
	}
	if ((params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean).includes(parsedOrigin.origin)) return { ok: true };
'@

if ($content -notlike "*params.isNodeConnection && params.remoteAddress*") {
    $content = $content.Replace($old1, $new1)
    Write-Host "Applied patch 1: checkBrowserOrigin private-IP node bypass"
} else {
    Write-Host "Patch 1 already applied (checkBrowserOrigin)."
}

# 2) Origin check for node connections + pass isNodeConnection/remoteAddress for Control UI
$old2 = @'
				const isControlUi = connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
				const isWebchat = isWebchatConnect(connectParams);
				if (isControlUi || isWebchat) {
					const originCheck = checkBrowserOrigin({
						requestHost,
						origin: requestOrigin,
						allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins
					});
'@
$new2 = @'
				const isControlUi = connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI;
				const isWebchat = isWebchatConnect(connectParams);
				const isNodeConnection = role === "node";
				if (isControlUi || isWebchat) {
					const originCheck = checkBrowserOrigin({
						requestHost,
						origin: requestOrigin,
						allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
						isNodeConnection: false,
						remoteAddress: remoteAddr
					});
'@

if ($content -notlike "*isNodeConnection = role === *node*") {
    $content = $content.Replace($old2, $new2)
    Write-Host "Applied patch 2: isNodeConnection and remoteAddress for Control UI/Webchat"
} else {
    Write-Host "Patch 2 (part A) already applied."
}

# 3) Add node branch: run origin check for node with bypass
$old3 = @'
						close(1008, truncateCloseReason(errorMessage));
						return;
					}
				}
				const deviceRaw = connectParams.device;
'@
$new3 = @'
						close(1008, truncateCloseReason(errorMessage));
						return;
					}
				} else if (isNodeConnection) {
					const originCheck = checkBrowserOrigin({
						requestHost,
						origin: requestOrigin,
						allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
						isNodeConnection: true,
						remoteAddress: remoteAddr
					});
					if (!originCheck.ok) {
						const errorMessage = "origin not allowed (node connections from private networks may omit Origin; public connections require it)";
						setHandshakeState("failed");
						setCloseCause("origin-mismatch", {
							origin: requestOrigin ?? "n/a",
							host: requestHost ?? "n/a",
							reason: originCheck.reason,
							client: connectParams.client.id,
							clientDisplayName: connectParams.client.displayName,
							mode: connectParams.client.mode,
							version: connectParams.client.version
						});
						send({
							type: "res",
							id: frame.id,
							ok: false,
							error: errorShape(ErrorCodes.INVALID_REQUEST, errorMessage)
						});
						close(1008, truncateCloseReason(errorMessage));
						return;
					}
				}
				const deviceRaw = connectParams.device;
'@

if ($content -notlike "*else if (isNodeConnection)*") {
    $content = $content.Replace($old3, $new3)
    Write-Host "Applied patch 3: origin check for node connections"
} else {
    Write-Host "Patch 3 already applied (node origin check)."
}

# 4) Always skip device identity for node (no config needed) — "simply pass" device step
$old4aPlain = "const canSkipDevice = sharedAuthOk;"
$old4aWithConfig = "const canSkipDevice = sharedAuthOk || (role === `"node`" && authOk && configSnapshot.gateway?.controlUi?.allowNodeTokenOnly === true);"
$new4a = "const canSkipDevice = sharedAuthOk || role === `"node`";"
if ($content -like "*$new4a*") {
    Write-Host "Patch 4a already applied (node always skip device)."
} elseif ($content -like "*$old4aWithConfig*") {
    $content = $content.Replace($old4aWithConfig, $new4a)
    Write-Host "Applied patch 4a: node always skip device (simplified)"
} elseif ($content -like "*$old4aPlain*") {
    $content = $content.Replace($old4aPlain, $new4a)
    Write-Host "Applied patch 4a: node always skip device"
}

# 4b) When client sends device but validation fails (e.g. signature), still allow node if token is valid
$old4b = "if (device) {"
$new4b = "if (device && !(role === `"node`" && sharedAuthOk)) {"
if ($content -like "*if (device && !(role === *node* && sharedAuthOk))*") {
    Write-Host "Patch 4b already applied (skip device validation for node when token ok)."
} elseif ($content -like "*if (device) {*") {
    $content = $content.Replace($old4b, $new4b)
    Write-Host "Applied patch 4b: node with valid token skips device validation even when device sent"
}

# 5) Handshake timeout: 10s -> 30s so Tailscale/slow links can complete connect
$old4 = "const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1e4;"
$new4 = "const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3e4;"
if ($content -notlike "*DEFAULT_HANDSHAKE_TIMEOUT_MS = 3e4*") {
    if ($content -like "*DEFAULT_HANDSHAKE_TIMEOUT_MS = 1e4*") {
        $content = $content.Replace($old4, $new4)
        Write-Host "Applied patch 4: handshake timeout 10s -> 30s"
    }
}

if ($content -ne $originalContent) {
    Set-Content -Path $gatewayPath -Value $content -Encoding UTF8 -NoNewline
    Write-Host "Written: $gatewayPath"
} else {
    Write-Host "No changes (already patched), skip write."
}
}

# Config schema: allow gateway.controlUi.allowNodeTokenOnly (so config validates)
$schemaOld = "dangerouslyDisableDeviceAuth: z.boolean().optional()"
$schemaNew = "dangerouslyDisableDeviceAuth: z.boolean().optional(),`n			allowNodeTokenOnly: z.boolean().optional()"
$toPatchConfig = @()
Get-ChildItem -Path $distPath -Filter "config-*.js" -File -ErrorAction SilentlyContinue | ForEach-Object { $toPatchConfig += $_.FullName }
foreach ($p in @("plugin-sdk\config-XgvPhLbB.js", "..\daemon-cli.js")) {
    $full = Join-Path $distPath $p
    if (Test-Path $full) { $toPatchConfig += $full }
}
foreach ($configPath in $toPatchConfig) {
    if (-not (Test-Path $configPath)) { continue }
    $c = Get-Content $configPath -Raw -Encoding UTF8
    if ($c -like "*allowNodeTokenOnly*") { continue }
    if ($c -like "*$schemaOld*") {
        $c = $c.Replace($schemaOld, $schemaNew)
        Set-Content -Path $configPath -Value $c -Encoding UTF8 -NoNewline
        Write-Host "Patched config schema (allowNodeTokenOnly): $configPath"
    }
}

Write-Host "Done. Restart OpenClaw gateway: openclaw gateway restart"
