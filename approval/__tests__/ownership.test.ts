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

  let lastSpawnArgs: string[] = [];

  function mockGitRemote(url: string, exitCode = 0) {
    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = (args: string[]) => {
      lastSpawnArgs = args;
      return {
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
      };
    };
  }

  test("allows push to owned remote", async () => {
    process.env.GIT_USER_NAME = "alice";
    mockGitRemote("https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
    // Verify spawn was called with --push and correct remote
    expect(lastSpawnArgs).toEqual(["git", "remote", "get-url", "--push", "origin"]);
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
    // Verify spawn was called with the parsed remote name, not hardcoded "origin"
    expect(lastSpawnArgs).toEqual(["git", "remote", "get-url", "--push", "my-fork"]);
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
