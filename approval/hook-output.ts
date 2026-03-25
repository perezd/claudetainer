type Decision = "allow" | "deny" | "ask";

export function outputDecision(decision: Decision, reason?: string): void {
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
  console.log(JSON.stringify(output));
}
