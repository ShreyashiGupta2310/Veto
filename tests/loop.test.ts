import { describe, it, expect } from "vitest";
import { ModelError } from "../src/model/client";
import { finalAnswer, go, scriptedModel, toolCall } from "./helpers";

const types = (events: { eventType: string }[]) => events.map((e) => e.eventType);

describe("normal endings", () => {
  it("completes when the model gives a final answer", async () => {
    const { session, result } = await go(scriptedModel([finalAnswer("done")]), "hi");
    expect(result).toMatchObject({ status: "completed", finalMessage: "done" });
    expect(types(session.events)).toEqual(["run_started", "model_response", "run_finished"]);
  });

  it("runs a tool, feeds the result back and completes", async () => {
    const model = scriptedModel([toolCall("lookup_order", { orderId: "A-1001" }), finalAnswer("shipped")]);
    const { session, result } = await go(model, "status of A-1001?");
    expect(result.status).toBe("completed");
    expect(types(session.events)).toContain("tool_executed");
  });

  it("wraps tool output as untrusted data before the model sees it", async () => {
    const model = scriptedModel([toolCall("lookup_order", { orderId: "A-1003" }), finalAnswer("ok")]);
    await go(model, "summarise A-1003");
    const seenByModel = model.calls[1]?.messages.at(-1)?.content ?? "";
    expect(seenByModel).toContain('trust="untrusted"');
    expect(seenByModel).toContain("IGNORE ALL PREVIOUS RULES"); // the planted text is there, but labelled as data
  });
});

describe("loop controls", () => {
  it("stops at the step cap", async () => {
    const model = scriptedModel([
      toolCall("lookup_order", { orderId: "A-1001" }),
      toolCall("lookup_order", { orderId: "A-1002" }),
      toolCall("lookup_order", { orderId: "A-1003" }),
    ]);
    const { result } = await go(model, "look at everything", { config: { maxSteps: 3 } });
    expect(result).toMatchObject({ status: "step_limit", detail: "max_steps_reached" });
    expect(model.calls).toHaveLength(3);
  });

  it("stops when the same proposal repeats too often, and does not run the third", async () => {
    const same = toolCall("lookup_order", { orderId: "A-1001" });
    const { session, result } = await go(scriptedModel([same, same, same]), "keep going");
    expect(result.status).toBe("step_limit");
    expect(result.detail).toContain("repeated_proposal");
    expect(session.events.filter((e) => e.eventType === "tool_executed")).toHaveLength(2);
  });

  it("stops when the time budget is used up", async () => {
    const model = scriptedModel(
      [toolCall("lookup_order", { orderId: "A-1001" }), toolCall("lookup_order", { orderId: "A-1002" })],
      30,
    );
    const { result } = await go(model, "slow", { config: { maxWallClockMs: 10 } });
    expect(result).toMatchObject({ status: "step_limit", detail: "time_budget_exceeded" });
    expect(model.calls).toHaveLength(1);
  });

  it("stops after two blocked actions", async () => {
    const model = scriptedModel([toolCall("delete_record", { recordId: "A-1001" }), toolCall("drop_database", {})]);
    const { result } = await go(model, "delete things");
    expect(result.status).toBe("denied_and_stopped");
    expect(result.detail).toContain("unknown-tool");
  });
});

describe("bad model output", () => {
  it("retries once with the error fed back, then continues", async () => {
    const model = scriptedModel(["not json at all", finalAnswer("ok")]);
    const { session, result } = await go(model, "hi");
    expect(result.status).toBe("completed");
    expect(model.calls).toHaveLength(2);
    expect(types(session.events)).toContain("proposal_invalid");
    expect(model.calls[1]?.messages.at(-1)?.content).toContain("not valid");
  });

  it("ends as failed_invalid_output after two bad answers and says why", async () => {
    const { session, result } = await go(scriptedModel(["nope", "still nope"]), "hi");
    expect(result.status).toBe("failed_invalid_output");
    expect(result.detail).toContain("JSON");
    const last = session.events.at(-1);
    expect(last).toMatchObject({ eventType: "run_finished", status: "failed_invalid_output" });
    expect(last?.error).toBeDefined();
  });

  it("ends as failed_model_error with the error code when the model call fails", async () => {
    const { session, result } = await go(scriptedModel([new ModelError("timeout", "slow")]), "hi");
    expect(result).toMatchObject({ status: "failed_model_error", detail: "timeout: slow" });
    expect(session.events.find((e) => e.eventType === "model_error")?.error).toBe("timeout: slow");
  });
});

describe("approvals inside a run", () => {
  const bigRefund = toolCall("issue_refund", { orderId: "A-1002", amountInPaise: 120000 });

  it("pauses as awaiting_approval and runs nothing when nobody can answer", async () => {
    const { session, result } = await go(scriptedModel([bigRefund]), "refund A-1002");
    expect(result.status).toBe("awaiting_approval");
    expect(result.approvals).toHaveLength(1);
    expect(session.ctx.refunds).toHaveLength(0);
    expect(types(session.events)).toContain("approval_requested");
  });

  it("runs the refund after a human approves, then continues", async () => {
    const model = scriptedModel([bigRefund, finalAnswer("refunded")]);
    const { session, result } = await go(model, "refund A-1002", { awaitApproval: async () => "approve" });
    expect(result.status).toBe("completed");
    expect(session.ctx.refunds).toHaveLength(1);
    expect(types(session.events)).toContain("tool_executed");
  });

  it("does not run the refund after a human rejects", async () => {
    const model = scriptedModel([bigRefund, finalAnswer("not refunded")]);
    const { session, result } = await go(model, "refund A-1002", { awaitApproval: async () => "reject" });
    expect(result.status).toBe("completed");
    expect(session.ctx.refunds).toHaveLength(0);
    expect(result.approvals[0]?.status).toBe("rejected");
  });
});