#!/usr/bin/env bash
# Wrapper that ensures GH_TOKEN is available for gh CLI authentication.
# Primary: GH_TOKEN is set by the sudo chain in start-claude.sh.
# Fallback: If Claude Code strips env vars from a subprocess, read from
# the root-owned token file via the targeted sudoers entry.
if [[ -z "${GH_TOKEN:-}" ]] && [[ -f /opt/gh-config/.ghtoken ]]; then
  GH_TOKEN=$(sudo -n /usr/bin/cat /opt/gh-config/.ghtoken 2>/dev/null) || true
  export GH_TOKEN
fi
exec /usr/bin/gh "$@"
