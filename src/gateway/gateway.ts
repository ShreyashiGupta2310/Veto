import {
  AuditEvent,
  ToolCallProposal,
  type AuditEventType,
  type GatewayDecision,
} from "../schemas";
import type { StoreContext } from "../tools/store";
import type { ToolDefinition, ToolResult } from "../tools/types";
import type { PolicyConfig } from "./policy-config";
import { evaluatePolicy } from "./policy";

// An action that is waiting for a human. Args are the cleaned, validated ones.
export interface PendingAction {
  toolName: string;
  args: Record<string, unknown>;
}

export type GatewayOutcome =
  | { status: "executed"; decision: GatewayDecision; result: ToolResult }
  | { status: "denied"; decision: GatewayDecision }
  | { status: "needs_approval"; decision: GatewayDecision; pending: PendingAction };

export interface GatewayDeps {
  tools: ToolDefinition[];
  policy: PolicyConfig;
  ctx: StoreContext;
  // Where audit events go. If this throws, the call fails and nothing is executed.
  audit: (event: AuditEvent) => void;
  // Masks personal data before it reaches the log. Required on purpose: there is no default.
  redact: (args: Record<string, unknown>) => Record<string, unknown>;
  run: { runId: string; modelId: string; promptVersion: string };
}

type LogFields = Partial<
  Pick<AuditEvent, "toolName" | "redactedArgs" | "decision" | "ruleId" | "latencyMs" | "error">
>;

function deny(ruleId: string, reason: string): GatewayDecision {
  return { decision: "DENY", ruleId, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly toolsByName: Map<string, ToolDefinition>;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.toolsByName = new Map(deps.tools.map((t) => [t.name, t]));
  }

  async handle(rawProposal: unknown, step: number): Promise<GatewayOutcome> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;

    // Check 1: is it a readable tool call at all? (prose, broken shapes and final answers all fail here)
    const proposal = ToolCallProposal.safeParse(rawProposal);
    if (!proposal.success) {
      const why = proposal.error.issues[0]?.message ?? "unreadable";
      const decision = deny("invalid-proposal", `The proposal is not a valid tool call: ${why}.`);
      this.log("proposal_invalid", step, {
        decision: "DENY",
        ruleId: decision.ruleId,
        latencyMs: elapsed(),
        error: decision.reason,
      });
      return { status: "denied", decision };
    }

    const { toolName, args } = proposal.data;
    const loggedName = toolName.slice(0, 100);

    // Check 2: the tool must be on my list.
    const tool = this.toolsByName.get(toolName);
    if (!tool) {
      const decision = deny("unknown-tool", `There is no tool called "${loggedName}".`);
      return this.finishDenied(decision, step, elapsed(), loggedName, this.safeRedact(args));
    }

    // Check 3: the arguments must fit the tool's own form.
    const parsedArgs = tool.argsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const issue = parsedArgs.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
      const decision = deny("invalid-args", `Invalid arguments for ${tool.name}: ${issue?.message ?? "unreadable"}${where}.`);
      return this.finishDenied(decision, step, elapsed(), tool.name, this.safeRedact(args));
    }
    const cleanArgs = parsedArgs.data as Record<string, unknown>;
    const redactedArgs = this.deps.redact(cleanArgs);

    // Checks 4 and 5: the rulebook decides.
    const decision = evaluatePolicy({ tool, args: cleanArgs }, this.deps.policy, this.deps.ctx);

    // The decision is logged BEFORE anything happens. If logging fails, nothing runs.
    this.log("gateway_decision", step, {
      toolName: tool.name,
      redactedArgs,
      decision: decision.decision,
      ruleId: decision.ruleId,
      latencyMs: elapsed(),
    });

    if (decision.decision === "DENY") {
      return { status: "denied", decision };
    }
    if (decision.decision === "REQUIRE_APPROVAL") {
      return { status: "needs_approval", decision, pending: { toolName: tool.name, args: cleanArgs } };
    }
    return this.execute(tool, cleanArgs, redactedArgs, decision, step);
  }

    // Called by the approval queue when an action goes into the waiting room.
  recordApprovalRequested(pending: PendingAction, decision: GatewayDecision, step: number): void {
    this.log("approval_requested", step, {
      toolName: pending.toolName,
      redactedArgs: this.deps.redact(pending.args),
      decision: decision.decision,
      ruleId: decision.ruleId,
    });
  }

  // Called when a human says no.
  recordRejected(pending: PendingAction, step: number): void {
    this.log("approval_resolved", step, {
      toolName: pending.toolName,
      redactedArgs: this.deps.redact(pending.args),
      decision: "DENY",
      ruleId: "human-rejected",
    });
  }

  // Called when a human says yes. The rulebook is checked again first:
  // a human can approve "ask a human", but never overrule a hard DENY.
  async executeApproved(pending: PendingAction, step: number): Promise<GatewayOutcome> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;

    const tool = this.toolsByName.get(pending.toolName);
    if (!tool) {
      const decision = deny("unknown-tool", `There is no tool called "${pending.toolName.slice(0, 100)}".`);
      return this.finishDenied(decision, step, elapsed(), pending.toolName.slice(0, 100), undefined);
    }

    const parsedArgs = tool.argsSchema.safeParse(pending.args);
    if (!parsedArgs.success) {
      const decision = deny("invalid-args", `Invalid arguments for ${tool.name}.`);
      return this.finishDenied(decision, step, elapsed(), tool.name, this.safeRedact(pending.args));
    }
    const cleanArgs = parsedArgs.data as Record<string, unknown>;
    const redactedArgs = this.deps.redact(cleanArgs);

    const recheck = evaluatePolicy({ tool, args: cleanArgs }, this.deps.policy, this.deps.ctx);
    if (recheck.decision === "DENY") {
      return this.finishDenied(recheck, step, elapsed(), tool.name, redactedArgs);
    }

    const decision: GatewayDecision = {
      decision: "ALLOW",
      ruleId: "human-approved",
      reason: `A human approved ${tool.name}. The policy rule at that moment was ${recheck.ruleId}.`,
    };
    this.log("approval_resolved", step, {
      toolName: tool.name,
      redactedArgs,
      decision: "ALLOW",
      ruleId: decision.ruleId,
      latencyMs: elapsed(),
    });
    return this.execute(tool, cleanArgs, redactedArgs, decision, step);
  }

  private finishDenied(
    decision: GatewayDecision,
    step: number,
    latencyMs: number,
    toolName: string,
    redactedArgs: Record<string, unknown> | undefined,
  ): GatewayOutcome {
    this.log("gateway_decision", step, {
      toolName,
      redactedArgs,
      decision: "DENY",
      ruleId: decision.ruleId,
      latencyMs,
      error: decision.reason,
    });
    return { status: "denied", decision };
  }

  private async execute(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    redactedArgs: Record<string, unknown>,
    decision: GatewayDecision,
    step: number,
  ): Promise<GatewayOutcome> {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await tool.execute(args, this.deps.ctx);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.log(result.ok ? "tool_executed" : "tool_failed", step, {
      toolName: tool.name,
      redactedArgs,
      latencyMs: Date.now() - started,
      error: result.ok ? undefined : result.error,
    });
    return { status: "executed", decision, result };
  }

  // Only redact args that are a plain object. Anything else is left out of the log.
  private safeRedact(args: unknown): Record<string, unknown> | undefined {
    return isRecord(args) ? this.deps.redact(args) : undefined;
  }

  private log(eventType: AuditEventType, step: number, fields: LogFields): void {
    const { runId, modelId, promptVersion } = this.deps.run;
    // Parsing the event is a check too: a malformed event throws, and so nothing runs.
    const event = AuditEvent.parse({
      runId,
      step,
      timestamp: this.deps.ctx.now().toISOString(),
      eventType,
      modelId,
      promptVersion,
      policyVersion: this.deps.policy.version,
      ...fields,
    });
    this.deps.audit(event);
  }
}

