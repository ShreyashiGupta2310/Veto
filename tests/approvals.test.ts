import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "../src/schemas";
import { loadStore, type StoreContext } from "../src/tools/store";
import { tools } from "../src/tools/tools";
import { loadPolicy } from "../src/gateway/policy-config";
import { Gateway } from "../src/gateway/gateway";
import { ApprovalQueue } from "../src/gateway/approvals";

let ctx: StoreContext;
let events: AuditEvent[];
let gateway: Gateway;
let queue: ApprovalQueue;

beforeEach(() => {
  ctx = loadStore({
    fixturesDir: "fixtures",
    outboxPath: join(mkdtempSync(join(tmpdir(), "veto-ap-")), "outbox.jsonl"),
    now: () => new Date("2026-10-18T10:00:00.000Z"),
  });
  events = [];
  gateway = new Gateway({
    tools,
    policy: loadPolicy("policy/policy.v1.json"),
    ctx,
    audit: (event) => events.push(event),
    redact: (args) => ({ ...args }),
    run: { runId: "run-test", modelId: "test-model", promptVersion: "v1" },
  });
  queue = new ApprovalQueue(gateway, ctx.now);
});

const eventTypes = () => events.map((e) => e.eventType);

async function requestRefund(orderId: string, amountInPaise: number) {
  const outcome = await gateway.handle(
    { type: "tool_call", toolName: "issue_refund", args: { orderId, amountInPaise }, reason: "test" },
    0,
  );
  if (outcome.status !== "needs_approval") throw new Error("expected needs_approval");
  return queue.submit(outcome.pending, outcome.decision, 0);
}

describe("waiting for a human", () => {
  it("keeps the action pending and does not run it", async () => {
    const request = await requestRefund("A-1002", 120000);
    expect(request).toMatchObject({ id: "appr-1", status: "pending", ruleId: "refund-over-limit" });
    expect(ctx.refunds).toHaveLength(0);
    expect(eventTypes()).toEqual(["gateway_decision", "approval_requested"]);
  });

  it("lists requests by status", async () => {
    await requestRefund("A-1002", 120000);
    await requestRefund("A-1004", 100000);
    expect(queue.list()).toHaveLength(2);
    expect(queue.list("pending")).toHaveLength(2);
    expect(queue.list("approved")).toHaveLength(0);
  });
});

describe("approve", () => {
  it("runs the action once and logs the whole story", async () => {
    const request = await requestRefund("A-1002", 120000);
    const done = await queue.approve(request.id);
    expect(done.status).toBe("approved");
    expect(done.outcome).toMatchObject({ status: "executed", result: { ok: true } });
    expect(ctx.refunds).toHaveLength(1);
    expect(eventTypes()).toEqual([
      "gateway_decision",
      "approval_requested",
      "approval_resolved",
      "tool_executed",
    ]);
    expect(events[2]).toMatchObject({ decision: "ALLOW", ruleId: "human-approved" });
  });

  it("cannot be approved twice", async () => {
    const request = await requestRefund("A-1002", 120000);
    await queue.approve(request.id);
    await expect(queue.approve(request.id)).rejects.toThrow("already approved");
    expect(ctx.refunds).toHaveLength(1);
  });

  it("cannot overrule a hard DENY that appeared while waiting", async () => {
    const request = await requestRefund("A-1002", 100000);
    // While it waits, another refund of 50000 goes through, leaving only 70000 refundable.
    await gateway.handle(
      { type: "tool_call", toolName: "issue_refund", args: { orderId: "A-1002", amountInPaise: 50000 }, reason: "test" },
      1,
    );
    const done = await queue.approve(request.id);
    expect(done.status).toBe("blocked");
    expect(done.outcome).toMatchObject({ status: "denied", decision: { ruleId: "refund-exceeds-order-total" } });
    expect(ctx.refunds).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ decision: "DENY", ruleId: "refund-exceeds-order-total" });
  });
});

describe("reject", () => {
  it("drops the action and logs the rejection", async () => {
    const request = await requestRefund("A-1002", 120000);
    const done = queue.reject(request.id);
    expect(done.status).toBe("rejected");
    expect(ctx.refunds).toHaveLength(0);
    expect(eventTypes()).toEqual(["gateway_decision", "approval_requested", "approval_resolved"]);
    expect(events[2]).toMatchObject({ decision: "DENY", ruleId: "human-rejected" });
  });

  it("cannot be rejected after it was approved", async () => {
    const request = await requestRefund("A-1002", 120000);
    await queue.approve(request.id);
    expect(() => queue.reject(request.id)).toThrow("already approved");
  });
});

describe("unknown tickets", () => {
  it("throws for an id that does not exist", async () => {
    await expect(queue.approve("appr-99")).rejects.toThrow("No approval request");
    expect(() => queue.reject("appr-99")).toThrow("No approval request");
  });
});