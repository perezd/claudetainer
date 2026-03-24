# Claudetainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-based interactive Claude Code environment deployed to Fly.io with three security layers: container hardening (read-only FS, non-root, tmpfs), network boundary (iptables + CoreDNS), and command approval hook.

**Architecture:** Entrypoint runs as root to configure security (tmpfs mounts, iptables, CoreDNS, git credentials, read-only remount), then sleeps. On SSH login, `.bashrc` calls `start-claude` which handles auth verification, plugin installation, tmux session creation, and attach. Subsequent SSHs auto-attach to the existing tmux session. Claude Code authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (generated locally via `claude setup-token`, set as a Fly secret).

**Tech Stack:** Docker (debian:bookworm-slim), Bash (entrypoint, start-claude, hook, approval tools), CoreDNS, iptables, jq, tmux, GitHub Actions, Fly.io

**Spec:** `docs/superpowers/specs/2026-03-20-claudetainer-design.md`

---

## File Structure

```
claudetainer/
├── Dockerfile
├── .github/workflows/build.yml
├── entrypoint.sh
├── start-claude
├── approval/
│   ├── check-command.sh
│   ├── rules.conf
│   └── approve
├── network/
│   ├── domains.conf
│   ├── Corefile.template
│   └── refresh-iptables.sh
├── status
└── claude-settings.json
```

---

### Task 1: Network Configuration Files

**Files:**
- Create: `network/domains.conf`
- Create: `network/Corefile.template`
- Create: `network/refresh-iptables.sh`

- [x] **Step 1: Create `network/domains.conf`**

Domain allowlist shared by CoreDNS (DNS filtering) and iptables (IP filtering). Includes Anthropic infrastructure, GitHub, package registries, and Bun domains.

- [x] **Step 2: Create `network/Corefile.template`**

Base CoreDNS config that returns NXDOMAIN for all queries by default. The entrypoint appends per-domain forward blocks from `domains.conf`, each with AAAA→NOERROR (forces IPv4) and caching.

- [x] **Step 3: Create `network/refresh-iptables.sh`**

Resolves all domains in `domains.conf` to IPs, builds iptables rules via `iptables-restore` for atomic application. Key rules:
- OUTPUT policy DROP (default deny)
- Allow loopback, drop metadata (169.254.0.0/16) and private net (172.16.0.0/12)
- Allow DNS to CoreDNS (127.0.0.53) and upstream resolvers (8.8.8.8, 1.1.1.1)
- Allow ESTABLISHED,RELATED
- Allow resolved IPs for each allowlisted domain
- Drop remaining UDP, log via NFLOG
- IPv6: no restrictions (Fly SSH requires public IPv6, conntrack broken on Fly kernel)

- [x] **Step 4: Commit**

---

### Task 2: Approval System

**Files:**
- Create: `approval/rules.conf`
- Create: `approval/check-command.sh`
- Create: `approval/approve`

- [x] **Step 1: Create `approval/rules.conf`**

Copy from spec — allowlist model with allow/block/approve tiers and `default:block`.

- [x] **Step 2: Create `approval/check-command.sh`**

PreToolUse hook that reads JSON from stdin, auto-approves non-Bash tools, splits compound commands (`;`, `&&`, `||`, `$()`, backticks), and evaluates each sub-command against `rules.conf` patterns. Checks for one-shot approval tokens in `/run/claude-approved/`.

- [x] **Step 3: Create `approval/approve`**

Simple script that writes a SHA256 hash token file to `/run/claude-approved/`. User runs via `! approve 'cmd'` in Claude Code's shell escape (bypasses hook). Claude cannot call it via Bash tool (`block:^approve\b`).

- [x] **Step 4: Commit**

---

### Task 3: Claude Code Settings

**Files:**
- Create: `claude-settings.json`

- [x] **Step 1: Create `claude-settings.json`**

Template with: `includeCoAuthoredBy: false`, Bun docs MCP server, PreToolUse hook pointing to `/opt/approval/check-command.sh` with 300s timeout.

- [x] **Step 2: Commit**

---

### Task 4: Status Tool

**Files:**
- Create: `status`

- [x] **Step 1: Create `status`**

Shows active approval tokens, recent iptables drops (via dmesg), and CoreDNS process status.

- [x] **Step 2: Commit**

---

### Task 5: Entrypoint Script

**Files:**
- Create: `entrypoint.sh`

- [x] **Step 1: Create `entrypoint.sh`**

Runs as root (PID 1). Performs these steps in order:

1. **Filesystem hardening:** Mount tmpfs over `/workspace` (512MB), `/tmp` (128MB), `/home/claude` (256MB). Create subdirectories (`.cache`, `.claude`, `.local/bin`, `.bun/bin`). Symlink bun/claude binaries from `/usr/local/bin` back into expected paths (originals wiped by tmpfs).
2. **Network lockdown:** Generate CoreDNS Corefile from template + domains.conf (AAAA→NOERROR per domain). Start CoreDNS. Set resolv.conf to 127.0.0.53. Run `refresh-iptables.sh`. Start 30-minute refresh cron.
3. **Git configuration:** Write PAT to `/root/.git-credentials` (mode 600). Configure system credential helper, user name/email. Configure gh CLI auth to `/opt/gh-config/`. Write `.npmrc` for GitHub Packages.
4. **Approval setup:** Create `/run/claude-approved/`.
5. **Claude Code setup:** Copy `settings.json` template to `/home/claude/.claude/` (root-owned, mode 644).
6. **Lock filesystem:** `mount -o remount,ro /`.
7. **Clone repo (optional):** If `$REPO_URL` is set, clone to `/workspace/repo`.
8. **Keep alive:** `exec sleep infinity`. Claude Code is started by `start-claude` on SSH login, not by the entrypoint.

- [x] **Step 2: Commit**

---

### Task 6: Start-Claude Script

**Files:**
- Create: `start-claude`

- [x] **Step 1: Create `start-claude`**

Called by `.bashrc` on every SSH login. Handles the full session lifecycle:

1. **If tmux session exists:** attach immediately (subsequent SSH flow).
2. **Check `CLAUDE_CODE_OAUTH_TOKEN`:** error with setup instructions if missing.
3. **Install plugins:** Run `claude plugin install superpowers@claude-plugins-official` as claude user.
4. **Write tmux config:** `remain-on-exit on`, `history-limit 50000`, `default-terminal xterm-256color`, `allow-passthrough on`.
5. **Start tmux:** Launch `claude --dangerously-skip-permissions` in a tmux session as the claude user with `GH_CONFIG_DIR`, `HOME`, `PATH`, and `CLAUDE_CODE_OAUTH_TOKEN` exported.
6. **Attach:** `exec tmux attach`.

- [x] **Step 2: Commit**

---

### Task 7: Dockerfile

**Files:**
- Create: `Dockerfile`

- [x] **Step 1: Create Dockerfile**

Single-stage build from `debian:bookworm-slim`:

1. **System deps:** bash, ca-certificates, curl, dnsutils, fd-find, git, iptables, sudo, jq, less, python3, ripgrep, tmux, tree, unzip, wget, xxd
2. **just:** Installed via official script to `/usr/local/bin`
3. **gh CLI:** Installed via GitHub's apt repo
4. **CoreDNS:** Downloaded binary to `/usr/local/bin`
5. **Create claude user** (UID 1000)
6. **Bun:** Installed as claude user, binaries **copied** (not symlinked) to `/usr/local/bin` because `/home/claude` is tmpfs at runtime
7. **Claude Code:** Installed as claude user, binary **copied** to `/usr/local/bin`, `claude install` run for config method
8. **start-claude:** Copied to `/usr/local/bin`, `.bashrc` set to `exec /usr/local/bin/start-claude`
9. **Config files:** approval/, network/, claude-settings.json, status, entrypoint.sh copied to appropriate locations

- [x] **Step 2: Commit**

---

### Task 8: GitHub Actions

**Files:**
- Create: `.github/workflows/build.yml`

- [x] **Step 1: Create build workflow**

Triggered on push to `main`. Checks out, logs into GHCR, builds and pushes `ghcr.io/<repo>:latest`. Uses built-in `GITHUB_TOKEN` for GHCR auth. GHCR package visibility set to public so Fly can pull without registry credentials.

- [x] **Step 2: Commit**

---

### Task 9: First Deploy & Verification

All testing happens on Fly.io directly — the container uses iptables, CoreDNS, tmpfs mounts, and read-only root FS remount which require a full VM environment.

- [ ] **Step 1: Generate OAuth token locally**

```bash
claude setup-token
# Copy the token
```

- [ ] **Step 2: Create the Fly app and set secrets**

```bash
fly apps create <app-name>
fly secrets set GH_PAT=<your-fine-grained-pat> -a <app-name>
fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<your-token> -a <app-name>
```

- [ ] **Step 3: Make GHCR package public**

In the GitHub repo settings, go to Packages, find the `claudetainer` container image, and change its visibility to **Public**.

- [ ] **Step 4: Run the machine**

```bash
fly machine run ghcr.io/<org>/claudetainer:latest \
  --app <app-name> \
  --region sjc \
  --restart no \
  --autostart=false \
  --vm-memory 1024 \
  --vm-size shared-cpu-1x \
  --env GIT_USER_NAME=<robot-name> \
  --env GIT_USER_EMAIL=<robot-email>
```

To auto-clone a repo on start, add `--env REPO_URL=https://github.com/your-org/your-repo`.

- [ ] **Step 5: Connect and verify**

```bash
fly ssh console -a <app-name>
# start-claude runs automatically via .bashrc
# Installs plugins, starts Claude Code in tmux, attaches
```

Verify:
- Claude Code launches and is authenticated
- `! status` — CoreDNS running, approval tokens dir exists
- Ask Claude to `bun add react` — should require approval
- `! approve 'bun add react'` — should approve and succeed
- Verify root FS is read-only: `! touch /test` should fail
- Verify iptables: `! iptables -L -n` shows OUTPUT DROP default with allowlist
- Second SSH session auto-attaches to existing tmux

- [ ] **Step 6: Commit any fixes from testing**

```bash
git add -A && git commit -m "fix: integration test fixes from first deploy"
```
