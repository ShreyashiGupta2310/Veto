import type { GatewayDecision } from "../schemas";
import type { Gateway, GatewayOutcome, PendingAction } from "./gateway";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "blocked";

export interface ApprovalRequest {
  id: string;
  step: number;
  action: PendingAction;
  ruleId: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  outcome?: GatewayOutcome;
}

export class ApprovalQueue {
  private readonly gateway: Gateway;
  private readonly now: () => Date;
  private readonly items = new Map<string, ApprovalRequest>();
  private counter = 0;

  constructor(gateway: Gateway, now: () => Date = () => new Date()) {
    this.gateway = gateway;
    this.now = now;
  }

  // Put an action in the waiting room and write it in the logbook.
  submit(action: PendingAction, decision: GatewayDecision, step: number): ApprovalRequest {
    this.gateway.recordApprovalRequested(action, decision, step);
    this.counter += 1;
    const request: ApprovalRequest = {
      id: `appr-${this.counter}`,
      step,
      action: { toolName: action.toolName, args: { ...action.args } },
      ruleId: decision.ruleId,
      reason: decision.reason,
      status: "pending",
      createdAt: this.now().toISOString(),
    };
    this.items.set(request.id, request);
    return request;
  }

  list(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.items.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.items.get(id);
  }

  async approve(id: string): Promise<ApprovalRequest> {
    const request = this.mustBePending(id);
    // Marked first, so a second click cannot run the action twice.
    request.status = "approved";
    let outcome: GatewayOutcome;
    try {
      outcome = await this.gateway.executeApproved(request.action, request.step);
    } catch (err) {
      request.status = "pending";
      throw err;
    }
    request.outcome = outcome;
    request.resolvedAt = this.now().toISOString();
    if (outcome.status === "denied") request.status = "blocked";
    return request;
  }

  reject(id: string): ApprovalRequest {
    const request = this.mustBePending(id);
    this.gateway.recordRejected(request.action, request.step);
    request.status = "rejected";
    request.resolvedAt = this.now().toISOString();
    return request;
  }

  private mustBePending(id: string): ApprovalRequest {
    const request = this.items.get(id);
    if (!request) throw new Error(`No approval request with id ${id}.`);
    if (request.status !== "pending") {
      throw new Error(`Approval request ${id} is already ${request.status}.`);
    }
    return request;
  }
}