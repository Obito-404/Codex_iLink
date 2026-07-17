$ErrorActionPreference = "Stop"

try {
    $rawInput = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawInput)) {
        exit 0
    }

    $hook = $rawInput | ConvertFrom-Json
    $probeDirectory = $env:CODEX_ILINK_PROBE_DIR
    if ([string]::IsNullOrWhiteSpace($probeDirectory)) {
        $probeDirectory = Join-Path $env:LOCALAPPDATA "Codex_iLink\probe"
    }

    [System.IO.Directory]::CreateDirectory($probeDirectory) | Out-Null

    $event = [ordered]@{
        schemaVersion = 1
        capturedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
        sessionId = $hook.session_id
        turnId = $hook.turn_id
        cwd = $hook.cwd
        eventName = $hook.hook_event_name
        model = $hook.model
        permissionMode = $hook.permission_mode
        toolName = $hook.tool_name
        source = $hook.source
    }

    $json = $event | ConvertTo-Json -Compress
    $path = Join-Path $probeDirectory "hooks.jsonl"
    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::AppendAllText($path, $json + [Environment]::NewLine, $utf8WithoutBom)
}
catch {
    # Probe hooks are fail-open by design and must never block Codex.
}

exit 0
