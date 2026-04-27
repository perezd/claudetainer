#!/usr/bin/env bash
set -euo pipefail
# generate-stargate-config.sh — Generate Stargate config at boot from environment.
# allowed_domains is derived exclusively from domains.conf and must not be expanded independently.

# === 1. Set config path ===
export STARGATE_CONFIG=/opt/stargate/stargate.toml

# === 2. Create directory ===
mkdir -p /opt/stargate && chmod 755 /opt/stargate

# === 3. Symlink guard ===
[[ -L "$STARGATE_CONFIG" ]] && rm -f "$STARGATE_CONFIG"

# === 4. Write defaults ===
# stargate init writes the embedded default config (~588 lines of TOML, 83 rules)
/usr/local/bin/stargate init --config "$STARGATE_CONFIG"

# === 5. Extract GitHub owner from REPO_URL ===
GITHUB_OWNER=""
if [[ -n "${REPO_URL:-}" ]]; then
    _extracted=$(echo "$REPO_URL" | sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p')
    if [[ "$_extracted" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*$ ]]; then
        GITHUB_OWNER="$_extracted"
    else
        echo "[STARGATE] WARN: REPO_URL owner failed validation, using empty github_owners (fail-closed)" >&2
    fi
fi

# === 6. Build allowed_domains from domains.conf ===
ALLOWED_DOMAINS="["
first=true
while IFS= read -r line || [[ -n "$line" ]]; do
    # Strip comments and blank lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    domain=$(echo "$line" | tr -d '[:space:]')
    if [[ "$first" == "true" ]]; then
        ALLOWED_DOMAINS+="\"${domain}\""
        first=false
    else
        ALLOWED_DOMAINS+=", \"${domain}\""
    fi
done < /opt/network/domains.conf
ALLOWED_DOMAINS+="]"

# === 7. Patch [scopes] section ===
if [[ -z "$GITHUB_OWNER" ]]; then
    sed -i "s|^github_owners = .*|github_owners = []|" "$STARGATE_CONFIG"
else
    sed -i "s|^github_owners = .*|github_owners = [\"${GITHUB_OWNER}\"]|" "$STARGATE_CONFIG"
fi
sed -i "s|^allowed_domains = .*|allowed_domains = ${ALLOWED_DOMAINS}|" "$STARGATE_CONFIG"

# === 8. Append targeted RED rule for credential file ===
# Insert before the "# === GREEN Rules" section marker, which immediately follows the last RED rule.
GREEN_LINE=$(grep -n '# === GREEN Rules' "$STARGATE_CONFIG" | head -1 | cut -d: -f1)
if [[ -z "$GREEN_LINE" ]]; then
    echo "[STARGATE] ERROR: '# === GREEN Rules' marker not found in config — cannot insert credential protection rule" >&2
    exit 1
fi
sed -i "${GREEN_LINE}i\\
\\
[[rules.red]]\\
command = \"cat\"\\
args = [\"/opt/gh-config/.ghtoken\", \"/opt/gh-config/*\"]\\
reason = \"Direct read of credential file.\"" "$STARGATE_CONFIG"

# === 9. Patch [telemetry] section ===
if [[ -n "${GRAFANA_INSTANCE_ID:-}" ]] && [[ -n "${GRAFANA_API_TOKEN:-}" ]] && [[ -n "${GRAFANA_OTLP_ENDPOINT:-}" ]]; then
    # Enable telemetry and set the endpoint
    sed -i '/^\[telemetry\]/,/^$/{
        s|^enabled = .*|enabled = true|
        s|^endpoint = .*|endpoint = "'"${GRAFANA_OTLP_ENDPOINT}"'"|
    }' "$STARGATE_CONFIG"
else
    # Ensure telemetry is disabled
    sed -i '/^\[telemetry\]/,/^$/{
        s|^enabled = .*|enabled = false|
    }' "$STARGATE_CONFIG"
fi

# === 10. Lock permissions ===
chmod 444 "$STARGATE_CONFIG"

echo "[STARGATE] Config generated at $STARGATE_CONFIG"
