#!/usr/bin/env bash
# Wrapper that ensures GH_CONFIG_DIR is always set, regardless of how gh is invoked.
# Claude Code's subprocess chain can strip environment variables, so we hardcode the path.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/opt/gh-config}"
exec /usr/bin/gh "$@"
