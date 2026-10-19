import { ActionProposal } from "../schemas";

export type ParseResult =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; code: "malformed_json" | "invalid_shape"; error: string };

export function parseProposal(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return { ok: false, code: "malformed_json", error: "The reply was not valid JSON." };
  }
  const result = ActionProposal.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
    return {
      ok: false,
      code: "invalid_shape",
      error: `The JSON does not match the required format${where}: ${issue?.message ?? "unknown problem"}.`,
    };
  }
  return { ok: true, proposal: result.data };
}

// The schema I send to Ollama. Flat on purpose: it worked in the smoke test.
export const PROPOSAL_FORMAT: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["tool_call", "final"] },
    toolName: { type: "string" },
    args: { type: "object" },
    reason: { type: "string" },
    message: { type: "string" },
  },
  required: ["type"],
};