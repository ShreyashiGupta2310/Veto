import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./types";

const orderIdSchema = z.string().regex(/^A-\d{4}$/, "orderId must look like A-1001");
const customerIdSchema = z.string().regex(/^C-\d+$/, "customerId must look like C-7");

export const lookupOrder = defineTool({
  name: "lookup_order",
  description: "Look up one order by its id.",
  argsSchema: z.strictObject({ orderId: orderIdSchema }),
  riskClass: "read",
  run: async ({ orderId }, ctx) => {
    const order = ctx.orders.find((o) => o.id === orderId);
    return order
      ? { ok: true, data: order }
      : { ok: false, error: `order ${orderId} not found` };
  },
});

export const listCustomerOrders = defineTool({
  name: "list_customer_orders",
  description: "List a customer's orders (id, status and total).",
  argsSchema: z.strictObject({ customerId: customerIdSchema }),
  riskClass: "read",
  run: async ({ customerId }, ctx) => {
    if (!ctx.customers.some((c) => c.id === customerId)) {
      return { ok: false, error: `customer ${customerId} not found` };
    }
    const orders = ctx.orders
      .filter((o) => o.customerId === customerId)
      .map((o) => ({ id: o.id, status: o.status, totalPaise: o.totalPaise }));
    return { ok: true, data: orders };
  },
});

export const sendEmail = defineTool({
  name: "send_email",
  description: "Send an email (simulated: it is written to the outbox file).",
  argsSchema: z.strictObject({
    to: z.email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(5000),
  }),
  riskClass: "reversible-write",
  run: async ({ to, subject, body }, ctx) => {
    mkdirSync(dirname(ctx.outboxPath), { recursive: true });
    const entry = { sentAt: ctx.now().toISOString(), to, subject, body, simulated: true };
    appendFileSync(ctx.outboxPath, JSON.stringify(entry) + "\n");
    return { ok: true, data: { queued: true, to } };
  },
});

export const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an amount in paise (whole number) on an order (simulated).",
  argsSchema: z.strictObject({
    orderId: orderIdSchema,
    amountInPaise: z.number().int().positive(),
  }),
  riskClass: "irreversible",
  run: async ({ orderId, amountInPaise }, ctx) => {
    const order = ctx.orders.find((o) => o.id === orderId);
    if (!order) return { ok: false, error: `order ${orderId} not found` };

    const alreadyRefunded = ctx.refunds
      .filter((r) => r.orderId === orderId)
      .reduce((sum, r) => sum + r.amountInPaise, 0);
    const refundable = order.totalPaise - alreadyRefunded;
    if (amountInPaise > refundable) {
      return { ok: false, error: `amount is more than the refundable balance (${refundable} paise)` };
    }

    ctx.refunds.push({ orderId, amountInPaise, issuedAt: ctx.now().toISOString() });
    return { ok: true, data: { orderId, refundedPaise: amountInPaise, simulated: true } };
  },
});

export const deleteRecord = defineTool({
  name: "delete_record",
  description: "Delete a record (simulated; it never changes any data).",
  argsSchema: z.strictObject({ recordId: z.string().min(1) }),
  riskClass: "irreversible",
  run: async ({ recordId }) => ({ ok: true, data: { deleted: recordId, simulated: true } }),
});

export const tools: ToolDefinition[] = [
  lookupOrder,
  listCustomerOrders,
  sendEmail,
  issueRefund,
  deleteRecord,
];

const byName = new Map(tools.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}