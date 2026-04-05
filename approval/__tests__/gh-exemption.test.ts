import { describe, expect, test } from "bun:test";
import { parseSegment } from "../tokenize";
import {
  extractRepoTarget,
  isRelatedRepo,
  isDeleteMethod,
  type RepoTarget,
} from "../gh-exemption";

describe("extractRepoTarget", () => {
  test("extracts from gh api repos/owner/repo/...", () => {
    const seg = parseSegment(["gh", "api", "repos/owner/repo/issues"], false);
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("extracts from gh api /repos/owner/repo/...", () => {
    const seg = parseSegment(["gh", "api", "/repos/owner/repo/issues"], false);
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("rejects path traversal in gh api", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner/../other/issues"],
      false,
    );
    expect(extractRepoTarget(seg)).toBeNull();
  });
  test("rejects percent encoding in gh api", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner%2F/repo/issues"],
      false,
    );
    expect(extractRepoTarget(seg)).toBeNull();
  });
  test("rejects double slashes in gh api", () => {
    const seg = parseSegment(["gh", "api", "repos/owner//repo/issues"], false);
    expect(extractRepoTarget(seg)).toBeNull();
  });
  test("extracts from --repo flag", () => {
    const seg = parseSegment(
      ["gh", "pr", "create", "--repo", "owner/repo"],
      false,
    );
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("extracts from -R flag", () => {
    const seg = parseSegment(
      ["gh", "issue", "list", "-R", "owner/repo"],
      false,
    );
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("extracts from --repo=owner/repo", () => {
    const seg = parseSegment(
      ["gh", "pr", "create", "--repo=owner/repo"],
      false,
    );
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("extracts from -R=owner/repo (combined short flag form)", () => {
    const seg = parseSegment(["gh", "issue", "list", "-R=owner/repo"], false);
    expect(extractRepoTarget(seg)).toEqual({ owner: "owner", repo: "repo" });
  });
  test("returns 'implicit' for gh pr create without --repo", () => {
    const seg = parseSegment(["gh", "pr", "create", "--title", "test"], false);
    expect(extractRepoTarget(seg)).toBe("implicit");
  });
  test("validates owner/repo chars", () => {
    const seg = parseSegment(["gh", "api", "repos/own;er/repo/issues"], false);
    expect(extractRepoTarget(seg)).toBeNull();
  });
});

describe("isDeleteMethod", () => {
  test("detects -X DELETE", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner/repo/issues/1", "-X", "DELETE"],
      false,
    );
    expect(isDeleteMethod(seg)).toBe(true);
  });
  test("detects --method DELETE", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner/repo/issues/1", "--method", "DELETE"],
      false,
    );
    expect(isDeleteMethod(seg)).toBe(true);
  });
  test("detects --method=DELETE", () => {
    const seg = parseSegment(
      ["gh", "api", "--method=DELETE", "repos/owner/repo/issues/1"],
      false,
    );
    expect(isDeleteMethod(seg)).toBe(true);
  });
  test("does not flag GET", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner/repo/issues", "-X", "GET"],
      false,
    );
    expect(isDeleteMethod(seg)).toBe(false);
  });
  test("does not flag POST", () => {
    const seg = parseSegment(
      ["gh", "api", "repos/owner/repo/issues", "--method", "POST"],
      false,
    );
    expect(isDeleteMethod(seg)).toBe(false);
  });
});

describe("isRelatedRepo", () => {
  const snapshot: RepoTarget[] = [
    { owner: "perezd", repo: "claudetainer" },
    { owner: "upstream-org", repo: "claudetainer" },
  ];

  test("matches exact owner/repo", () => {
    expect(
      isRelatedRepo({ owner: "perezd", repo: "claudetainer" }, snapshot),
    ).toBe(true);
  });
  test("case-insensitive match", () => {
    expect(
      isRelatedRepo({ owner: "PerezD", repo: "Claudetainer" }, snapshot),
    ).toBe(true);
  });
  test("rejects unrelated repo", () => {
    expect(isRelatedRepo({ owner: "evil", repo: "target" }, snapshot)).toBe(
      false,
    );
  });
  test("rejects empty snapshot", () => {
    expect(isRelatedRepo({ owner: "perezd", repo: "claudetainer" }, [])).toBe(
      false,
    );
  });
});
