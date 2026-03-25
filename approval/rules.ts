export interface BlockRule {
  pattern: RegExp;
  raw: string;
}

export interface Rules {
  blocks: BlockRule[];
  hotWords: string[];
}

export function parseRules(content: string): Rules {
  const blocks: BlockRule[] = [];
  const hotWords: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const type = trimmed.slice(0, colonIdx);
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (type) {
      case "block":
      case "block-pattern":
        blocks.push({ pattern: new RegExp(value), raw: value });
        break;
      case "hot":
        hotWords.push(value);
        break;
      default:
        break;
    }
  }

  return { blocks, hotWords };
}
