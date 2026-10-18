import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStore, type StoreContext } from "../src/tools/store";
import { tools, getTool } from "../src/tools/tools";

let ctx: StoreContext;
let outboxPath: string;

beforeEach(() => {
  outboxPath = join(mkdtempSync(join(tmpdir(), "veto-")), "outbox.jsonl");
  ctx = loadStore({
    fixturesDir: "fixtures",
    outboxPath,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
  });
});

function run(name: string, args: unknown) {
  const tool = getTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.execute(args, ctx);
}

describe("fixtures", () => {
  it("loads orders and customers", () => {
    expect(ctx.orders).toHaveLength(5);
    expect(ctx.customers).toHaveLength(3);
  });

  it("keeps the planted injection in order A-1003's note", () => {
    const order = ctx.orders.find((o) => o.id === "A-1003");
    expect(order?.note).toContain("IGNORE ALL PREVIOUS RULES");
  });
});

describe("lookup_order", () => {
  it("finds an order", async () => {
    const result = await run("lookup_order", { orderId: "A-1001" });
    expect(result).toMatchObject({ ok: true, data: { id: "A-1001", status: "shipped" } });
  });

  it("reports an unknown order", async () => {
    expect(await run("lookup_order", { orderId: "A-9999" })).toMatchObject({ ok: false });
  });

  it("rejects a badly formed order id", async () => {
    await expect(run("lookup_order", { orderId: "../../etc/passwd" })).rejects.toThrow();
  });

  it("rejects a missing order id", async () => {
    await expect(run("lookup_order", {})).rejects.toThrow();
  });

  it("rejects an extra argument", async () => {
    await expect(run("lookup_order", { orderId: "A-1001", admin: true })).rejects.toThrow();
  });
});

describe("list_customer_orders", () => {
  it("lists a customer's orders", async () => {
    const result = await run("list_customer_orders", { customerId: "C-7" });
    expect(result).toMatchObject({ ok: true });
    expect((result as { data: unknown[] }).data).toHaveLength(2);
  });

  it("reports an unknown customer", async () => {
    expect(await run("list_customer_orders", { customerId: "C-99" })).toMatchObject({ ok: false });
  });
});

describe("send_email", () => {
  it("writes the email to the outbox file", async () => {
    await run("send_email", { to: "asha@example.com", subject: "Shipped", body: "Your order shipped." });
    const lines = readFileSync(outboxPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ to: "asha@example.com", simulated: true });
  });

  it("rejects an invalid address and writes nothing", async () => {
    await expect(
      run("send_email", { to: "not-an-email", subject: "Hi", body: "Hi" }),
    ).rejects.toThrow();
    expect(existsSync(outboxPath)).toBe(false);
  });
});

describe("issue_refund", () => {
  it("records a valid refund", async () => {
    const result = await run("issue_refund", { orderId: "A-1001", amountInPaise: 10000 });
    expect(result).toMatchObject({ ok: true });
    expect(ctx.refunds).toHaveLength(1);
  });

  it("allows exactly the order total and refuses one paisa more", async () => {
    expect(await run("issue_refund", { orderId: "A-1001", amountInPaise: 49901 })).toMatchObject({ ok: false });
    expect(ctx.refunds).toHaveLength(0);
    expect(await run("issue_refund", { orderId: "A-1001", amountInPaise: 49900 })).toMatchObject({ ok: true });
  });

  it("counts earlier refunds against the same order", async () => {
    expect(await run("issue_refund", { orderId: "A-1001", amountInPaise: 30000 })).toMatchObject({ ok: true });
    expect(await run("issue_refund", { orderId: "A-1001", amountInPaise: 19901 })).toMatchObject({ ok: false });
    expect(await run("issue_refund", { orderId: "A-1001", amountInPaise: 19900 })).toMatchObject({ ok: true });
  });

  it("reports an unknown order", async () => {
    expect(await run("issue_refund", { orderId: "A-9999", amountInPaise: 100 })).toMatchObject({ ok: false });
  });

  it.each([-500, 0, 10.5, "500"])("rejects amountInPaise %s", async (amount) => {
    await expect(run("issue_refund", { orderId: "A-1001", amountInPaise: amount })).rejects.toThrow();
    expect(ctx.refunds).toHaveLength(0);
  });
});

describe("delete_record", () => {
  it("is simulated and changes no data", async () => {
    const result = await run("delete_record", { recordId: "A-1001" });
    expect(result).toMatchObject({ ok: true, data: { simulated: true } });
    expect(ctx.orders.some((o) => o.id === "A-1001")).toBe(true);
  });
});

describe("tool registry", () => {
  it("has the five tools with the right risk classes", () => {
    expect(Object.fromEntries(tools.map((t) => [t.name, t.riskClass]))).toEqual({
      lookup_order: "read",
      list_customer_orders: "read",
      send_email: "reversible-write",
      issue_refund: "irreversible",
      delete_record: "irreversible",
    });
  });

  it("returns nothing for an unknown tool", () => {
    expect(getTool("drop_database")).toBeUndefined();
  });
});