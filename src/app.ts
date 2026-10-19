import type { AuditEvent } from "./schemas";
import { createRunLogger, makeRunId } from "./audit/logger";
import { redactArgs } from "./audit/redact";
import { ApprovalQueue } from "./gateway/approvals";
import { Gateway } from "./gateway/gateway";
import { loadPolicy, type PolicyConfig } from "./gateway/policy-config";
import type { ModelClient } from "./model/client";
import { loadSystemPrompt } from "./agent/prompt";
import { runAgent, type AgentConfig, type AgentDeps, type RunResult } from "./agent/loop";
import { loadStore, type StoreContext } from "./tools/store";
import { tools } from "./tools/tools";

export interface SessionOptions {
  model: ModelClient;
  runsDir: string;
  outboxPath: string;
  fixturesDir?: string;
  policyPath?: string;
  promptPath?: string;
  now?: () => Date;
  onEvent?: (event: AuditEvent) => void;
}

export interface Session {
  runId: string;
  model: ModelClient;
  ctx: StoreContext;
  policy: PolicyConfig;
  gateway: Gateway;
  queue: ApprovalQueue;
  logPath: string;
  events: AuditEvent[];
  audit: (event: AuditEvent) => void;
  systemPrompt: string;
  run: { runId: string; promptVersion: string; policyVersion: string };
}

export function createSession(opts: SessionOptions): Session {
  const now = opts.now ?? (() => new Date());
  const runId = makeRunId(now());
  const ctx = loadStore({
    fixturesDir: opts.fixturesDir ?? "fixtures",
    outboxPath: opts.outboxPath,
    now,
  });
  const policy = loadPolicy(opts.policyPath ?? "policy/policy.v1.json");
  const systemPrompt = loadSystemPrompt(opts.promptPath ?? "prompts/agent.v1.txt");
  const logger = createRunLogger({ dir: opts.runsDir, runId });
  const events: AuditEvent[] = [];
  const promptVersion = "v1";

  // Disk first: if the write fails it throws, and nothing else happens.
  const audit = (event: AuditEvent): void => {
    logger.audit(event);
    events.push(event);
    opts.onEvent?.(event);
  };

  const gateway = new Gateway({
    tools,
    policy,
    ctx,
    audit,
    redact: redactArgs,
    run: { runId, modelId: opts.model.id, promptVersion },
  });
  const queue = new ApprovalQueue(gateway, now);

  return {
    runId,
    model: opts.model,
    ctx,
    policy,
    gateway,
    queue,
    logPath: logger.path,
    events,
    audit,
    systemPrompt,
    run: { runId, promptVersion, policyVersion: policy.version },
  };
}

export function runTask(
  task: string,
  session: Session,
  opts: { config?: Partial<AgentConfig>; awaitApproval?: AgentDeps["awaitApproval"] } = {},
): Promise<RunResult> {
  return runAgent(task, {
    model: session.model,
    gateway: session.gateway,
    queue: session.queue,
    audit: session.audit,
    systemPrompt: session.systemPrompt,
    run: session.run,
    config: opts.config,
    awaitApproval: opts.awaitApproval,
  });
}