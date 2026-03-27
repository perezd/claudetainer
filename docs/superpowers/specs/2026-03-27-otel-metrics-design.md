# OTEL Telemetry Export to Grafana Cloud

## Overview

Export Claude Code's native OpenTelemetry telemetry (metrics and logs/events) to Grafana Cloud via direct OTLP push. No collector sidecar, no new binaries, no Dockerfile changes.

The feature is **opt-in** and **disabled by default** — it activates only when Grafana Cloud credentials are set (`GRAFANA_INSTANCE_ID`, `GRAFANA_API_TOKEN`, `GRAFANA_OTLP_ENDPOINT`).

## Architecture

Grafana Cloud accepts OTLP data directly via its OTLP gateway. The gateway multiplexes incoming signals to the appropriate backend: metrics to Mimir, logs/events to Loki, traces to Tempo.

```
+--------------------------------------------------+
|  Claudetainer (Fly Machine)                      |
|                                                  |
|  +--------------+                                |
|  |  Claude Code  |                               |
|  |              |                                |
|  |  OTLP/HTTP ──────────────────────────────────────> Grafana Cloud
|  +--------------+           (push)               |    OTLP Gateway
|                                                  |
+--------------------------------------------------+         |
                                                        +----+----+
                                                        |    |    |
                                                      Mimir Loki Tempo
                                                   (metrics)(logs)(traces)
```

- Claude Code sends OTLP/HTTP directly to Grafana Cloud's OTLP gateway.
- **Push-based** — no exposed ports, no inbound scraping, no listening endpoint.
- **No new processes.** No sidecar. No new binary. Just environment variables.
- **Outbound HTTPS only** to `*.grafana.net`.
- **Metrics and events** are exported. Claude Code does not currently emit OTEL traces — if trace support is added in the future, setting `OTEL_TRACES_EXPORTER=otlp` would route them to Tempo with no other changes.

## Opt-in Mechanism

### Operator-provided environment variables

| Variable                | Required        | Purpose                                                                              |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `GRAFANA_INSTANCE_ID`   | Yes (to enable) | Grafana Cloud instance ID (numeric, from portal)                                     |
| `GRAFANA_API_TOKEN`     | Yes (to enable) | Cloud Access Policy token with OTLP write permissions                                |
| `GRAFANA_OTLP_ENDPOINT` | Yes (to enable) | Full OTLP gateway URL (e.g., `https://otlp-gateway-prod-us-west-2.grafana.net/otlp`) |
| `OTEL_LOG_USER_PROMPTS` | No              | Set to `0` to exclude prompt content from events (default: `1` — full fidelity)      |
| `OTEL_LOG_TOOL_DETAILS` | No              | Set to `0` to exclude tool parameters from events (default: `1` — full fidelity)     |

All three credential/endpoint variables must be set to activate the feature. Missing any one = feature off, zero telemetry, zero outbound traffic.

### Internally set environment variables (when enabled)

Set by `entrypoint.sh` before Claude Code launches:

| Variable                       | Value                          | Purpose                                  |
| ------------------------------ | ------------------------------ | ---------------------------------------- |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1`                            | Master telemetry switch                  |
| `OTEL_METRICS_EXPORTER`        | `otlp`                         | Export metrics via OTLP                  |
| `OTEL_LOGS_EXPORTER`           | `otlp`                         | Export events via OTLP                   |
| `OTEL_EXPORTER_OTLP_PROTOCOL`  | `http/protobuf`                | Required by Grafana Cloud                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `${GRAFANA_OTLP_ENDPOINT}`     | OTLP gateway URL                         |
| `OTEL_EXPORTER_OTLP_HEADERS`   | `Authorization=Basic <base64>` | Constructed from instance ID + token     |
| `OTEL_LOG_USER_PROMPTS`        | `${OTEL_LOG_USER_PROMPTS:-1}`  | Full fidelity by default, opt-out to `0` |
| `OTEL_LOG_TOOL_DETAILS`        | `${OTEL_LOG_TOOL_DETAILS:-1}`  | Full fidelity by default, opt-out to `0` |

### Privacy controls (full fidelity by default)

When the feature is enabled, both privacy toggles default to ON:

| Variable                | Default | Behavior when ON                                                                                         | Behavior when OFF             |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `OTEL_LOG_USER_PROMPTS` | `1`     | Full prompt text included in `user_prompt` events                                                        | Only prompt length recorded   |
| `OTEL_LOG_TOOL_DETAILS` | `1`     | Tool parameters and input included in `tool_result` events (truncated at 512 chars per value, ~4K total) | Tool name only, no parameters |

The rationale: if you've provided Grafana Cloud credentials, you want full observability. Privacy reduction is opt-out, not opt-in.

Note: raw file contents and code snippets are never included in telemetry regardless of these settings.

### Activation logic

```bash
if [ -n "${GRAFANA_INSTANCE_ID:-}" ] && [ -n "${GRAFANA_API_TOKEN:-}" ] && [ -n "${GRAFANA_OTLP_ENDPOINT:-}" ]; then
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_METRICS_EXPORTER=otlp
  export OTEL_LOGS_EXPORTER=otlp
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  export OTEL_EXPORTER_OTLP_ENDPOINT="$GRAFANA_OTLP_ENDPOINT"
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n "${GRAFANA_INSTANCE_ID}:${GRAFANA_API_TOKEN}" | base64 -w 0)"
  export OTEL_LOG_USER_PROMPTS="${OTEL_LOG_USER_PROMPTS:-1}"
  export OTEL_LOG_TOOL_DETAILS="${OTEL_LOG_TOOL_DETAILS:-1}"
  echo "[ENTRYPOINT] OTEL telemetry enabled → ${GRAFANA_OTLP_ENDPOINT}"
fi
```

When the variables are not set, no OTEL env vars are injected and Claude Code behaves exactly as it does today.

## What You Get in Grafana Cloud

### Metrics (→ Mimir)

| Metric                  | Type    | Description                                                                                          |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Active usage time       | Counter | Time spent actively using Claude Code (excludes idle)                                                |
| Session count           | Counter | Incremented at session start                                                                         |
| API request tokens/cost | Counter | Token counts and cost per API request (segmented by type: input, output, cache_creation, cache_read) |
| Lines of code           | Counter | Lines added/removed                                                                                  |
| Pull requests           | Counter | PRs created via Claude Code                                                                          |
| Commits                 | Counter | Git commits created via Claude Code                                                                  |

Metrics include standard OTEL resource attributes as labels: `model`, `app_version`, `session_id`, `user_account_uuid`, `organization_id`.

### Events (→ Loki)

| Event         | Description                | Key Attributes                                                              |
| ------------- | -------------------------- | --------------------------------------------------------------------------- |
| `user_prompt` | Emitted per user prompt    | Prompt content (full text by default), prompt length, `prompt.id`           |
| `api_request` | Emitted per API call       | Model, token counts, cost, `prompt.id`                                      |
| `tool_result` | Emitted per tool execution | Tool name, parameters, input (bash commands, file paths, URLs), `prompt.id` |

All events from a single user prompt share the same `prompt.id` (UUID), enabling full prompt → API call → tool execution correlation in Grafana.

### What you do NOT get

- **Traces** — Claude Code does not currently emit OTEL traces. If trace support is added, setting `OTEL_TRACES_EXPORTER=otlp` would route them to Tempo with no other changes needed.
- **Raw file contents** — never included in telemetry regardless of privacy settings.

## Dockerfile Changes

**None.** No new binary, no config template, no image size change. The entire feature is activated via environment variables in `entrypoint.sh`.

## Boot Sequence Integration

The OTEL setup is a conditional env var export in `entrypoint.sh`. It slots in **before Claude Code settings copy** so the env vars are available when Claude Code launches.

```
1. Validate secrets
2. Mount tmpfs
3. Start CoreDNS
4. Apply iptables
5. Configure git/gh/npm auth
6. ** Set OTEL env vars (if Grafana credentials are set) **
7. Copy Claude settings
8. Remount rootfs read-only
9. Clone repo
10. Readiness checks
```

No new background processes. No config files to generate. No auto-restart loops.

The env vars are exported in the entrypoint (PID 1) shell, so they are inherited by all child processes including the Claude Code session launched via `start-claude.sh` → tmux.

## Network and Security Changes

### Domain allowlist

Add to `domains.conf`:

```
*.grafana.net
```

This covers all Grafana Cloud regions (`otlp-gateway-prod-*.grafana.net`) and the Grafana UI.

### Credential protection

New rules in `approval/rules.conf`:

```conf
# Tier 1: hard-block direct variable references
block-pattern:\$\{?(GRAFANA_API_TOKEN|GRAFANA_INSTANCE_ID)\b

# Tier 2: hot-word escalation for indirect references
hot:GRAFANA_API_TOKEN
hot:GRAFANA_INSTANCE_ID
```

### Layer impact assessment

| Layer               | Impact                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Container Hardening | **None** — no new binaries, no config files, no privilege changes                                                                 |
| Network Isolation   | **One wildcard domain added** — `*.grafana.net` for outbound OTLP push (HTTPS only)                                               |
| Command Approval    | **Two new credentials protected** — `GRAFANA_API_TOKEN` and `GRAFANA_INSTANCE_ID` added to Tier 1 block and Tier 2 hot-word rules |

### Exposed ports

**None.** This is push-based — no listening port, no inbound traffic. Strictly simpler security posture than a Prometheus scrape endpoint approach.

## Testing and Validation

### Feature-off path

Deploy without Grafana credentials. Confirm: no OTEL env vars in Claude Code's environment, no outbound traffic to `grafana.net`, no behavior change.

### Feature-on path

Deploy with `GRAFANA_INSTANCE_ID`, `GRAFANA_API_TOKEN`, and `GRAFANA_OTLP_ENDPOINT` set. Confirm: Claude Code has `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, and `OTEL_LOGS_EXPORTER=otlp` in its environment. Run a session, check Grafana Cloud for metrics and events appearing.

### Privacy opt-out

Deploy with `OTEL_LOG_USER_PROMPTS=0`. Confirm `user_prompt` events contain only prompt length, not content. Deploy with `OTEL_LOG_TOOL_DETAILS=0`. Confirm `tool_result` events contain tool name only, no parameters.

### No automated integration test

The full pipeline requires a live Grafana Cloud account. Validation is manual via the Grafana Cloud UI. The OTEL export can be verified locally by pointing `GRAFANA_OTLP_ENDPOINT` at a local OTEL Collector with debug logging enabled.
