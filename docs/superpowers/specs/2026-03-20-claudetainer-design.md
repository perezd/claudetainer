# Claudetainer: Interactive Claude Code Development Environment

A Docker container deployed to Fly.io that provides a persistent, interactive Claude Code environment accessible via SSH. The container runs Claude Code with a custom permission system and a GitHub robot identity for committing code.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│ Fly Machine (shared-cpu-1x, 256MB)              │
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
│  │  │                                      │  │  │
│  │  │  claude --dangerously-skip-perms     │  │  │
│  │  │    │                                 │  │  │
│  │  │    ├── PreToolUse hook               │  │  │
│  │  │    │   └── check-command.sh          │  │  │
│  │  │    │       └── reads rules.conf      │  │  │
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

- **PreToolUse hook** pointing to `/opt/approval/check-command.sh`
- **MCP servers:**
  - GitHub: `https://api.githubcopilot.com/mcp/` with `Authorization: Bearer ${GITHUB_TOKEN}`
  - Bun docs: `https://bun.com/docs/mcp`

### Superpowers Plugin

Installed at first boot by the entrypoint script via `claude plugin install superpowers@claude-plugins-official`. This ensures the plugin is always the latest version rather than a stale baked-in copy.

## Permission System

### Mode

Claude Code runs with `--dangerously-skip-permissions`. A single PreToolUse hook provides all permission enforcement.

### Hook Architecture

The hook script (`/opt/approval/check-command.sh`) reads a configuration file (`/opt/approval/rules.conf`) and categorizes each command into one of three tiers. Rules are evaluated top-to-bottom, first match wins.

### Rules Configuration

`/opt/approval/rules.conf` — line-based format with regex patterns:

```
# Auto-approve patterns (exit 0)
allow:^git\b
allow:^(ls|cat|head|tail|cp|mv|mkdir|touch|tree|less)\b
allow:^(grep|rg|fd|find|ag)\b
allow:^bun (run|test|build|check)\b
allow:^(python3?|echo|pwd|cd|env|which)\b
allow:^(wc|sort|uniq|diff|sed|awk|xargs|tee|basename|dirname)\b
allow:^gh\b

# Hard-block patterns (exit 2, cannot be approved)
block:.*\|\s*(ba)?sh
block:^sudo\b
block:^rm\s+-rf\s+/
block:^chmod\s+777\b
block:.*/opt/approval/

# Approval-required patterns (exit 2 with approval instructions)
approve:^(apt-get|apt)\s+install\b
approve:^bun\s+(add|install)\b
approve:^(pip3?|pipx)\s+install\b
approve:^curl\b
approve:^wget\b

# Default behavior for unmatched commands
default:allow
```

### Three Tiers

| Tier | Exit Code | Behavior |
|------|-----------|----------|
| **Auto-approve** (`allow:`) | 0 | Command runs immediately |
| **Hard-block** (`block:`) | 2 | Command is rejected, cannot be overridden |
| **Approval-required** (`approve:`) | 2 | Command is blocked with message: `⛔ Approval required — run: ! approve '<command>'` |

### Approval Flow

The `approve` CLI tool (`/usr/local/bin/approve`) enables one-shot command approval:

1. Claude runs `bun add react`
2. Hook matches `approve:^bun\s+(add|install)\b` → exits 2 with instructions
3. User types `! approve 'bun add react'` in Claude Code prompt
4. `approve` script writes SHA256 hash of the command to `/tmp/claude-approved/<hash>`
5. Claude retries `bun add react`
6. Hook finds the token in `/tmp/claude-approved/` → deletes the token → exits 0
7. Command executes

Approvals are **one-shot**: each token is consumed on use. Approving `bun add react` does not approve `bun add malicious-package`. All tokens are cleared when the container restarts.

## Container Lifecycle & Fly.io Deployment

### Fly Machine Configuration

- **Size:** `shared-cpu-1x`, 256MB RAM
- **Persistence:** None — workspace is ephemeral, GitHub is source of truth
- **Restart policy:** `no` (manual restarts only)

### Secrets (via `fly secrets set`)

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude Code API access |
| `GITHUB_TOKEN` | PAT for git HTTPS cloning, gh CLI, GitHub MCP server |

### Environment Variables (via `fly machine run --env`)

| Variable | Purpose |
|----------|---------|
| `GIT_AUTHOR_NAME` | Robot git commit name |
| `GIT_COMMITTER_NAME` | Robot git commit name |
| `GIT_AUTHOR_EMAIL` | Robot git commit email |
| `GIT_COMMITTER_EMAIL` | Robot git commit email |

### Entrypoint Script

`/usr/local/bin/entrypoint.sh` performs the following on container start:

1. Configure git credential helper to use `$GITHUB_TOKEN` for HTTPS
2. Export `GH_TOKEN=$GITHUB_TOKEN` for gh CLI authentication
3. Create `/tmp/claude-approved/` directory for approval tokens
4. Install superpowers plugin: `claude plugin install superpowers@claude-plugins-official`
5. Start tmux session named `claude` running `claude --dangerously-skip-permissions`
6. Keep container alive with tmux as the foreground process

### Connecting

```bash
fly ssh console
tmux attach -t claude
```

## CI/CD Pipeline

### GitHub Actions Workflow

`.github/workflows/deploy.yml` — triggered on push to `main`:

1. Checkout repository
2. Install flyctl via `superfly/flyctl-actions/setup-flyctl`
3. Run `fly deploy` to build the Dockerfile and push to Fly's registry

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `FLY_API_TOKEN` | flyctl authentication for deploy |

### Fly Configuration

A `fly.toml` in the repo root defines the app name, region, and machine configuration. `fly deploy` uses this to build and deploy.

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
| `deploy.yml` | GitHub Action: build + deploy on push to main |
| `entrypoint.sh` | Container startup: git config, plugin install, tmux + claude |
| `check-command.sh` | PreToolUse hook: reads rules.conf, enforces permission tiers |
| `rules.conf` | Configurable allow/approve/block patterns |
| `approve` | CLI tool: writes one-shot approval tokens |
| `claude-settings.json` | Claude Code settings: hook config + MCP servers |
