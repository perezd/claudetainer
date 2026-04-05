import type { ParsedSegment } from "./tokenize";
import { extractGitHubOwner } from "./github-utils";

const VALUE_CONSUMING_FLAGS = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

/**
 * Layer 6c: Check if a git push targets a remote owned by the configured user.
 * Only fires for non-destructive pushes that have already passed deny rules.
 * Returns true if the push should be auto-approved (owned remote).
 */
export async function checkOwnedRemotePush(
  segment: ParsedSegment,
): Promise<boolean> {
  const { program, positionals, flags } = segment;

  // Only applies to git push
  if (program !== "git" || positionals[0] !== "push") return false;

  // Belt-and-suspenders: bail on destructive flags (already caught by deny rules)
  if (flags.has("--delete") || flags.has("-d")) return false;

  // Bail if value-consuming flags present (can't safely parse positionals)
  for (const flag of VALUE_CONSUMING_FLAGS) {
    if (flags.has(flag)) return false;
  }

  // Extract remote name: first positional after "push" that isn't a flag
  const pushArgs = positionals.slice(1); // skip "push"
  const remoteName = pushArgs[0];
  if (!remoteName) return false; // bare git push

  try {
    // Look up push URL
    const urlProc = Bun.spawn(
      ["git", "remote", "get-url", "--push", remoteName],
      { stdout: "pipe", stderr: "ignore" },
    );
    const urlOutput = await new Response(urlProc.stdout).text();
    if ((await urlProc.exited) !== 0) return false;

    const pushUrl = urlOutput.trim();
    const remoteOwner = extractGitHubOwner(pushUrl);
    if (!remoteOwner) return false;

    // Look up configured user
    const userProc = Bun.spawn(["git", "config", "user.name"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const userOutput = await new Response(userProc.stdout).text();
    if ((await userProc.exited) !== 0) return false;

    const userName = userOutput.trim();
    if (!userName) return false;

    // Case-insensitive comparison
    return remoteOwner.toLowerCase() === userName.toLowerCase();
  } catch {
    return false; // fail-closed
  }
}
