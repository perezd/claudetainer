import { describe, expect, test } from "bun:test";
import { extractGitHubOwner, extractGitHubRepo } from "../github-utils";

describe("extractGitHubOwner", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractGitHubOwner("https://github.com/owner/repo.git")).toBe(
      "owner",
    );
  });
  test("extracts from SSH URL", () => {
    expect(extractGitHubOwner("git@github.com:owner/repo.git")).toBe("owner");
  });
  test("extracts from SSH:// URL", () => {
    expect(extractGitHubOwner("ssh://git@github.com/owner/repo.git")).toBe(
      "owner",
    );
  });
  test("returns null for non-GitHub URL", () => {
    expect(extractGitHubOwner("https://gitlab.com/owner/repo.git")).toBeNull();
  });
});

describe("extractGitHubRepo", () => {
  test("extracts owner and repo from HTTPS", () => {
    expect(
      extractGitHubRepo("https://github.com/perezd/claudetainer.git"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });
  test("extracts from SSH", () => {
    expect(extractGitHubRepo("git@github.com:perezd/claudetainer.git")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });
  test("handles URL without .git suffix", () => {
    expect(extractGitHubRepo("https://github.com/perezd/claudetainer")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });
  test("returns null for non-GitHub URL", () => {
    expect(extractGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
  });
  test("handles repo name with dots (e.g. socket.io)", () => {
    expect(extractGitHubRepo("https://github.com/socketio/socket.io")).toEqual({
      owner: "socketio",
      repo: "socket.io",
    });
  });
  test("handles repo name with dots and .git suffix", () => {
    expect(extractGitHubRepo("git@github.com:socketio/socket.io.git")).toEqual({
      owner: "socketio",
      repo: "socket.io",
    });
  });
  test("handles SSH URL with dots in repo name", () => {
    expect(
      extractGitHubRepo("ssh://git@github.com/socketio/socket.io.git"),
    ).toEqual({ owner: "socketio", repo: "socket.io" });
  });
});
