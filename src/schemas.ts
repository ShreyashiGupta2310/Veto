import { z } from "zod";

// What the model is allowed to ask for: one tool call, or a final answer.
// strictObject rejects any extra field, so a sloppy answer is invalid, not silently accepted.
export const ToolCallProposal = z.strictObject({
  type: z.literal("tool_call"),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  reason: z.string().min(1).max(300),
});

export const FinalProposal = z.strictObject({
  type: z.literal("final"),
  message: z.string().min(1),
});

export const ActionProposal = z.discriminatedUnion("type", [
  ToolCallProposal,
  FinalProposal,
]);
export type ActionProposal = z.infer<typeof ActionProposal>;

// How dangerous a tool is.
export const RiskClass = z.enum(["read", "reversible-write", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClass>;

// The guard's answer.
export const DecisionKind = z.enum(["ALLOW", "REQUIRE_APPROVAL", "DENY"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const GatewayDecision = z.strictObject({
  decision: DecisionKind,
  ruleId: z.string().min(1),
  reason: z.string().min(1),
});
export type GatewayDecision = z.infer<typeof GatewayDecision>;

// How a run can end.
export const RunStatus = z.enum([
  "completed",
  "denied_and_stopped",
  "awaiting_approval",
  "step_limit",
  "failed_invalid_output",
  "failed_model_error",
]);
export type RunStatus = z.infer<typeof RunStatus>;

// One line in the audit log.
export const AuditEventType = z.enum([
  "run_started",
  "model_response",
  "proposal_invalid",
  "gateway_decision",
  "approval_requested",
  "approval_resolved",
  "tool_executed",
  "tool_failed",
  "run_finished",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEvent = z.strictObject({
  runId: z.string().min(1),
  step: z.number().int().nonnegative(),
  timestamp: z.iso.datetime(),
  eventType: AuditEventType,
  toolName: z.string().optional(),
  redactedArgs: z.record(z.string(), z.unknown()).optional(),
  decision: DecisionKind.optional(),
  ruleId: z.string().optional(),
  latencyMs: z.number().nonnegative().optional(),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  error: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;