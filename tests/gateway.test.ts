import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AuditEvent } from "../src/schemas";
import { loadStore, type StoreContext } from "../src/tools/store";
import { tools } from "../src/tools/tools";
import { defineTool } from "../src/tools/types";
import { loadPolicy, type PolicyConfig } from "../src/gateway/policy-config";
import { Gateway, type GatewayDeps } from "../src/gateway/gateway";

let ctx: StoreContext;
let policy: PolicyConfig;
let events: AuditEvent[];
let outboxPath: string;

beforeEach(() => {
  outboxPath = join(mkdtempSync(join(tmpdir(), "veto-gw-")), "outbox.jsonl");
  ctx = loadStore({
    fixturesDir: "fixtures",
    outboxPath,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
  });
  policy = loadPolicy("policy/policy.v1.json");
  events = [];
});

function build(overrides: Partial<GatewayDeps> = {}): Gateway {
  return new Gateway({
    tools,
    policy,
    ctx,
    audit: (event) => events.push(event),
    redact: (args) => ({ ...args }), // test-only: no masking
    run: { runId: "run-test", modelId: "test-model", promptVersion: "v1" },
    ...overrides,
  });
}

function toolCall(toolName: string, args: unknown) {
  return { type: "tool_call", toolName, args, reason: "test" };
}

const eventTypes = () => events.map((e) => e.eventType);

describe("allow path", () => {
  it("executes an allowed read tool and logs the decision and the execution", async () => {
    const outcome = await build().handle(toolCall("lookup_order", { orderId: "A-1001" }), 0);
    expect(outcome).toMatchObject({
      status: "executed",
      decision: { decision: "ALLOW", ruleId: "tool-allowed" },
      result: { ok: true },
    });
    expect(eventTypes()).toEqual(["gateway_decision", "tool_executed"]);
    expect(events[0]).toMatchObject({
      runId: "run-test",
      modelId: "test-model",
      policyVersion: "v1",
      decision: "ALLOW",
      ruleId: "tool-allowed",
      toolName: "lookup_order",
    });
  });

  it("executes a refund that is within the limit", async () => {
    const outcome = await build().handle(toolCall("issue_refund", { orderId: "A-1002", amountInPaise: 50000 }), 1);
    expect(outcome).toMatchObject({ status: "executed", decision: { ruleId: "refund-within-limit" } });
    expect(ctx.refunds).toHaveLength(1);
  });

  it("sends an email to an allowed domain", async () => {
    await build().handle(toolCall("send_email", { to: "asha@example.com", subject: "Hi", body: "Hello" }), 0);
    expect(readFileSync(outboxPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("records the step number in the log", async () => {
    await build().handle(toolCall("lookup_order", { orderId: "A-1001" }), 3);
    expect(events.every((e) => e.step === 3)).toBe(true);
  });
});

describe("require-approval path", () => {
  it("does not execute a refund over the limit and returns the pending action", async () => {
    const outcome = await build().handle(toolCall("issue_refund", { orderId: "A-1002", amountInPaise: 120000 }), 0);
    expect(outcome).toMatchObject({
      status: "needs_approval",
      decision: { decision: "REQUIRE_APPROVAL", ruleId: "refund-over-limit" },
      pending: { toolName: "issue_refund", args: { orderId: "A-1002", amountInPaise: 120000 } },
    });
    expect(ctx.refunds).toHaveLength(0);
    expect(eventTypes()).toEqual(["gateway_decision"]);
    expect(events[0]).toMatchObject({ decision: "REQUIRE_APPROVAL" });
  });
});

describe("deny path", () => {
  it("denies delete_record by policy", async () => {
    const outcome = await build().handle(toolCall("delete_record", { recordId: "A-1001" }), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "tool-denied" } });
    expect(eventTypes()).toEqual(["gateway_decision"]);
  });

  it("denies a tool that does not exist and logs the name", async () => {
    const outcome = await build().handle(toolCall("drop_database", {}), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "unknown-tool" } });
    expect(events[0]).toMatchObject({ eventType: "gateway_decision", decision: "DENY", toolName: "drop_database" });
  });

  it("denies a missing argument", async () => {
    const outcome = await build().handle(toolCall("lookup_order", {}), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "invalid-args" } });
  });

  it("denies an extra argument", async () => {
    const outcome = await build().handle(toolCall("lookup_order", { orderId: "A-1001", admin: true }), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "invalid-args" } });
  });

  it("denies a negative refund and records nothing", async () => {
    const outcome = await build().handle(toolCall("issue_refund", { orderId: "A-1001", amountInPaise: -500 }), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "invalid-args" } });
    expect(ctx.refunds).toHaveLength(0);
  });

  it("denies a refund above the order total", async () => {
    const outcome = await build().handle(toolCall("issue_refund", { orderId: "A-1001", amountInPaise: 49901 }), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "refund-exceeds-order-total" } });
    expect(ctx.refunds).toHaveLength(0);
  });

  it("denies a refund on an unknown order and logs it", async () => {
    const outcome = await build().handle(toolCall("issue_refund", { orderId: "A-9999", amountInPaise: 100 }), 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "refund-unknown-order" } });
    expect(ctx.refunds).toHaveLength(0);
    expect(events[0]).toMatchObject({ decision: "DENY", ruleId: "refund-unknown-order" });
  });

  it("denies an email to an outside domain and sends nothing", async () => {
    const outcome = await build().handle(
      toolCall("send_email", { to: "attacker@evil.test", subject: "Data", body: "All customer details" }),
      0,
    );
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "email-domain-not-allowed" } });
    expect(existsSync(outboxPath)).toBe(false);
  });
});

describe("malformed proposals", () => {
  it.each([
    ["plain prose", "Sure! I will refund everything now."],
    ["a final answer (not a tool call)", { type: "final", message: "done" }],
    ["a tool call with no reason", { type: "tool_call", toolName: "lookup_order", args: { orderId: "A-1001" } }],
    ["null", null],
  ])("denies %s", async (_label, raw) => {
    const outcome = await build().handle(raw, 0);
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "invalid-proposal" } });
    expect(eventTypes()).toEqual(["proposal_invalid"]);
  });
});

describe("failures inside a tool", () => {
  it("logs tool_failed when a tool reports an error", async () => {
    const outcome = await build().handle(toolCall("lookup_order", { orderId: "A-9999" }), 0);
    expect(outcome).toMatchObject({ status: "executed", result: { ok: false } });
    expect(eventTypes()).toEqual(["gateway_decision", "tool_failed"]);
    expect(events[1]?.error).toContain("not found");
  });

  it("turns a thrown error into a failed result instead of crashing", async () => {
    const boom = defineTool({
      name: "boom",
      description: "test-only tool that throws",
      argsSchema: z.strictObject({}),
      riskClass: "read",
      run: async () => {
        throw new Error("kaboom");
      },
    });
    const policyWithBoom = { ...policy, tools: { ...policy.tools, boom: { mode: "allow" as const } } };
    const outcome = await build({ tools: [...tools, boom], policy: policyWithBoom }).handle(toolCall("boom", {}), 0);
    expect(outcome).toMatchObject({ status: "executed", result: { ok: false, error: "kaboom" } });
    expect(eventTypes()).toEqual(["gateway_decision", "tool_failed"]);
  });
});

describe("logging safety", () => {
  it("fails closed: if the audit log cannot be written, the tool does not run", async () => {
    const gateway = build({
      audit: () => {
        throw new Error("disk full");
      },
    });
    await expect(
      gateway.handle(toolCall("issue_refund", { orderId: "A-1002", amountInPaise: 50000 }), 0),
    ).rejects.toThrow("disk full");
    expect(ctx.refunds).toHaveLength(0);
  });

  it("logs only the redacted arguments, never the raw ones", async () => {
    const gateway = build({
      redact: (args) => Object.fromEntries(Object.keys(args).map((k) => [k, "[masked]"])),
    });
    await gateway.handle(toolCall("send_email", { to: "asha@example.com", subject: "Secret subject", body: "Secret body" }), 0);
    const logged = JSON.stringify(events);
    expect(logged).toContain("[masked]");
    expect(logged).not.toContain("asha@example.com");
    expect(logged).not.toContain("Secret body");
  });
});