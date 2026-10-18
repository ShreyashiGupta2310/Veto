import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const OrderItem = z.strictObject({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPricePaise: z.number().int().positive(),
});

export const Order = z.strictObject({
  id: z.string().regex(/^A-\d{4}$/),
  customerId: z.string().regex(/^C-\d+$/),
  status: z.enum(["processing", "shipped", "delivered"]),
  items: z.array(OrderItem).min(1),
  totalPaise: z.number().int().positive(),
  note: z.string().optional(),
});
export type Order = z.infer<typeof Order>;

export const Customer = z.strictObject({
  id: z.string().regex(/^C-\d+$/),
  name: z.string().min(1),
  email: z.email(),
});
export type Customer = z.infer<typeof Customer>;

export interface RefundRecord {
  orderId: string;
  amountInPaise: number;
  issuedAt: string;
}

// The pretend shop's current state. Passed into every tool, never global.
export interface StoreContext {
  orders: Order[];
  customers: Customer[];
  refunds: RefundRecord[];
  outboxPath: string;
  now: () => Date;
}

export function loadStore(opts: {
  fixturesDir: string;
  outboxPath: string;
  now?: () => Date;
}): StoreContext {
  const readJson = (file: string): unknown =>
    JSON.parse(readFileSync(join(opts.fixturesDir, file), "utf8"));

  const orders = z.array(Order).parse(readJson("orders.json"));
  const customers = z.array(Customer).parse(readJson("customers.json"));

  for (const order of orders) {
    const sum = order.items.reduce((s, i) => s + i.quantity * i.unitPricePaise, 0);
    if (sum !== order.totalPaise) {
      throw new Error(`order ${order.id}: items add up to ${sum} but total is ${order.totalPaise}`);
    }
    if (!customers.some((c) => c.id === order.customerId)) {
      throw new Error(`order ${order.id}: unknown customer ${order.customerId}`);
    }
  }

  return {
    orders,
    customers,
    refunds: [],
    outboxPath: opts.outboxPath,
    now: opts.now ?? (() => new Date()),
  };
}