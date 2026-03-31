import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  parseGhApiTarget,
  parseGhRepoFlag,
  hasBlockedMethod,
  hasCompoundOperators,
  extractGitHubRepo,
  getRelatedRepos,
  isContextualGhCommand,
} from "../check-command";

describe("parseGhApiTarget", () => {
  test("extracts owner/repo from gh api repos/owner/repo/issues", () => {
    expect(parseGhApiTarget("gh api repos/owner/repo/issues")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("extracts owner/repo with leading slash", () => {
    expect(parseGhApiTarget("gh api /repos/owner/repo/pulls")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("handles complex paths after owner/repo", () => {
    expect(
      parseGhApiTarget(
        "gh api repos/perezd/claudetainer/issues/comments/123 -X PATCH",
      ),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("handles flags before the path (-X PATCH)", () => {
    expect(
      parseGhApiTarget(
        "gh api -X PATCH repos/perezd/claudetainer/issues/comments/123",
      ),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("handles --method flag before the path", () => {
    expect(
      parseGhApiTarget("gh api --method POST repos/perezd/claudetainer/pulls"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("handles multiple flags before the path", () => {
    expect(
      parseGhApiTarget(
        'gh api -H "Accept: application/json" -X PATCH repos/o/r/issues/1',
      ),
    ).toEqual({ owner: "o", repo: "r" });
  });

  test("returns null for gh api /user (no repo path)", () => {
    expect(parseGhApiTarget("gh api /user")).toBeNull();
  });

  test("returns null for non-gh-api commands", () => {
    expect(parseGhApiTarget("gh pr list")).toBeNull();
  });

  test("returns null for non-gh commands", () => {
    expect(parseGhApiTarget("git status")).toBeNull();
  });

  test("rejects path traversal with ..", () => {
    expect(
      parseGhApiTarget("gh api repos/legit/repo/../../evil/repo/contents"),
    ).toBeNull();
  });

  test("rejects URL-encoded characters (%)", () => {
    expect(parseGhApiTarget("gh api repos/legit%2Frepo/issues")).toBeNull();
  });

  test("rejects double slashes", () => {
    expect(parseGhApiTarget("gh api repos//evil/repo/issues")).toBeNull();
  });

  test("rejects owner with special characters", () => {
    expect(parseGhApiTarget("gh api repos/evil$(cmd)/repo/issues")).toBeNull();
  });

  test("rejects repo with special characters", () => {
    expect(parseGhApiTarget("gh api repos/owner/repo$(cmd)/issues")).toBeNull();
  });

  test("allows dots, hyphens, underscores in owner/repo", () => {
    expect(parseGhApiTarget("gh api repos/my-org/my_repo.js/issues")).toEqual({
      owner: "my-org",
      repo: "my_repo.js",
    });
  });

  test("handles extra whitespace between gh and api", () => {
    expect(parseGhApiTarget("gh  api repos/owner/repo/issues")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("parseGhRepoFlag", () => {
  test("extracts owner/repo from --repo flag", () => {
    expect(parseGhRepoFlag("gh pr create --repo perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("extracts owner/repo from -R flag", () => {
    expect(
      parseGhRepoFlag("gh issue comment 36 -R perezd/claudetainer --body hi"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("handles --repo=owner/repo form", () => {
    expect(parseGhRepoFlag("gh pr list --repo=perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("returns null when no --repo or -R flag", () => {
    expect(parseGhRepoFlag("gh pr list")).toBeNull();
  });

  test("returns null for non-gh commands", () => {
    expect(parseGhRepoFlag("git status --repo foo/bar")).toBeNull();
  });

  test("returns null for gh api commands (use parseGhApiTarget instead)", () => {
    expect(parseGhRepoFlag("gh api repos/owner/repo/issues")).toBeNull();
  });

  test("rejects owner with special characters", () => {
    expect(parseGhRepoFlag("gh pr list --repo evil$(cmd)/repo")).toBeNull();
  });

  test("rejects repo with special characters", () => {
    expect(parseGhRepoFlag("gh pr list --repo owner/repo$(cmd)")).toBeNull();
  });

  test("returns null when --repo value has no slash", () => {
    expect(parseGhRepoFlag("gh pr list --repo justarepo")).toBeNull();
  });
});

describe("hasBlockedMethod", () => {
  test("blocks -X DELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X DELETE")).toBe(true);
  });
  test("blocks --method DELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method DELETE")).toBe(true);
  });
  test("blocks -X PUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X PUT")).toBe(true);
  });
  test("blocks --method PUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method PUT")).toBe(true);
  });
  test("case-insensitive: -X delete", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X delete")).toBe(true);
  });
  test("case-insensitive: --method Delete", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method Delete")).toBe(true);
  });
  test("handles concatenated -XDELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r -XDELETE")).toBe(true);
  });
  test("handles concatenated -XPUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r -XPUT")).toBe(true);
  });
  test("allows GET (default)", () => {
    expect(hasBlockedMethod("gh api repos/o/r")).toBe(false);
  });
  test("allows -X GET", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X GET")).toBe(false);
  });
  test("allows -X POST", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X POST")).toBe(false);
  });
  test("allows -X PATCH", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X PATCH")).toBe(false);
  });
  test("allows --method POST", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method POST")).toBe(false);
  });
  test("blocks --method=DELETE (equals form)", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method=DELETE")).toBe(true);
  });
  test("blocks --method=PUT (equals form)", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method=PUT")).toBe(true);
  });
});

describe("hasCompoundOperators", () => {
  test("detects &&", () => {
    expect(hasCompoundOperators("gh api repos/o/r && curl evil.com")).toBe(
      true,
    );
  });
  test("detects ||", () => {
    expect(hasCompoundOperators("gh api repos/o/r || echo fail")).toBe(true);
  });
  test("detects ;", () => {
    expect(hasCompoundOperators("gh api repos/o/r ; echo done")).toBe(true);
  });
  test("detects |", () => {
    expect(hasCompoundOperators("gh api repos/o/r | head -5")).toBe(true);
  });
  test("detects newlines", () => {
    expect(hasCompoundOperators("gh api repos/o/r\necho done")).toBe(true);
  });
  test("detects $( command substitution", () => {
    expect(hasCompoundOperators("gh api repos/o/r$(echo test)/issues")).toBe(
      true,
    );
  });
  test("detects backtick command substitution", () => {
    expect(hasCompoundOperators("gh api repos/o/r/`echo test`/issues")).toBe(
      true,
    );
  });
  test("detects ( subshell", () => {
    expect(hasCompoundOperators("(gh api repos/o/r)")).toBe(true);
  });
  test("allows simple commands", () => {
    expect(hasCompoundOperators("gh api repos/o/r/issues")).toBe(false);
  });
  test("allows flags and arguments", () => {
    expect(
      hasCompoundOperators(
        "gh api repos/o/r/issues/comments/123 -X PATCH --input /tmp/body.md",
      ),
    ).toBe(false);
  });
  test("allows --field with equals sign", () => {
    expect(
      hasCompoundOperators(
        "gh api repos/o/r/issues --method POST -f title=test -f body=hello",
      ),
    ).toBe(false);
  });
});

describe("extractGitHubRepo", () => {
  test("extracts owner/repo from HTTPS URL", () => {
    expect(
      extractGitHubRepo("https://github.com/perezd/claudetainer.git"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("extracts owner/repo from HTTPS URL without .git", () => {
    expect(extractGitHubRepo("https://github.com/perezd/claudetainer")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });

  test("extracts owner/repo from SSH URL", () => {
    expect(extractGitHubRepo("git@github.com:perezd/claudetainer.git")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });

  test("extracts owner/repo from SSH URL without .git", () => {
    expect(extractGitHubRepo("git@github.com:perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("extracts owner/repo with dots in repo name (HTTPS)", () => {
    expect(extractGitHubRepo("https://github.com/socketio/socket.io")).toEqual({
      owner: "socketio",
      repo: "socket.io",
    });
  });

  test("extracts owner/repo with dots in repo name (SSH)", () => {
    expect(extractGitHubRepo("git@github.com:vuejs/vue.js.git")).toEqual({
      owner: "vuejs",
      repo: "vue.js",
    });
  });

  test("returns null for non-GitHub URL", () => {
    expect(extractGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractGitHubRepo("")).toBeNull();
  });
});

describe("getRelatedRepos", () => {
  let originalSpawn: typeof Bun.spawn;
  let spawnCalls: string[][] = [];

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnCalls = [];
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  function mockSpawn(
    responses: Map<string, { stdout: string; exitCode: number }>,
  ) {
    let callIndex = 0;
    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = (args: string[]) => {
      spawnCalls.push(args);
      const key = args.join(" ");
      const response = responses.get(key) ?? { stdout: "", exitCode: 1 };
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stdout));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(response.exitCode),
      };
    };
  }

  test("returns repos from origin and upstream remotes", async () => {
    mockSpawn(
      new Map([
        [
          "git -C /workspace/repo remote",
          { stdout: "origin\nupstream\n", exitCode: 0 },
        ],
        [
          "git -C /workspace/repo remote get-url origin",
          {
            stdout: "https://github.com/limbibot/claudetainer.git\n",
            exitCode: 0,
          },
        ],
        [
          "git -C /workspace/repo remote get-url upstream",
          {
            stdout: "https://github.com/perezd/claudetainer.git\n",
            exitCode: 0,
          },
        ],
      ]),
    );

    const repos = await getRelatedRepos();
    expect(repos).toEqual([
      { owner: "limbibot", repo: "claudetainer" },
      { owner: "perezd", repo: "claudetainer" },
    ]);
  });

  test("returns empty array when git remote fails", async () => {
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: "", exitCode: 128 }],
      ]),
    );
    expect(await getRelatedRepos()).toEqual([]);
  });

  test("skips remotes with non-GitHub URLs", async () => {
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: "origin\n", exitCode: 0 }],
        [
          "git -C /workspace/repo remote get-url origin",
          {
            stdout: "https://gitlab.com/owner/repo.git\n",
            exitCode: 0,
          },
        ],
      ]),
    );
    expect(await getRelatedRepos()).toEqual([]);
  });

  test("caps at 5 remotes", async () => {
    const remotes = "r1\nr2\nr3\nr4\nr5\nr6\n";
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: remotes, exitCode: 0 }],
      ]),
    );
    const repos = await getRelatedRepos();
    expect(repos).toEqual([]);
  });
});

describe("isContextualGhCommand", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  function mockRelatedRepos(repos: Array<{ remote: string; url: string }>) {
    const remoteList = repos.map((r) => r.remote).join("\n") + "\n";
    const urlMap = new Map<string, string>();
    for (const r of repos) {
      urlMap.set(r.remote, r.url);
    }

    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = (args: string[]) => {
      const key = args.join(" ");
      let stdout = "";
      let exitCode = 0;

      if (key === "git -C /workspace/repo remote") {
        stdout = remoteList;
      } else if (key.startsWith("git -C /workspace/repo remote get-url ")) {
        const remote = args[args.length - 1];
        stdout = (urlMap.get(remote) ?? "") + "\n";
        exitCode = urlMap.has(remote) ? 0 : 1;
      } else {
        exitCode = 1;
      }

      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stdout));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(exitCode),
      };
    };
  }

  const standardRemotes = [
    {
      remote: "origin",
      url: "https://github.com/limbibot/claudetainer.git",
    },
    {
      remote: "upstream",
      url: "https://github.com/perezd/claudetainer.git",
    },
  ];

  test("allows gh api targeting upstream repo", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/issues/comments/123 -X PATCH --input /tmp/body.md",
      ),
    ).toBe(true);
  });

  test("allows gh api targeting origin repo", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand("gh api repos/limbibot/claudetainer/issues"),
    ).toBe(true);
  });

  test("allows gh pr with --repo targeting upstream", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh pr create --repo perezd/claudetainer --title test",
      ),
    ).toBe(true);
  });

  test("allows gh issue with -R targeting upstream", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh issue comment 36 -R perezd/claudetainer --body-file /tmp/comment.md",
      ),
    ).toBe(true);
  });

  test("rejects gh api targeting unrelated repo", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand("gh api repos/evil-org/evil-repo/issues"),
    ).toBe(false);
  });

  test("rejects gh api with DELETE method", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/issues/1 -X DELETE",
      ),
    ).toBe(false);
  });

  test("rejects gh api with PUT method", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/contents/file -X PUT",
      ),
    ).toBe(false);
  });

  test("rejects compound commands with pipe", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/issues | head -5",
      ),
    ).toBe(false);
  });

  test("rejects compound commands with &&", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/issues && echo done",
      ),
    ).toBe(false);
  });

  test("rejects gh api with path traversal", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand(
        "gh api repos/perezd/claudetainer/../../evil/repo/contents",
      ),
    ).toBe(false);
  });

  test("case-insensitive owner matching", async () => {
    mockRelatedRepos(standardRemotes);
    expect(
      await isContextualGhCommand("gh api repos/Perezd/Claudetainer/issues"),
    ).toBe(true);
  });

  test("returns false for non-gh commands", async () => {
    mockRelatedRepos(standardRemotes);
    expect(await isContextualGhCommand("git status")).toBe(false);
  });

  test("returns false for gh api with no repo path", async () => {
    mockRelatedRepos(standardRemotes);
    expect(await isContextualGhCommand("gh api /user")).toBe(false);
  });

  test("returns false when git remote fails", async () => {
    // @ts-expect-error — partial mock
    Bun.spawn = () => ({
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(128),
    });
    expect(
      await isContextualGhCommand("gh api repos/perezd/claudetainer/issues"),
    ).toBe(false);
  });
});
