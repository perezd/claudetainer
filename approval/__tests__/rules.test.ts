import { describe, expect, test } from "bun:test";
import { parseRules } from "../rules";

const SAMPLE_CONF = `
# Comment line
block:\\bsudo\\b
block:\\beval\\b

block-pattern:.*\\|\\s*/?(usr/)?(s?bin/)?(ba)?sh\\b
block-pattern:^rm\\s+-rf\\s+/

hot:curl
hot:bun add
hot:GH_PAT
`;

describe("parseRules", () => {
  const rules = parseRules(SAMPLE_CONF);

  test("parses block rules as regex", () => {
    expect(rules.blocks).toHaveLength(4); // 2 block + 2 block-pattern
    expect(rules.blocks[0].pattern.test("sudo rm -rf /")).toBe(true);
    expect(rules.blocks[0].pattern.test("pseudocode")).toBe(false);
  });

  test("parses hot words as plain strings", () => {
    expect(rules.hotWords).toEqual(["curl", "bun add", "GH_PAT"]);
  });

  test("skips comments and blank lines", () => {
    const rules = parseRules("# comment\n\nblock:\\bsudo\\b");
    expect(rules.blocks).toHaveLength(1);
    expect(rules.hotWords).toEqual([]);
  });

  test("throws on invalid regex in block rule", () => {
    expect(() => parseRules("block:[invalid")).toThrow();
  });
});
