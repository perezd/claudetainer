# Session Initialization: Fork Sync Before Every Task

## Problem

When working with a forked repository, the local main branch can fall behind upstream. This means any work -- whether writing code, answering questions, or reviewing files -- may be based on stale source. The current CLAUDE.md has a "Syncing a Fork After Merge" section that handles post-merge cleanup, but nothing ensures the repo is current _before_ a task begins.

## Design

Add a new "Session Initialization" subsection as the **first subsection** under "## Git Workflow" in CLAUDE.md, before "Worktree-First Development". This positions it as a precondition for all subsequent workflow steps.

### Exact Markdown to Insert

The following block is inserted immediately after the `## Git Workflow` heading and before `### Worktree-First Development`:

````markdown
### Session Initialization

Before beginning any task, complete these initialization steps in order:

1. **Sync with upstream** — Run `gh repo view --json isFork,parent` to check if the repo is a fork. If it is a fork, sync main with upstream: `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main`, then `git pull origin main`. If the repo is not a fork, run `git pull origin main` to ensure the local checkout is current with its remote. If the sync or pull fails, warn the user and proceed — do not block the task.

All work — whether writing code, answering questions, or reviewing files — must be based on the latest upstream state. This step runs from the main branch before any worktree is created.
````

### Placement

```
## Git Workflow
### Session Initialization       <-- NEW (first subsection)
### Worktree-First Development   <-- existing
### PR-Based Integration         <-- existing
### Fork-Aware PRs               <-- existing
### Syncing a Fork After Merge   <-- existing (unchanged)
...
```

### Scope

This applies to **every task**, not just tasks that produce commits. Explanations, code reviews, and exploratory reads should also be against the latest upstream state. The step runs once at the start of a conversation. For multi-task sessions where a PR is merged mid-conversation, the existing "Syncing a Fork After Merge" section handles re-syncing before the next task.

### Key Design Decisions

- **Non-fork repos also pull.** A non-fork repo can fall behind its own remote just as easily. The step runs `git pull origin main` unconditionally; the fork-detection only controls whether `gh repo sync` runs first.
- **Runs from main, before worktrees.** The sync step is a precondition that runs while on the main branch, before the "Worktree-First Development" step creates a feature branch. This avoids pulling main into a feature branch by mistake.
- **Failure is non-blocking.** If `gh repo sync` or `git pull` fails (network issues, auth problems), the agent warns the user and proceeds. Blocking all work on a transient sync failure would be worse than working on slightly stale code.
- **Uses the established command pattern.** The full `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main` form matches the existing "Syncing a Fork After Merge" section for consistency.
- **Credential handling.** `gh repo sync` uses the already-configured `gh` authentication (via `GH_PAT` in the container). No new credential paths are introduced.

### Relationship to Existing Sections

- **"Syncing a Fork After Merge"** remains unchanged. It handles a different lifecycle moment: re-syncing within a long-running session after a PR merges mid-conversation. Both sections are needed because session-start sync does not cover mid-session merges.
- **"Fork-Aware PRs"** remains unchanged. It handles PR targeting at creation time.

### Future Extensibility

The "Session Initialization" section uses an ordered list, allowing additional pre-task steps to be appended later without restructuring.

## Security Layer Impact

- **Affected layers:** None.
- **Why:** This change modifies CLAUDE.md instructions only. No security-layer files (Dockerfile, iptables, approval rules, etc.) are touched. The `gh repo sync` and `git pull` commands are standard git operations using already-configured authentication. No new credential paths are introduced.
- **Panel review triggered:** Yes -- new designs and specifications require panel review per the Modification Protocol.
