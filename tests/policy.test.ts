import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { loadStore, type StoreContext } from "../src/tools/store";
import { getTool } from "../src/tools/tools";
import { defineTool } from "../src/tools/types";
import { loadPolicy, type PolicyConfig } from "../src/gateway/policy-config";
import { evaluatePolicy } from "../src/gateway/policy";

let ctx: StoreContext;
let policy: PolicyConfig;

beforeEach(() => {
  ctx = loadStore({
    fixturesDir: "fixtures",
    outboxPath: "data/test-outbox.jsonl",
    now: () => new Date("2026-10-18T10:00:00.000Z"),
  });
  policy = loadPolicy("policy/policy.v1.json");
});

function decide(toolName: string, args: unknown) {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`no such tool: ${toolName}`);
  return evaluatePolicy({ tool, args }, policy, ctx);
}

describe("tool-level rules", () => {
  it("allows a read tool", () => {
    expect(decide("lookup_order", { orderId: "A-1001" })).toMatchObject({
      decision: "ALLOW",
      ruleId: "tool-allowed",
    });
  });

  it("denies delete_record", () => {
    expect(decide("delete_record", { recordId: "A-1001" })).toMatchObject({
      decision: "DENY",
      ruleId: "tool-denied",
    });
  });

  it("denies a tool that is missing from the policy (default deny)", () => {
    const { lookup_order: _removed, ...rest } = policy.tools;
    policy = { ...policy, tools: rest };
    expect(decide("lookup_order", { orderId: "A-1001" })).toMatchObject({
      decision: "DENY",
      ruleId: "default-deny",
    });
  });

  it("requires approval for an irreversible tool that has no specific rule", () => {
    const wipe = defineTool({
      name: "wipe_cache",
      description: "test-only irreversible tool",
      argsSchema: z.strictObject({}),
      riskClass: "irreversible",
      run: async () => ({ ok: true, data: null }),
    });
    policy = { ...policy, tools: { ...policy.tools, wipe_cache: { mode: "allow" } } };
    expect(evaluatePolicy({ tool: wipe, args: {} }, policy, ctx)).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      ruleId: "irreversible-requires-approval",
    });
  });

  it("requires approval for a refund when the policy has no refund limits", () => {
    policy = { ...policy, tools: { ...policy.tools, issue_refund: { mode: "allow" } } };
    expect(decide("issue_refund", { orderId: "A-1001", amountInPaise: 100 })).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      ruleId: "irreversible-requires-approval",
    });
  });
});

describe("send_email rules", () => {
  const email = (to: unknown) => decide("send_email", { to, subject: "Hi", body: "Hi" });

  it("allows an allowlisted domain", () => {
    expect(email("asha@example.com")).toMatchObject({ decision: "ALLOW", ruleId: "email-domain-allowed" });
  });

  it("ignores letter case in the domain", () => {
    expect(email("asha@EXAMPLE.com")).toMatchObject({ decision: "ALLOW" });
  });

  it.each([
    "attacker@evil.test",
    "asha@example.com.evil.test",
    "asha@evil-example.com",
    "asha@mail.example.com",
    "asha@example.com@evil.test",
  ])("denies %s", (to) => {
    expect(email(to)).toMatchObject({ decision: "DENY", ruleId: "email-domain-not-allowed" });
  });

  it("denies when the recipient is missing", () => {
    expect(decide("send_email", { subject: "Hi", body: "Hi" })).toMatchObject({
      decision: "DENY",
      ruleId: "invalid-args",
    });
  });

  it("denies when no domain list is configured", () => {
    policy = { ...policy, tools: { ...policy.tools, send_email: { mode: "allow" } } };
    expect(email("asha@example.com")).toMatchObject({
      decision: "DENY",
      ruleId: "email-domain-not-allowed",
    });
  });
});

describe("issue_refund rules", () => {
  const refund = (orderId: string, amountInPaise: unknown) =>
    decide("issue_refund", { orderId, amountInPaise });

  it("allows a refund exactly at the auto-approve limit", () => {
    expect(refund("A-1002", 50000)).toMatchObject({ decision: "ALLOW", ruleId: "refund-within-limit" });
  });

  it("requires approval one paisa above the limit", () => {
    expect(refund("A-1002", 50001)).toMatchObject({ decision: "REQUIRE_APPROVAL", ruleId: "refund-over-limit" });
  });

  it("requires approval for the full total of an order when that is over the limit", () => {
    expect(refund("A-1002", 120000)).toMatchObject({ decision: "REQUIRE_APPROVAL", ruleId: "refund-over-limit" });
  });

  it("denies one paisa more than the order total", () => {
    expect(refund("A-1002", 120001)).toMatchObject({ decision: "DENY", ruleId: "refund-exceeds-order-total" });
  });

  it("denies a refund on an unknown order", () => {
    expect(refund("A-9999", 50000)).toMatchObject({ decision: "DENY", ruleId: "refund-unknown-order" });
  });

  it.each([
    ["a negative amount", -500],
    ["zero", 0],
    ["a decimal", 10.5],
    ["a string", "500"],
  ])("denies %s as invalid args", (_label, amount) => {
    expect(refund("A-1001", amount)).toMatchObject({ decision: "DENY", ruleId: "invalid-args" });
  });

  it("denies when the order id is missing", () => {
    expect(decide("issue_refund", { amountInPaise: 100 })).toMatchObject({
      decision: "DENY",
      ruleId: "invalid-args",
    });
  });

  it("counts earlier refunds on the same order against its total", () => {
    ctx.refunds.push({ orderId: "A-1001", amountInPaise: 30000, issuedAt: "2026-10-18T08:00:00.000Z" });
    expect(refund("A-1001", 19901)).toMatchObject({ decision: "DENY", ruleId: "refund-exceeds-order-total" });
    expect(refund("A-1001", 19900)).toMatchObject({ decision: "ALLOW", ruleId: "refund-within-limit" });
  });

  it("allows a refund that lands exactly on the daily cap", () => {
    ctx.refunds.push({ orderId: "A-1004", amountInPaise: 160000, issuedAt: "2026-10-18T08:00:00.000Z" });
    expect(refund("A-1004", 40000)).toMatchObject({ decision: "ALLOW", ruleId: "refund-within-limit" });
  });

  it("requires approval one paisa over the daily cap", () => {
    ctx.refunds.push({ orderId: "A-1004", amountInPaise: 160000, issuedAt: "2026-10-18T08:00:00.000Z" });
    expect(refund("A-1004", 40001)).toMatchObject({ decision: "REQUIRE_APPROVAL", ruleId: "refund-daily-cap" });
  });

  it("does not count yesterday's refunds toward today's cap", () => {
    ctx.refunds.push({ orderId: "A-1004", amountInPaise: 200000, issuedAt: "2026-10-17T23:59:59.000Z" });
    expect(refund("A-1004", 50000)).toMatchObject({ decision: "ALLOW", ruleId: "refund-within-limit" });
  });
});

describe("decisions are well formed", () => {
  it("always includes a readable reason", () => {
    const d = decide("delete_record", { recordId: "A-1001" });
    expect(d.reason.length).toBeGreaterThan(10);
  });
});