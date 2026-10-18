import type { GatewayDecision } from "../schemas";
import type { PolicyConfig } from "./policy-config";
import type { StoreContext, RefundRecord } from "../tools/store";
import type { ToolDefinition } from "../tools/types";

export interface PolicyRequest {
  tool: ToolDefinition;
  args: unknown;
}

// One small helper so every rule below reads as one line.
function decision(
  kind: GatewayDecision["decision"],
  ruleId: string,
  reason: string,
): GatewayDecision {
  return { decision: kind, ruleId, reason };
}

// The model's args are untrusted, so I only treat them as a plain object if they really are one.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sumPaise(refunds: RefundRecord[]): number {
  return refunds.reduce((total, r) => total + r.amountInPaise, 0);
}

export function evaluatePolicy(
  req: PolicyRequest,
  policy: PolicyConfig,
  ctx: StoreContext,
): GatewayDecision {
  const name = req.tool.name;
  const toolPolicy = policy.tools[name];

  // Rule 1: a tool that is not in the rulebook is blocked.
  if (!toolPolicy) {
    return decision("DENY", "default-deny", `The tool ${name} is not in the policy, so it is blocked.`);
  }

  // Rule 2: the rulebook can block a tool completely.
  if (toolPolicy.mode === "deny") {
    return decision("DENY", "tool-denied", `The policy does not allow ${name}.`);
  }

  const args = asRecord(req.args);

  // Rule 3: emails may only go to allowed domains.
  if (name === "send_email") {
    const to = args?.["to"];
    if (typeof to !== "string" || !to.includes("@")) {
      return decision("DENY", "invalid-args", "send_email needs a recipient address in `to`.");
    }
    // Text after the LAST @, lowercased, compared exactly (never "contains" or "ends with").
    const domain = to.slice(to.lastIndexOf("@") + 1).toLowerCase();
    const allowed = (toolPolicy.allowedEmailDomains ?? []).map((d) => d.toLowerCase());
    if (!allowed.includes(domain)) {
      return decision("DENY", "email-domain-not-allowed", `Emails to the domain "${domain}" are not allowed.`);
    }
    return decision("ALLOW", "email-domain-allowed", `The domain "${domain}" is on the allowed list.`);
  }

  // Rule 4: refunds are checked against the order and the money limits.
  if (name === "issue_refund" && toolPolicy.refund) {
    const { autoApproveLimitPaise, dailyCapPaise } = toolPolicy.refund;
    const orderId = args?.["orderId"];
    const amount = args?.["amountInPaise"];

    if (
      typeof orderId !== "string" ||
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      return decision("DENY", "invalid-args", "A refund needs an orderId and a positive whole-number amountInPaise.");
    }

    const order = ctx.orders.find((o) => o.id === orderId);
    if (!order) {
      return decision("DENY", "refund-unknown-order", `Order ${orderId} does not exist.`);
    }

    const alreadyRefunded = sumPaise(ctx.refunds.filter((r) => r.orderId === orderId));
    const refundable = order.totalPaise - alreadyRefunded;
    if (amount > refundable) {
      return decision(
        "DENY",
        "refund-exceeds-order-total",
        `The refund of ${amount} paise is more than the ${refundable} paise still refundable on ${orderId}.`,
      );
    }

    if (amount > autoApproveLimitPaise) {
      return decision(
        "REQUIRE_APPROVAL",
        "refund-over-limit",
        `The refund of ${amount} paise is above the automatic limit of ${autoApproveLimitPaise} paise.`,
      );
    }

    // "Today" is the UTC date of the clock, compared as the first 10 characters of an ISO string.
    const today = ctx.now().toISOString().slice(0, 10);
    const refundedToday = sumPaise(ctx.refunds.filter((r) => r.issuedAt.slice(0, 10) === today));
    if (refundedToday + amount > dailyCapPaise) {
      return decision(
        "REQUIRE_APPROVAL",
        "refund-daily-cap",
        `This refund would take today's total to ${refundedToday + amount} paise, above the daily cap of ${dailyCapPaise} paise.`,
      );
    }

    return decision("ALLOW", "refund-within-limit", `The refund of ${amount} paise is within the automatic limits.`);
  }

  // Rule 5: an irreversible tool that nothing above decided needs a human.
  if (req.tool.riskClass === "irreversible") {
    return decision(
      "REQUIRE_APPROVAL",
      "irreversible-requires-approval",
      `${name} cannot be undone, so a human has to approve it.`,
    );
  }

  // Rule 6: everything else the policy allows.
  return decision("ALLOW", "tool-allowed", `The policy allows ${name}.`);
}