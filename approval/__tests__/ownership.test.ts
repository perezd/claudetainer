import { describe, expect, test } from "bun:test";
import { parseSegment } from "../tokenize";
import { checkOwnedRemotePush } from "../ownership";

describe("checkOwnedRemotePush", () => {
  test("returns false for non-git commands", async () => {
    const seg = parseSegment(["echo", "hello"], false);
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false for non-push git commands", async () => {
    const seg = parseSegment(["git", "status"], false);
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false if --delete flag present", async () => {
    const seg = parseSegment(
      ["git", "push", "--delete", "origin", "branch"],
      false,
    );
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false if -d flag present", async () => {
    const seg = parseSegment(["git", "push", "-d", "origin", "branch"], false);
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false if value-consuming flag -o present", async () => {
    const seg = parseSegment(["git", "push", "-o", "option", "origin"], false);
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false if --push-option present", async () => {
    const seg = parseSegment(
      ["git", "push", "--push-option", "val", "origin"],
      false,
    );
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });

  test("returns false for bare git push (no remote)", async () => {
    const seg = parseSegment(["git", "push"], false);
    expect(await checkOwnedRemotePush(seg)).toBe(false);
  });
});
