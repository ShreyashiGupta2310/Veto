import { describe, it, expect } from "vitest";
import { ActionProposal, GatewayDecision, AuditEvent } from "../src/schemas";

describe("ActionProposal", () => {
  it("accepts a valid tool call", () => {
    const result = ActionProposal.safeParse({
      type: "tool_call",
      toolName: "lookup_order",
      args: { orderId: "A-1001" },
      reason: "check the order status",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid final answer", () => {
    const result = ActionProposal.safeParse({ type: "final", message: "Order shipped." });
    expect(result.success).toBe(true);
  });

  it("rejects an extra field on a tool call", () => {
    const result = ActionProposal.safeParse({
      type: "tool_call",
      toolName: "lookup_order",
      args: {},
      reason: "x",
      message: "sneaky extra field",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(ActionProposal.safeParse({ type: "shell", command: "rm -rf /" }).success).toBe(false);
  });

  it("rejects an empty tool name", () => {
    const result = ActionProposal.safeParse({
      type: "tool_call",
      toolName: "",
      args: {},
      reason: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects args that are not an object", () => {
    const result = ActionProposal.safeParse({
      type: "tool_call",
      toolName: "lookup_order",
      args: ["A-1001"],
      reason: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool call with no reason", () => {
    const result = ActionProposal.safeParse({
      type: "tool_call",
      toolName: "lookup_order",
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects plain prose", () => {
    expect(ActionProposal.safeParse("Sure, I will refund everything!").success).toBe(false);
  });
});

describe("GatewayDecision", () => {
  it("accepts a valid decision", () => {
    const result = GatewayDecision.safeParse({
      decision: "DENY",
      ruleId: "default-deny",
      reason: "tool is not on the allowlist",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a decision value that does not exist", () => {
    const result = GatewayDecision.safeParse({
      decision: "MAYBE",
      ruleId: "x",
      reason: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("AuditEvent", () => {
  const base = {
    runId: "run-1",
    step: 0,
    timestamp: new Date().toISOString(),
    eventType: "gateway_decision",
    modelId: "gemma3:4b",
    promptVersion: "v1",
    policyVersion: "v1",
  };

  it("accepts a minimal valid event", () => {
    expect(AuditEvent.safeParse(base).success).toBe(true);
  });

  it("rejects a negative step", () => {
    expect(AuditEvent.safeParse({ ...base, step: -1 }).success).toBe(false);
  });

  it("rejects a timestamp that is not ISO", () => {
    expect(AuditEvent.safeParse({ ...base, timestamp: "yesterday" }).success).toBe(false);
  });
});