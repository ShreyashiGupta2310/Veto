import { AuditEvent, type ActionProposal, type RunStatus } from "../schemas";
import type { ApprovalQueue, ApprovalRequest } from "../gateway/approvals";
import type { Gateway } from "../gateway/gateway";
import { ModelError, type ChatMessage, type ModelClient, type ModelResponse } from "../model/client";
import { PROPOSAL_FORMAT, parseProposal } from "./parse";
import { wrapDenial, wrapRejected, wrapToolResult } from "./prompt";

export interface AgentConfig {
  maxSteps: number;
  maxWallClockMs: number;
  maxRepeats: number; // how many times the exact same proposal may appear
  maxDenials: number; // how many blocked actions before the run stops
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 8,
  maxWallClockMs: 300_000,
  maxRepeats: 2,
  maxDenials: 2,
};

export interface AgentDeps {
  model: ModelClient;
  gateway: Gateway;
  queue: ApprovalQueue;
  audit: (event: AuditEvent) => void;
  systemPrompt: string;
  run: { runId: string; promptVersion: string; policyVersion: string };
  config?: Partial<AgentConfig>;
  now?: () => Date;
  // If given, the run waits for a human answer. If not, it ends as awaiting_approval.
  awaitApproval?: (request: ApprovalRequest) => Promise<"approve" | "reject">;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  detail: string;
  finalMessage?: string;
  steps: number;
  approvals: ApprovalRequest[];
}

type EventFields = Partial<
  Pick<
    AuditEvent,
    "toolName" | "decision" | "ruleId" | "latencyMs" | "error" | "status" | "detail" | "promptTokens" | "outputTokens"
  >
>;

type Got =
  | { kind: "ok"; proposal: ActionProposal }
  | { kind: "failed"; status: RunStatus; detail: string };

// Same proposal, whatever order the keys came in.
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export async function runAgent(task: string, deps: AgentDeps): Promise<RunResult> {
  const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const { model, gateway, queue } = deps;
  const startedAt = Date.now();

  const messages: ChatMessage[] = [
    { role: "system", content: deps.systemPrompt },
    { role: "user", content: task },
  ];
  const approvals: ApprovalRequest[] = [];
  const seen = new Map<string, number>();
  let denials = 0;
  let stepsTaken = 0;

  const emit = (eventType: AuditEvent["eventType"], step: number, fields: EventFields = {}): void => {
    deps.audit(
      AuditEvent.parse({
        runId: deps.run.runId,
        step,
        timestamp: now().toISOString(),
        eventType,
        modelId: model.id,
        promptVersion: deps.run.promptVersion,
        policyVersion: deps.run.policyVersion,
        ...fields,
      }),
    );
  };

  const finish = (status: RunStatus, detail: string, step: number, finalMessage?: string): RunResult => {
    emit("run_finished", step, {
      status,
      detail,
      error: status.startsWith("failed_") ? detail : undefined,
    });
    return { runId: deps.run.runId, status, detail, finalMessage, steps: stepsTaken, approvals };
  };

  // Ask the model. One retry with the error fed back, then a clear failure.
  const getProposal = async (step: number): Promise<Got> => {
    let lastError = "The model gave no usable answer.";
    let repair: ChatMessage[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: ModelResponse;
      try {
        response = await model.chat({ messages: [...messages, ...repair], format: PROPOSAL_FORMAT });
      } catch (err) {
        const code = err instanceof ModelError ? err.code : "unknown_model_error";
        const message = err instanceof Error ? err.message : String(err);
        emit("model_error", step, { error: `${code}: ${message}` });
        return { kind: "failed", status: "failed_model_error", detail: `${code}: ${message}` };
      }
      emit("model_response", step, {
        latencyMs: response.latencyMs,
        promptTokens: response.promptTokens,
        outputTokens: response.outputTokens,
      });
      const parsed = parseProposal(response.content);
      if (parsed.ok) return { kind: "ok", proposal: parsed.proposal };
      emit("proposal_invalid", step, { error: parsed.error });
      lastError = parsed.error;
      repair = [
        { role: "assistant", content: response.content.slice(0, 300) },
        {
          role: "user",
          content: `Your last reply was not valid: ${parsed.error} Reply with exactly one JSON object in the required format.`,
        },
      ];
    }
    return { kind: "failed", status: "failed_invalid_output", detail: lastError };
  };

  emit("run_started", 0, {
    detail: `settings=${JSON.stringify(model.settings)}; limits=${JSON.stringify(config)}`,
  });

  for (let step = 0; step < config.maxSteps; step++) {
    stepsTaken = step;
    if (Date.now() - startedAt > config.maxWallClockMs) {
      return finish("step_limit", "time_budget_exceeded", step);
    }

    const got = await getProposal(step);
    if (got.kind === "failed") return finish(got.status, got.detail, step);
    const proposal = got.proposal;

    if (proposal.type === "final") {
      return finish("completed", "final answer given", step, proposal.message);
    }

    // Loop detector: the same proposal too many times ends the run.
    const key = stableKey([proposal.toolName, proposal.args]);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > config.maxRepeats) {
      return finish("step_limit", `repeated_proposal: ${proposal.toolName}`, step);
    }

    const outcome = await gateway.handle(proposal, step);
    messages.push({ role: "assistant", content: JSON.stringify(proposal) });

    if (outcome.status === "executed") {
      messages.push({ role: "user", content: wrapToolResult(proposal.toolName, outcome.result) });
      continue;
    }

    if (outcome.status === "denied") {
      denials += 1;
      messages.push({ role: "user", content: wrapDenial(outcome.decision) });
      if (denials >= config.maxDenials) {
        return finish("denied_and_stopped", `${denials} actions denied; last rule: ${outcome.decision.ruleId}`, step);
      }
      continue;
    }

    // The gateway wants a human.
    const request = queue.submit(outcome.pending, outcome.decision, step);
    approvals.push(request);
    if (!deps.awaitApproval) {
      return finish("awaiting_approval", `waiting for ${request.id} (${request.ruleId})`, step);
    }
    const answer = await deps.awaitApproval(request);
    if (answer === "reject") {
      queue.reject(request.id);
      messages.push({ role: "user", content: wrapRejected() });
      continue;
    }
    const done = await queue.approve(request.id);
    const result = done.outcome;
    if (result && result.status === "executed") {
      messages.push({ role: "user", content: wrapToolResult(proposal.toolName, result.result) });
    } else if (result && result.status === "denied") {
      messages.push({ role: "user", content: wrapDenial(result.decision) });
    }
  }

  stepsTaken = config.maxSteps;
  return finish("step_limit", "max_steps_reached", config.maxSteps);
}