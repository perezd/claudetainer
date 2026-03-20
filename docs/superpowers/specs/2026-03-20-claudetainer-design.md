# Claudetainer: Interactive Claude Code Development Environment

A Docker container deployed to Fly.io that provides a persistent, interactive Claude Code environment accessible via SSH. The container runs Claude Code with a custom permission system and a GitHub robot identity for committing code.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│ Fly Machine (shared-cpu-1x, 512MB)              │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Docker Container (debian:bookworm-slim)    │  │
│  │                                            │  │
│  │  entrypoint.sh                             │  │
│  │    ├── configure git identity + PAT        │  │
│  │    ├── install superpowers plugin           │  │
│  │    └── start tmux → claude --skip-perms    │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │ tmux session "claude"                │  │  │
│  │  │  WORKDIR: /workspace                 │  │  │
│  │  │                                      │  │  │
│  │  │  claude --dangerously-skip-perms     │  │  │
│  │  │    │                                 │  │  │
│  │  │    ├── PreToolUse hook               │  │  │
│  │  │    │   └── check-command.sh          │  │  │
│  │  │    │       ├── reads rules.conf      │  │  │
│  │  │    │       └── inspects tool_name    │  │  │
│  │  │    │                                 │  │  │
│  │  │    └── MCP servers                   │  │  │
│  │  │        ├── GitHub (PAT auth)         │  │  │
│  │  │        └── Bun docs                  │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
        ▲
        │ fly ssh console → tmux attach
        │
    Developer
```

## Container Image

### Base Image

`debian:bookworm-slim` — minimal footprint, we install only what we need.

### Installed Tooling

- **Bun** — project runtime, installed via official install script
- **Python 3** — Claude Code frequently uses it for scripting tasks
- **Claude Code** — installed via `curl -fsSL https://claude.ai/install.sh | bash` (self-contained binary, no Node.js dependency)
- **gh** — GitHub CLI, authenticates via `GH_TOKEN` env var
- **CLI tools:** jq, ripgrep, fd-find, git, curl, wget, tmux, less, tree

### Claude Code Configuration

A `claude-settings.json` file is baked into the image at `/root/.claude/settings.json`. It contains:

- **PreToolUse hook** pointing to `/opt/approval/check-command.sh` (matcher matches all tools)
- **MCP servers:**
  - GitHub: `https://api.githubcopilot.com/mcp/` with `Authorization: Bearer <GH_PAT>`
  - Bun docs: `https://bun.com/docs/mcp`

Note: Claude Code settings files do not support environment variable interpolation. The entrypoint script uses `sed` or `envsubst` to substitute `<GH_PAT>` with the actual value of `$GH_PAT` at container startup before Claude Code reads the file.

### Superpowers Plugin

Installed at first boot by the entrypoint script via `claude plugin install superpowers@claude-plugins-official`. If the install fails (network issue, registry unreachable), the entrypoint logs a warning and continues — Claude Code still works without the plugin.

## Permission System

### Mode

Claude Code runs with `--dangerously-skip-permissions`. A single PreToolUse hook provides all permission enforcement.

### Hook Architecture

The hook script (`/opt/approval/check-command.sh`) receives JSON on stdin from Claude Code with the following structure:

```json
{"tool_name": "Bash", "tool_input": {"command": "bun add react"}}
```

For file-writing tools:

```json
{"tool_name": "Write", "tool_input": {"file_path": "/opt/approval/rules.conf", "content": "..."}}
{"tool_name": "Edit", "tool_input": {"file_path": "/root/.claude/settings.json", "old_string": "...", "new_string": "..."}}
```

The hook script uses `jq` to extract `tool_name` and routes accordingly:

1. **If `tool_name` is `Bash`:** extract `.tool_input.command`, evaluate against `rules.conf` patterns
2. **If `tool_name` is `Write` or `Edit`:** extract `.tool_input.file_path`, check against protected path list
3. **All other tools** (`Read`, `Glob`, `Grep`, etc.): auto-approve (exit 0)

### Protected Paths

The following paths are hard-blocked from `Write` and `Edit` tools (exit 2):

- `/opt/approval/` — the approval system itself (prefix match: any file under this directory)
- `/root/.claude/settings.json` — Claude Code configuration (hooks, MCP servers)
- `/usr/local/bin/approve` — the approval CLI tool

The hook script canonicalizes paths using `realpath` before checking, preventing symlink or path traversal bypasses (e.g., `/opt/approval/../approval/rules.conf`).

### Rules Configuration

`/opt/approval/rules.conf` — line-based format with regex patterns for Bash commands. Rules are evaluated top-to-bottom, first match wins:

```
# Auto-approve patterns (exit 0)
allow:^git\b
allow:^(ls|cat|head|tail|cp|mv|mkdir|touch|tree|less)\b
allow:^(grep|rg|fd|find|ag)\b
allow:^bun (run|test|build|check)\b
allow:^(python3?|echo|pwd|cd|env|which)\b
allow:^(wc|sort|uniq|diff|sed|awk|xargs|tee|basename|dirname)\b
allow:^gh (pr|issue|repo view|repo clone|api)\b

# Hard-block patterns (exit 2, cannot be approved)
block:.*\|\s*(ba)?sh
block:^sudo\b
block:^rm\s+-rf\s+/
block:^chmod\s+777\b
block:.*/opt/approval/
block:^approve\b

# Approval-required patterns (exit 2 with approval instructions)
approve:^(apt-get|apt)\s+install\b
approve:^bun\s+(add|install)\b
approve:^(pip3?|pipx)\s+install\b
approve:^curl\b
approve:^wget\b

# Default behavior for unmatched commands
# "allow" = auto-approve, "block" = hard-block
default:allow
```

### Three Tiers

Both `block:` and `approve:` tiers use exit code 2 (which tells Claude Code the tool call is blocked). The difference is the message — `approve:` includes instructions for the user to approve the command.

| Tier | Exit Code | Behavior |
|------|-----------|----------|
| **Auto-approve** (`allow:`) | 0 | Command runs immediately |
| **Hard-block** (`block:`) | 2 | Command is rejected, cannot be overridden |
| **Approval-required** (`approve:`) | 2 | Command is blocked with message: `⛔ Approval required — run: ! approve '<command>'` |
| **Default** (`default:`) | configurable | Applied when no pattern matches. `allow` = auto-approve, `block` = hard-block |

### Approval Flow

The `approve` CLI tool (`/usr/local/bin/approve`) enables one-shot command approval:

1. Claude runs `bun add react`
2. Hook matches `approve:^bun\s+(add|install)\b` → exits 2 with instructions
3. User types `! approve 'bun add react'` in Claude Code prompt
4. `approve` script computes SHA256 hash of the literal command string (`bun add react`) and writes it to `/tmp/claude-approved/<hash>`
5. Claude retries `bun add react`
6. Hook computes the same SHA256 hash, finds the matching token in `/tmp/claude-approved/` → deletes the token → exits 0
7. Command executes

Approvals are **one-shot**: each token is consumed on use. Approving `bun add react` does not approve `bun add malicious-package`. All tokens are cleared when the container restarts.

**Self-approval prevention:** The `approve` command itself is in the `block:` tier (`block:^approve\b`), so Claude cannot invoke it via the Bash tool to self-approve commands.

## Container Lifecycle & Fly.io Deployment

### Fly Machine Configuration

- **Size:** `shared-cpu-1x`, 512MB RAM
- **Persistence:** None — workspace is ephemeral, GitHub is source of truth
- **Restart policy:** `no` (manual restarts only)

### Secrets (via `fly secrets set`)

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude Code API access |
| `GH_PAT` | PAT for git HTTPS cloning, gh CLI, GitHub MCP server |

### Environment Variables (via `fly machine run --env`)

| Variable | Purpose |
|----------|---------|
| `GIT_AUTHOR_NAME` | Robot git commit name |
| `GIT_COMMITTER_NAME` | Robot git commit name |
| `GIT_AUTHOR_EMAIL` | Robot git commit email |
| `GIT_COMMITTER_EMAIL` | Robot git commit email |

### Entrypoint Script

`/usr/local/bin/entrypoint.sh` performs the following on container start:

1. Configure git credential helper to use `$GH_PAT` for HTTPS
2. Export `GH_TOKEN=$GH_PAT` for gh CLI authentication
3. Create `/tmp/claude-approved/` directory for approval tokens
4. Install superpowers plugin: `claude plugin install superpowers@claude-plugins-official` (logs warning on failure, continues)
5. Create `/workspace` directory
6. Start tmux session named `claude` with `remain-on-exit on` (pane stays alive if Claude exits)
7. In the tmux session, `cd /workspace` then run `claude --dangerously-skip-permissions`
8. Keep container alive with tmux as the foreground process (`exec tmux attach -t claude`)

### Connecting

```bash
fly ssh console
tmux attach -t claude
```

### When Claude Code Exits

tmux is configured with `remain-on-exit on`, so the pane stays alive showing the exit status. The user can restart Claude by pressing a key in tmux to respawn the pane, or by running `tmux respawn-pane -t claude`. The container does not stop when Claude exits.

## CI/CD Pipeline

### GitHub Actions Workflow

`.github/workflows/deploy.yml` — triggered on push to `main`:

1. Checkout repository
2. Log in to GitHub Container Registry (GHCR)
3. Build and push Docker image to `ghcr.io/<org>/claudetainer:latest`
4. Install flyctl via `superfly/flyctl-actions/setup-flyctl`
5. Deploy to Fly.io using the GHCR image

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `FLY_API_TOKEN` | flyctl authentication for deploy |

Note: GHCR authentication uses the built-in `GITHUB_TOKEN` provided by GitHub Actions — no additional secret needed.

### Fly Configuration

A `fly.toml` in the repo root defines the app name, region, and machine configuration. It references the GHCR image as the build source.

## Project File Structure

```
claudetainer/
├── Dockerfile
├── fly.toml
├── .github/
│   └── workflows/
│       └── deploy.yml
├── entrypoint.sh
├── approval/
│   ├── check-command.sh
│   ├── rules.conf
│   └── approve
└── claude-settings.json
```

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build: Bun, Python, CLI tools, Claude Code, approval system |
| `fly.toml` | Fly app config: app name, region, machine size |
| `deploy.yml` | GitHub Action: build image → push to GHCR → deploy to Fly |
| `entrypoint.sh` | Container startup: git config, plugin install, tmux + claude |
| `check-command.sh` | PreToolUse hook: inspects tool_name, reads rules.conf for Bash, protects paths for Write/Edit |
| `rules.conf` | Configurable allow/approve/block patterns for Bash commands |
| `approve` | CLI tool: writes one-shot approval tokens (SHA256 hash of command string) |
| `claude-settings.json` | Claude Code settings: hook config + MCP servers |
