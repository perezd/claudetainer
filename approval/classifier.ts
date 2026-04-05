import { readFileSync, existsSync } from "fs";

const SYSTEM_PROMPT = readFileSync(
  new URL("./system-prompt.txt", import.meta.url),
  "utf-8",
);

export type Verdict =
  | { verdict: "allow"; reason: string }
  | { verdict: "block"; reason: string }
  | { verdict: "approve"; reason: string }
  | { verdict: "need_files"; files: string[]; reason: string };

const VALID_VERDICTS = new Set(["allow", "block", "approve", "need_files"]);
const BLOCKED_FILE_PATTERNS = [".ghtoken", ".npmrc", "hosts.yml", "/tmp/otel/"];
const MAX_FILE_SIZE = 8192; // 8KB
const MAX_FILES = 3;

/**
 * Parse a verdict JSON string from Haiku's response.
 * Extracts JSON from surrounding text if needed.
 */
export function parseVerdict(text: string): Verdict {
  try {
    const jsonMatch = text.match(/\{[^}]*"verdict"[^}]*\}/);
    if (!jsonMatch) return { verdict: "block", reason: "no JSON in response" };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!VALID_VERDICTS.has(parsed.verdict)) {
      return { verdict: "block", reason: `unknown verdict: ${parsed.verdict}` };
    }

    if (parsed.verdict === "need_files") {
      if (!Array.isArray(parsed.files)) {
        return { verdict: "block", reason: "need_files without files array" };
      }
      return {
        verdict: "need_files",
        files: parsed.files,
        reason: parsed.reason || "",
      };
    }

    return { verdict: parsed.verdict, reason: parsed.reason || "" };
  } catch {
    return { verdict: "block", reason: "failed to parse verdict" };
  }
}

/**
 * Validate a file path requested by Haiku for inspection.
 */
export function validateFilePath(path: string): boolean {
  if (path.includes("..")) return false;
  if (!path.startsWith("/tmp/") && !path.startsWith("/workspace/")) {
    return false;
  }
  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (path.includes(pattern)) return false;
  }
  return true;
}

/**
 * Read a file for Haiku inspection with safety checks.
 */
function readFileForInspection(path: string): string {
  if (!validateFilePath(path)) return "<access denied>";
  if (!existsSync(path)) return "<file not found>";

  try {
    const content = readFileSync(path);

    // Binary detection: check first 512 bytes for null bytes
    const header = content.subarray(0, 512);
    if (header.includes(0)) return "<binary file, not shown>";

    const text = content.toString("utf-8");
    if (text.length > MAX_FILE_SIZE) {
      return text.slice(0, MAX_FILE_SIZE) + "\n<truncated at 8KB>";
    }

    return text;
  } catch {
    return "<error reading file>";
  }
}

/**
 * Build the user message for Turn 1 (command only).
 */
export function buildUserMessage(command: string): string {
  return `<command>\n${command}\n</command>`;
}

/**
 * Build the user message for Turn 2 (command + referenced files).
 */
export function buildFileInspectionMessage(
  command: string,
  files: Array<{ path: string; content: string }>,
): string {
  let msg = `<command>\n${command}\n</command>\n`;
  for (const file of files) {
    msg += `\n<referenced-file path="${file.path}">\n${file.content}\n</referenced-file>`;
  }
  return msg;
}

/**
 * Classify a command using Haiku with two-turn file inspection.
 */
export async function classifyWithHaiku(
  command: string,
  maxAttempts = 2,
): Promise<Verdict> {
  // Turn 1: classify or request files
  const turn1Verdict = await invokeHaiku(
    buildUserMessage(command),
    maxAttempts,
  );

  if (turn1Verdict.verdict !== "need_files") {
    return turn1Verdict;
  }

  // Between turns: read requested files
  const requestedFiles = turn1Verdict.files.slice(0, MAX_FILES);
  const fileContents = requestedFiles.map((path) => ({
    path,
    content: readFileForInspection(path),
  }));

  // Turn 2: classify with file context
  const turn2Verdict = await invokeHaiku(
    buildFileInspectionMessage(command, fileContents),
    maxAttempts,
  );

  // Turn 2 must produce a final verdict — no further need_files
  if (turn2Verdict.verdict === "need_files") {
    return { verdict: "block", reason: "recursive file request denied" };
  }

  return turn2Verdict;
}

/**
 * Invoke Haiku via claude -p subprocess.
 */
async function invokeHaiku(
  userMessage: string,
  maxAttempts: number,
): Promise<Verdict> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "claude",
          "-p",
          "--model",
          "claude-haiku-4-5-20251001",
          "--max-turns",
          "1",
          "-",
        ],
        {
          stdin: new TextEncoder().encode(
            JSON.stringify({
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userMessage }],
            }),
          ),
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, CLAUDE_SESSION_NAMER: "1" },
        },
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) continue;

      const verdict = parseVerdict(output);
      return verdict;
    } catch {
      continue;
    }
  }

  return { verdict: "block", reason: "haiku classification failed" };
}
