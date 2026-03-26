# Git Push Ownership Exemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow git push commands to remotes owned by the `GIT_USER_NAME` user, and fix a pre-existing compound command bypass in the git push block rules.

**Architecture:** A new `isOwnedRemotePush()` function in `check-command.ts` runs before `evaluateTiers()` to detect and allow pushes to owned GitHub remotes. Separately, `rules.conf` git push block patterns are updated from `^`-anchored to compound-command-aware anchoring. Both changes are independent and tested separately.

**Tech Stack:** TypeScript, Bun (runtime + test runner), regex-based rule engine

**Spec:** `docs/superpowers/specs/2026-03-26-git-push-ownership-exemption-design.md`

---

### Task 1: Fix compound command bypass in rules.conf

**Files:**
- Modify: `approval/rules.conf:46-55`
- Modify: `approval/__tests__/tiers.test.ts`

This task fixes the pre-existing gap where `^`-anchored git push block patterns can be bypassed by prefixing with `cd /repo &&` or similar compound command constructs. The fix uses the same `(^\s*|[;&|({$]\s*)` pattern already established for `fly auth`/`fly ssh` rules in the same file (lines 58-65). The spec described the pattern as `(^|\s*[;&|]\s*|[(]\s*)` but the plan deliberately uses the existing `fly` convention for consistency within `rules.conf`.

- [ ] **Step 1: Add compound command block tests first (TDD)**

In `approval/__tests__/tiers.test.ts`, add these entries to the `blocked` array inside the `"Tier 1: hard-block"` describe block, after the existing `"git tag v1.0.0"` entry:

```typescript
    // Git push in compound commands (compound-command-aware anchoring)
    "cd /repo && git push --force origin main",
    "(git push origin main)",
    "ls; git push --delete origin branch",
```

Also add this entry to the `notBlocked` array:

```typescript
    "cd /repo && git push origin feature",  // non-destructive push in compound command
```

- [ ] **Step 2: Run tests to verify compound command tests fail**

Run: `cd /Users/derek/src/claudetainer/approval && bun test __tests__/tiers.test.ts`
Expected: FAIL — the three new compound command entries in `blocked` fail because current `^`-anchored rules don't match them.

- [ ] **Step 3: Update git push block patterns in rules.conf**

Change lines 46-55 in `approval/rules.conf` from:

```conf
# Git safety: prevent destructive push and remote manipulation
block-pattern:^git\s+push\s+.*--force
block-pattern:^git\s+push\s+.*-[a-zA-Z]*f
block-pattern:^git\s+push\s+.*--delete
block-pattern:^git\s+push\s+.*-[a-zA-Z]*d
block-pattern:^git\s+push\s+.*\b(main|master)\b
block-pattern:^git\s+remote\s+(add|set-url|rename|remove)\b
block-pattern:^git\s+config\s+.*remote\.
block-pattern:^git\s+tag\b
block-pattern:^git\s+push\s+.*--tags
```

To:

```conf
# Git safety: prevent destructive push and remote manipulation
# Push rules use compound-command-aware anchoring (same as fly rules)
# to prevent bypass via "cd /repo && git push --force origin main"
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*--force
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*-[a-zA-Z]*f
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*--delete
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*-[a-zA-Z]*d
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*\b(main|master)\b
block-pattern:^git\s+remote\s+(add|set-url|rename|remove)\b
block-pattern:^git\s+config\s+.*remote\.
block-pattern:^git\s+tag\b
block-pattern:(^\s*|[;&|({$]\s*)git\s+push\s+.*--tags
```

Note: `git remote`, `git config remote`, and `git tag` rules retain `^` anchoring per the spec's scope exclusions.

- [ ] **Step 4: Run tests to verify they all pass**

Run: `cd /Users/derek/src/claudetainer/approval && bun test`
Expected: All existing tests still pass. New compound command tests pass.

- [ ] **Step 5: Commit**

```bash
git add approval/rules.conf approval/__tests__/tiers.test.ts
git commit -m "fix: compound-command-aware anchoring for git push block rules"
```

---

### Task 2: Add ownership check helpers and integration tests

**Files:**
- Modify: `approval/check-command.ts`
- Create: `approval/__tests__/ownership.test.ts`

This task adds the pure helper functions (`parseRemoteFromPushCommand`, `extractGitHubOwner`) and the async `isOwnedRemotePush()` function, along with all their tests. The helpers are exported for unit testing. The async function shells out to `git remote get-url --push`.

- [ ] **Step 1: Write all tests (unit + integration)**

Create `approval/__tests__/ownership.test.ts`:

```typescript
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  parseRemoteFromPushCommand,
  extractGitHubOwner,
  isOwnedRemotePush,
} from "../check-command";

describe("parseRemoteFromPushCommand", () => {
  test("extracts remote from 'git push origin main'", () => {
    expect(parseRemoteFromPushCommand("git push origin main")).toBe("origin");
  });

  test("extracts remote from 'git push my-fork feature'", () => {
    expect(parseRemoteFromPushCommand("git push my-fork feature")).toBe("my-fork");
  });

  test("skips flags: 'git push --force origin main'", () => {
    expect(parseRemoteFromPushCommand("git push --force origin main")).toBe("origin");
  });

  test("skips flags: 'git push -u origin feature'", () => {
    expect(parseRemoteFromPushCommand("git push -u origin feature")).toBe("origin");
  });

  test("skips compound flags: 'git push --set-upstream origin main'", () => {
    expect(parseRemoteFromPushCommand("git push --set-upstream origin main")).toBe("origin");
  });

  test("defaults to 'origin' for bare 'git push'", () => {
    expect(parseRemoteFromPushCommand("git push")).toBe("origin");
  });

  test("defaults to 'origin' for 'git push --force'", () => {
    expect(parseRemoteFromPushCommand("git push --force")).toBe("origin");
  });

  test("returns null for non-git-push command", () => {
    expect(parseRemoteFromPushCommand("git status")).toBeNull();
  });

  test("returns null for 'echo git push'", () => {
    expect(parseRemoteFromPushCommand("echo git push")).toBeNull();
  });
});

describe("extractGitHubOwner", () => {
  test("extracts owner from HTTPS URL", () => {
    expect(extractGitHubOwner("https://github.com/alice/repo.git")).toBe("alice");
  });

  test("extracts owner from HTTPS URL without .git", () => {
    expect(extractGitHubOwner("https://github.com/alice/repo")).toBe("alice");
  });

  test("extracts owner from SSH URL", () => {
    expect(extractGitHubOwner("git@github.com:alice/repo.git")).toBe("alice");
  });

  test("extracts owner from SSH URL without .git", () => {
    expect(extractGitHubOwner("git@github.com:alice/repo")).toBe("alice");
  });

  test("returns null for GitLab URL", () => {
    expect(extractGitHubOwner("https://gitlab.com/alice/repo.git")).toBeNull();
  });

  test("returns null for non-URL string", () => {
    expect(extractGitHubOwner("not-a-url")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractGitHubOwner("")).toBeNull();
  });
});

describe("isOwnedRemotePush", () => {
  let originalEnv: string | undefined;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalEnv = process.env.GIT_USER_NAME;
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GIT_USER_NAME;
    } else {
      process.env.GIT_USER_NAME = originalEnv;
    }
    Bun.spawn = originalSpawn;
  });

  function mockGitRemote(url: string, exitCode = 0) {
    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = () => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(url + "\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); },
      }),
      exited: Promise.resolve(exitCode),
    });
  }

  test("allows push to owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
  });

  test("denies push to non-owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/upstream-org/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("allows push to owned non-origin remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push my-fork feature")).toBe(true);
  });

  test("case-insensitive username match", async () => {
    process.env.GIT_USER_NAME = "Alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
  });

  test("allows force push to owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push --force origin main")).toBe(true);
  });

  test("blocks --delete even on owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push --delete origin feature")).toBe(false);
  });

  test("blocks -d even on owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push -d origin feature")).toBe(false);
  });

  test("returns false when GIT_USER_NAME is unset", async () => {
    delete process.env.GIT_USER_NAME;
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false when git command fails", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("", 128);
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false for non-GitHub remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://gitlab.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("allows bare 'git push' with owned origin", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push")).toBe(true);
  });

  test("returns false for non-push commands", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git status")).toBe(false);
  });

  test("handles SSH remote URL", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("git@github.com:alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
  });

  test("skips -u flag and finds remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push -u origin feature")).toBe(true);
  });

  // SECURITY: pushurl vs url divergence — ownership check must use pushurl
  // because that is the URL git actually pushes to.
  test("uses push URL for ownership check (pushurl security invariant)", async () => {
    process.env.GIT_USER_NAME = "alice";
    // Simulate a repo where pushurl differs from url.
    // The mock returns what --push would return (the pushurl).
    // If pushurl points to a non-owned remote, the check must fail.
    mockGitRemote("https://github.com/victim-org/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/derek/src/claudetainer/approval && bun test __tests__/ownership.test.ts`
Expected: FAIL — `parseRemoteFromPushCommand`, `extractGitHubOwner`, and `isOwnedRemotePush` are not exported from `check-command.ts`.

- [ ] **Step 3: Implement helper functions and `isOwnedRemotePush`**

Add the following to `approval/check-command.ts`, after the existing `evaluateTiers` function (after line 28) and before the `// --- Main entry point ---` comment (before line 30):

```typescript
// --- Ownership exemption helpers (exported for testing) ---

const GIT_PUSH_RE = /^git\s+push\b/;

/**
 * Parse the target remote name from a git push command string.
 * Skips flags (tokens starting with -). Returns the first positional
 * argument after "git push", or "origin" if none found.
 * Returns null if the command is not a git push.
 */
export function parseRemoteFromPushCommand(command: string): string | null {
  if (!GIT_PUSH_RE.test(command)) return null;

  // Tokenize everything after "git push"
  const afterPush = command.replace(GIT_PUSH_RE, "").trim();
  if (!afterPush) return "origin";

  const tokens = afterPush.split(/\s+/);
  const firstPositional = tokens.find((t) => !t.startsWith("-"));
  return firstPositional ?? "origin";
}

/**
 * Extract the GitHub owner from a remote URL.
 * Supports:
 *   https://github.com/<owner>/<repo>
 *   git@github.com:<owner>/<repo>
 * Returns null for non-GitHub URLs.
 */
export function extractGitHubOwner(url: string): string | null {
  // HTTPS format
  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1];

  // SSH format
  const sshMatch = url.match(/^git@github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1];

  return null;
}

const HAS_DELETE_FLAG = /\s--delete\b|\s-[a-zA-Z]*d/;

/**
 * Check if a git push command targets a remote owned by GIT_USER_NAME.
 * Returns true if the push should be exempted from block rules.
 *
 * Fail-safe: returns false on any error (missing env var, git failure,
 * unparseable URL, non-GitHub host, --delete flag present).
 */
export async function isOwnedRemotePush(command: string): Promise<boolean> {
  const remote = parseRemoteFromPushCommand(command);
  if (remote === null) return false;

  // --delete pushes are never exempted, even to owned remotes
  if (HAS_DELETE_FLAG.test(command)) return false;

  const gitUserName = process.env.GIT_USER_NAME;
  if (!gitUserName) return false;

  try {
    // SECURITY: --push returns the URL git actually uses for push operations.
    // If pushurl is configured, --push returns pushurl (not url).
    // This ensures we check ownership against the same URL git will push to,
    // preventing attacks where url and pushurl are set to different owners.
    const proc = Bun.spawn(["git", "remote", "get-url", "--push", remote], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) return false;

    const owner = extractGitHubOwner(stdout.trim());
    if (!owner) return false;

    return owner.toLowerCase() === gitUserName.toLowerCase();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/derek/src/claudetainer/approval && bun test __tests__/ownership.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add approval/check-command.ts approval/__tests__/ownership.test.ts
git commit -m "feat: add git push ownership check with tests"
```

---

### Task 3: Wire ownership exemption into main entry point

**Files:**
- Modify: `approval/check-command.ts` (main entry point block)

This task adds the early-exit call to `isOwnedRemotePush()` in the main entry point, before `evaluateTiers()`.

- [ ] **Step 1: Add ownership check to main entry point**

In the main entry point block of `approval/check-command.ts`, add the ownership check after the `console.error(`[HOOK] Evaluating: ${command}`)` log line and before the `const rules = parseRules(...)` line:

```typescript
      // Pre-tier: check if this is a git push to an owned remote
      if (await isOwnedRemotePush(command)) {
        console.error(`[HOOK] ALLOW (owned remote): ${command}`);
        outputDecision("allow");
        process.exit(0);
      }
```

The resulting main entry point should read:

```typescript
      console.error(`[HOOK] Evaluating: ${command}`);

      // Pre-tier: check if this is a git push to an owned remote
      if (await isOwnedRemotePush(command)) {
        console.error(`[HOOK] ALLOW (owned remote): ${command}`);
        outputDecision("allow");
        process.exit(0);
      }

      const rules = parseRules(readFileSync(RULES_FILE, "utf-8"));
      const tierResult = evaluateTiers(command, rules);
```

- [ ] **Step 2: Run all tests to verify nothing is broken**

Run: `cd /Users/derek/src/claudetainer/approval && bun test`
Expected: All tests pass (tiers + ownership).

- [ ] **Step 3: Commit**

```bash
git add approval/check-command.ts
git commit -m "feat: wire ownership exemption into approval main entry point"
```

---

### Task 4: Final verification and rebuild

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/derek/src/claudetainer/approval && bun test`
Expected: All tests pass with 0 failures.

- [ ] **Step 2: Verify the compiled binary still builds**

Run: `cd /Users/derek/src/claudetainer/approval && bun build --compile --bytecode --outfile check-command check-command.ts`
Expected: Binary compiles without errors.

- [ ] **Step 3: Clean up build artifact**

Run: `rm /Users/derek/src/claudetainer/approval/check-command`
(The Dockerfile builds this at image build time; no need to commit the binary.)

- [ ] **Step 4: Commit any remaining changes (if any)**

Check `git status`. If clean, no commit needed.
