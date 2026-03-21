# Claudetainer: Interactive Claude Code Development Environment

A Docker container deployed to Fly.io that provides a persistent, interactive Claude Code environment accessible via SSH. The container runs Claude Code with a layered security model: an immutable base image, a non-root user, network-level domain enforcement via iptables, and a command-level approval hook. A secret-holding sidecar ensures API keys are never exposed to Claude's environment.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│ Fly Machine (shared-cpu-1x, 512MB)                           │
│                                                              │
│  entrypoint.sh (runs as root)                                │
│    ├── configure iptables (OUTPUT DROP default)              │
│    ├── configure git identity                                │
│    ├── install superpowers plugin                             │
│    ├── substitute secrets into settings                      │
│    └── drop to claude user → start tmux                      │
│                                                              │
│  ┌─────────────────────────────────┐  ┌───────────────────┐  │
│  │ Claude's Environment            │  │ Auth Sidecar      │  │
│  │ (user: claude, non-root)        │  │ (runs as root)    │  │
│  │                                 │  │                   │  │
│  │  Read-only root filesystem      │  │ Reverse proxy     │  │
│  │  Writable: /workspace           │  │ that injects:     │  │
│  │           /tmp                  │  │  - ANTHROPIC key  │  │
│  │           /home/claude/.cache   │  │  - GitHub PAT     │  │
│  │                                 │  │                   │  │
│  │  tmux session "claude"          │  │ Listens on        │  │
│  │  ├── claude --skip-perms        │  │ 127.0.0.1:4111    │  │
│  │  │   ├── PreToolUse hook        │  │                   │  │
│  │  │   │   └── check-command.sh   │  │ Claude sees:      │  │
│  │  │   │       └── rules.conf     │  │ ANTHROPIC_API_URL │  │
│  │  │   └── MCP servers            │  │ = localhost:4111  │  │
│  │  │       ├── GitHub             │  │                   │  │
│  │  │       └── Bun docs           │  └───────────────────┘  │
│  │  │                              │                         │
│  │  Capabilities: NONE             │  iptables (immutable):  │
│  │  no-new-privileges: true        │  ├── OUTPUT DROP (dflt) │
│  │  seccomp: restricted            │  ├── ACCEPT → sidecar   │
│  │                                 │  ├── ACCEPT → github    │
│  └─────────────────────────────────┘  ├── ACCEPT → DNS       │
│                                       └── ACCEPT → ESTAB     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
        ▲
        │ fly ssh console → tmux attach
        │
    Developer
```

## Security Model: Four Layers

### Layer 1: Container Hardening (tamper-proof enforcement)

The base image is **read-only**. Claude runs as an unprivileged user with all capabilities dropped. This makes every other security layer tamper-proof — Claude cannot modify hook scripts, rules, settings, or network configuration.

**Read-only root filesystem** with scoped writable mounts:

| Mount | Type | Purpose |
|-------|------|---------|
| `/workspace` | tmpfs (1GB) | Project code — clone repos, write code here |
| `/tmp` | tmpfs (512MB) | Temporary files |
| `/home/claude/.cache` | tmpfs (1GB) | Build caches (Bun, pip, etc.) |

Everything else (system binaries, hook scripts, rules.conf, settings.json, the `approve` binary) is immutable at runtime.

**User and capabilities:**

- Claude runs as user `claude` (UID 1000), not root
- `--cap-drop=ALL` — no Linux capabilities
- `--security-opt=no-new-privileges` — cannot escalate via setuid/setgid
- Seccomp profile blocks: `bpf()`, `mount()`, `ptrace()`, `personality()`

**What this eliminates:** Self-modification attacks, privilege escalation, eBPF loading, process tracing/injection, filesystem remounting. The PreToolUse hook and rules.conf are guaranteed immutable because they live on the read-only root filesystem.

### Layer 2: Network Boundary (domain-level enforcement)

All outbound network traffic is blocked by default via iptables. An explicit allowlist permits traffic only to known-good domains. Rules are set by root during the entrypoint, before dropping to the `claude` user who cannot modify them (no `CAP_NET_ADMIN`).

**iptables policy:**

```
# Default: drop all outbound
iptables -P OUTPUT DROP

# Allow loopback (required for sidecar communication)
iptables -A OUTPUT -o lo -j ACCEPT

# Allow DNS to trusted resolver only
iptables -A OUTPUT -p udp -d <trusted-dns> --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp -d <trusted-dns> --dport 53 -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Domain allowlist (resolved to IPs at startup)
# Infrastructure (required for Claude Code to function)
iptables -A OUTPUT -d <api.anthropic.com> -j ACCEPT
iptables -A OUTPUT -d <statsig.anthropic.com> -j ACCEPT
iptables -A OUTPUT -d <console.anthropic.com> -j ACCEPT

# GitHub (cloning, PRs, MCP server)
iptables -A OUTPUT -d <github.com> -j ACCEPT
iptables -A OUTPUT -d <api.github.com> -j ACCEPT
iptables -A OUTPUT -d <api.githubcopilot.com> -j ACCEPT
iptables -A OUTPUT -d <objects.githubusercontent.com> -j ACCEPT

# Package registries (enabled by default — individual packages
# are gated at the command level by the PreToolUse hook)
iptables -A OUTPUT -d <registry.npmjs.org> -j ACCEPT
iptables -A OUTPUT -d <pypi.org> -j ACCEPT
iptables -A OUTPUT -d <files.pythonhosted.org> -j ACCEPT
iptables -A OUTPUT -d <deb.debian.org> -j ACCEPT

# Bun
iptables -A OUTPUT -d <bun.sh> -j ACCEPT
iptables -A OUTPUT -d <registry.npmjs.org> -j ACCEPT

# Block all UDP except DNS (prevents QUIC bypass, UDP tunneling)
iptables -A OUTPUT -p udp -j DROP
```

**Domain allowlist configuration:** The allowlist lives in `/opt/network/domains.conf` (one domain per line) on the read-only filesystem. The entrypoint resolves each domain to IPs and creates iptables rules. To add a new domain, update `domains.conf` in the repo and redeploy.

**DNS control:** All DNS queries go to a single trusted resolver. Queries for non-allowlisted domains still resolve (needed for the hook to show meaningful error messages), but the iptables rules prevent actual connections to non-allowlisted IPs.

**What this eliminates:** Unauthorized outbound connections, DNS exfiltration via direct UDP, QUIC/HTTP3 bypass, connections to unknown domains regardless of how they're initiated (curl, wget, Python requests, Node fetch, raw sockets — all caught at the IP level).

**Fail-closed:** If the entrypoint fails to configure iptables, the default policy is DROP — no traffic flows.

### Layer 3: Command Approval Hook (intent-level gate)

Claude Code runs with `--dangerously-skip-permissions`. A PreToolUse hook provides command-level approval for package installation and other gated operations.

**Hook architecture:**

The hook script (`/opt/approval/check-command.sh`) receives JSON on stdin from Claude Code:

```json
{"tool_name": "Bash", "tool_input": {"command": "bun add react"}}
```

The hook uses `jq` to extract `tool_name` and routes accordingly:

1. **If `tool_name` is `Bash`:** extract `.tool_input.command`, evaluate against `rules.conf` patterns
2. **All other tools** (`Read`, `Write`, `Edit`, `Glob`, `Grep`, etc.): auto-approve (exit 0)

Note: Write/Edit protection is no longer needed in the hook because the root filesystem is read-only. Claude cannot modify protected files regardless of what the hook allows.

**Rules configuration** (`/opt/approval/rules.conf`):

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

**Three tiers:**

Both `block:` and `approve:` use exit code 2 (blocked). The difference is the stderr message.

| Tier | Exit Code | Behavior |
|------|-----------|----------|
| **Auto-approve** (`allow:`) | 0 | Command runs immediately |
| **Hard-block** (`block:`) | 2 | Rejected, cannot be overridden |
| **Approval-required** (`approve:`) | 2 | Blocked with: `⛔ Approval required — run: ! approve '<command>'` |
| **Default** (`default:`) | configurable | `allow` = auto-approve, `block` = hard-block |

**Approval flow:**

The `approve` CLI tool (`/usr/local/bin/approve`) enables one-shot command approval:

1. Claude runs `bun add react`
2. Hook matches `approve:^bun\s+(add|install)\b` → exits 2 with instructions
3. User types `! approve 'bun add react'` in Claude Code prompt
4. `approve` script computes SHA256 hash of the literal command string and writes it to `/tmp/claude-approved/<hash>`
5. Claude retries `bun add react`
6. Hook finds the matching token → deletes it → exits 0
7. Command executes (network request succeeds because `registry.npmjs.org` is in the iptables allowlist)

Approvals are **one-shot**: each token is consumed on use. Approving `bun add react` does not approve `bun add malicious-package`. Tokens are cleared on container restart.

**Self-approval prevention:** `block:^approve\b` prevents Claude from running the `approve` command via the Bash tool.

**Why this works with Layer 2:** The iptables allowlist permits traffic to package registries, but the hook gates which install commands actually run. Claude can't bypass the hook to run `bun add evil-package` because the hook fires on every Bash tool invocation even in `--dangerously-skip-permissions` mode. The two layers complement: iptables blocks unknown domains, the hook blocks unapproved commands to known domains.

### Layer 4: Secret-Holding Sidecar (credential isolation)

Claude never sees API keys directly. A lightweight reverse proxy sidecar holds secrets and injects them into outbound API requests.

**Sidecar architecture:**

The sidecar runs as root (separate from Claude's process), listens on `127.0.0.1:4111`, and proxies requests to the Anthropic API with the real API key injected into headers.

Claude's environment sees:
- `ANTHROPIC_API_BASE_URL=http://127.0.0.1:4111` — points to the sidecar, not the real API
- No `ANTHROPIC_API_KEY` in the environment
- `GH_PAT` is not in Claude's environment — the git credential helper is configured by root in the entrypoint (credential stored in `/root/.git-credentials`, unreadable by the `claude` user)

**Git credential isolation:**

The entrypoint (running as root) configures git's credential helper to use the PAT stored in a root-owned file:

```
git config --system credential.helper 'store --file=/root/.git-credentials'
```

The `claude` user can run `git clone/push/pull` and git transparently authenticates, but Claude cannot read the credential file or extract the PAT.

**MCP server authentication:**

The GitHub MCP server header (`Authorization: Bearer <token>`) is populated by the entrypoint via `sed`/`envsubst` into settings.json, which lives on the read-only filesystem. Claude can read settings.json to see the token value — this is a known limitation. The sidecar protects the Anthropic key (higher value); the GitHub PAT is lower risk since its permissions are scoped to the robot account.

**What this eliminates:** API key exfiltration. Even if Claude is fully compromised, the Anthropic API key cannot be extracted — it exists only in the sidecar's process memory and the Fly secret store.

## Container Image

### Base Image

`debian:bookworm-slim` — minimal footprint.

### Installed Tooling

- **Bun** — project runtime, installed via official install script
- **Python 3** — Claude Code frequently uses it for scripting tasks
- **Claude Code** — installed via `curl -fsSL https://claude.ai/install.sh | bash` (self-contained binary)
- **gh** — GitHub CLI
- **CLI tools:** jq, ripgrep, fd-find, git, curl, wget, tmux, less, tree
- **iptables** — for network boundary enforcement

### Claude Code Configuration

`claude-settings.json` baked into the image at `/home/claude/.claude/settings.json`:

- **PreToolUse hook** pointing to `/opt/approval/check-command.sh`
- **MCP servers:**
  - GitHub: `https://api.githubcopilot.com/mcp/` with `Authorization: Bearer <GH_PAT>` (substituted at boot)
  - Bun docs: `https://bun.com/docs/mcp`

### Superpowers Plugin

Installed at first boot by the entrypoint script via `claude plugin install superpowers@claude-plugins-official`. If the install fails, the entrypoint logs a warning and continues.

## Container Lifecycle & Fly.io Deployment

### Fly Machine Configuration

- **Size:** `shared-cpu-1x`, 512MB RAM
- **Persistence:** None — workspace is ephemeral, GitHub is source of truth
- **Restart policy:** `no` (manual restarts only)

### Secrets (via `fly secrets set`)

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Held by sidecar only, never exposed to Claude |
| `GH_PAT` | Git HTTPS auth, gh CLI, GitHub MCP server |

### Environment Variables (via `fly machine run --env`)

| Variable | Purpose |
|----------|---------|
| `GIT_AUTHOR_NAME` | Robot git commit name |
| `GIT_COMMITTER_NAME` | Robot git commit name |
| `GIT_AUTHOR_EMAIL` | Robot git commit email |
| `GIT_COMMITTER_EMAIL` | Robot git commit email |

### Entrypoint Script

`/usr/local/bin/entrypoint.sh` runs as root and performs:

1. **Network lockdown:**
   - Read `/opt/network/domains.conf`, resolve each domain to IPs
   - Apply iptables rules: `OUTPUT DROP` default, explicit ACCEPT for resolved IPs
   - Block all UDP except DNS to trusted resolver
2. **Git configuration:**
   - Write `$GH_PAT` to `/root/.git-credentials` (root-owned, mode 600)
   - Configure git system-wide credential helper pointing to that file
   - Set git identity from `$GIT_AUTHOR_NAME` / `$GIT_AUTHOR_EMAIL` env vars
3. **Sidecar startup:**
   - Start the auth sidecar proxy on `127.0.0.1:4111`
   - Sidecar reads `$ANTHROPIC_API_KEY` from environment, proxies to `api.anthropic.com`
4. **Claude Code setup:**
   - Substitute `<GH_PAT>` in settings.json via `sed`
   - Export `GH_TOKEN=$GH_PAT` for gh CLI
   - Install superpowers plugin (log warning on failure)
5. **Session startup:**
   - Create `/tmp/claude-approved/` (writable by `claude` user — needed for approval tokens)
   - Start tmux session as `claude` user with `remain-on-exit on`
   - In tmux: `cd /workspace && claude --dangerously-skip-permissions`
   - `exec tmux attach -t claude` (keeps container alive)

### Connecting

```bash
fly ssh console
tmux attach -t claude
```

### When Claude Code Exits

tmux is configured with `remain-on-exit on`. The pane stays alive showing exit status. Restart with `tmux respawn-pane -t claude` or a bound key. The container does not stop.

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

Note: GHCR authentication uses the built-in `GITHUB_TOKEN` provided by GitHub Actions.

### Fly Configuration

`fly.toml` in the repo root defines the app name, region, and machine configuration.

## Project File Structure

```
claudetainer/
├── Dockerfile
├── fly.toml
├── .github/
│   └── workflows/
│       └── deploy.yml
├── entrypoint.sh
├── sidecar/
│   └── auth-proxy            # Lightweight reverse proxy for API key injection
├── approval/
│   ├── check-command.sh       # PreToolUse hook script
│   ├── rules.conf             # Configurable allow/approve/block patterns
│   └── approve                # CLI tool for one-shot command approval
├── network/
│   └── domains.conf           # Domain allowlist (one per line)
├── seccomp-profile.json       # Seccomp policy (blocks bpf, mount, ptrace, etc.)
└── claude-settings.json       # Claude Code settings: hook config + MCP servers
```

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build: Bun, Python, CLI tools, Claude Code, non-root user, read-only FS |
| `fly.toml` | Fly app config: app name, region, machine size |
| `deploy.yml` | GitHub Action: build → push to GHCR → deploy to Fly |
| `entrypoint.sh` | Container startup: iptables, git config, sidecar, plugin install, tmux |
| `auth-proxy` | Sidecar: injects ANTHROPIC_API_KEY into proxied requests |
| `check-command.sh` | PreToolUse hook: reads rules.conf, enforces command tiers |
| `rules.conf` | Configurable allow/approve/block regex patterns for Bash commands |
| `approve` | CLI tool: writes one-shot approval tokens (SHA256 hash) |
| `domains.conf` | Network allowlist: domains whose IPs are permitted through iptables |
| `seccomp-profile.json` | Kernel syscall restrictions (blocks bpf, mount, ptrace, etc.) |
| `claude-settings.json` | Claude Code settings: hook config + MCP servers |

## Security Properties Summary

| Threat | Mitigation |
|--------|------------|
| Claude modifies hook/rules/settings | Read-only root filesystem — structurally impossible |
| Claude escalates to root | Non-root user + `no-new-privileges` + capability drop |
| Claude loads eBPF/kernel modules | Seccomp blocks `bpf()`, `mount()` |
| Claude connects to unknown domains | iptables `OUTPUT DROP` default, explicit allowlist |
| Claude exfiltrates via DNS | DNS restricted to trusted resolver, UDP blocked except DNS |
| Claude exfiltrates API keys | Sidecar holds keys, never in Claude's environment |
| Claude runs `sudo`, `rm -rf /` | Hook hard-blocks destructive commands |
| Claude installs malicious package | Hook requires per-command approval for all install commands |
| Claude self-approves commands | `approve` command is in the hook's hard-block tier |
| Claude bypasses via QUIC/UDP | All UDP dropped except DNS |
| Proxy/hook process killed | Claude lacks capabilities to signal root-owned processes |
| iptables modified | Claude lacks `CAP_NET_ADMIN` |
