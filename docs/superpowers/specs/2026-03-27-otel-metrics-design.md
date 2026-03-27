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
- **Outbound HTTPS only** to the operator-configured OTLP gateway hostname (e.g., `otlp-gateway-prod-us-west-2.grafana.net`). The domain is dynamically injected into CoreDNS and iptables at boot — no static allowlist entry, no network access when the feature is off.
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

**Data residency:** When enabled with full fidelity, user prompt content and tool parameters leave the container and are stored in Grafana Cloud (a third-party system). The operator is responsible for ensuring this meets their data residency and privacy requirements. The `session_id` and `user_account_uuid` resource attributes on metrics are pseudonymous identifiers that could be correlated to individuals — these become visible to anyone with Grafana Cloud dashboard access.

### Activation logic

Activation is split into two phases in `entrypoint.sh` to satisfy boot-order dependencies (network setup must precede OTLP export). See **Boot Sequence Integration** below for the full logic and sequencing.

When the variables are not set, no OTEL env vars are injected, no domain is added to the network layer, and Claude Code behaves exactly as it does today.

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

The OTEL setup uses **two-phase activation** in `entrypoint.sh`. The network setup (CoreDNS + iptables) must happen before Claude Code can export, so hostname extraction runs early, while env var export happens later.

### Phase 1: Network setup (before CoreDNS/iptables)

If Grafana credentials are present, extract the hostname from `GRAFANA_OTLP_ENDPOINT` and inject it into the network layer:

```bash
# Early in entrypoint, before CoreDNS config generation
if [ -n "${GRAFANA_INSTANCE_ID:-}" ] && [ -n "${GRAFANA_API_TOKEN:-}" ] && [ -n "${GRAFANA_OTLP_ENDPOINT:-}" ]; then
  GRAFANA_HOST=$(echo "$GRAFANA_OTLP_ENDPOINT" | sed 's|https\?://||' | cut -d/ -f1 | cut -d: -f1)
  echo "[ENTRYPOINT] OTEL: will allow outbound to $GRAFANA_HOST"
fi
```

The extracted `GRAFANA_HOST` is then:

1. **Appended to the CoreDNS config** as a forward zone (during the existing domain iteration loop), so DNS queries for the OTLP gateway resolve correctly.
2. **Resolved and added to iptables** ACCEPT rules (during the existing iptables refresh), so outbound HTTPS to the gateway IPs is permitted.

### Phase 2: Env var export (before Claude Code settings copy)

The OTEL env vars are exported in the existing step 6 position, after network setup is complete:

```bash
if [ -n "${GRAFANA_HOST:-}" ]; then
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

### Updated boot sequence

```
1. Validate secrets
2. Mount tmpfs
3. ** Extract GRAFANA_HOST from GRAFANA_OTLP_ENDPOINT (if credentials set) **
4. Start CoreDNS (with GRAFANA_HOST in forward config, if set)
5. Apply iptables (with GRAFANA_HOST resolved to IPs, if set)
6. Configure git/gh/npm auth
7. ** Export OTEL env vars (if GRAFANA_HOST was extracted) **
8. Copy Claude settings
9. Remount rootfs read-only
10. Clone repo
11. Readiness checks
```

No new background processes. No config files to generate. No auto-restart loops.

The env vars are exported in the entrypoint (PID 1) shell, so they are inherited by all child processes including the Claude Code session launched via `start-claude.sh` → tmux.

## Network and Security Changes

### Domain allowlist

**No static changes to `domains.conf`.** The OTLP gateway domain is dynamically injected into CoreDNS and iptables at boot (see Boot Sequence Integration above). When the feature is off, no Grafana-related domain is allowed — zero network impact.

This approach is more precise than a static wildcard: only the exact operator-configured hostname gets network access, and only when all three credentials are present.

### Credential protection

New rules in `approval/rules.conf`:

```conf
# Tier 1: hard-block direct variable references
block-pattern:\$\{?(GRAFANA_API_TOKEN|GRAFANA_INSTANCE_ID)\b

# Tier 2: hot-word escalation for indirect references
hot:GRAFANA_API_TOKEN
hot:GRAFANA_INSTANCE_ID
hot:OTEL_EXPORTER_OTLP_HEADERS
```

`OTEL_EXPORTER_OTLP_HEADERS` contains the base64-encoded credentials and is escalated to Tier 2 to prevent indirect access.

### Layer impact assessment

| Layer               | Impact                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container Hardening | **None** — no new binaries, no config files, no privilege changes                                                                                        |
| Network Isolation   | **Dynamic domain injection** — OTLP gateway hostname extracted from `GRAFANA_OTLP_ENDPOINT` and added to CoreDNS + iptables at boot. No change when off. |
| Command Approval    | **Two new credentials protected** — `GRAFANA_API_TOKEN` and `GRAFANA_INSTANCE_ID` (Tier 1 + Tier 2), plus `OTEL_EXPORTER_OTLP_HEADERS` (Tier 2)          |

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
