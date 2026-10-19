import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/client";
import { createSession, runTask, type Session } from "../src/app";
import type { AgentConfig } from "../src/agent/loop";
import type { ApprovalRequest } from "../src/gateway/approvals";

export type ScriptedModel = ModelClient & { calls: ModelRequest[] };

export function scriptedModel(script: (string | Error)[], delayMs = 0): ScriptedModel {
  const calls: ModelRequest[] = [];
  let index = 0;
  return {
    id: "scripted-model",
    settings: { scripted: true },
    calls,
    async chat(req: ModelRequest): Promise<ModelResponse> {
      calls.push(req);
      const next = script[index];
      index += 1;
      if (next === undefined) throw new Error("scripted model ran out of answers");
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (next instanceof Error) throw next;
      return { content: next, latencyMs: delayMs };
    },
  };
}

export const toolCall = (toolName: string, args: unknown): string =>
  JSON.stringify({ type: "tool_call", toolName, args, reason: "test" });

export const finalAnswer = (message: string): string => JSON.stringify({ type: "final", message });

export async function go(
  model: ScriptedModel,
  task: string,
  opts: {
    config?: Partial<AgentConfig>;
    awaitApproval?: (request: ApprovalRequest) => Promise<"approve" | "reject">;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "veto-loop-"));
  const session: Session = createSession({ model, runsDir: dir, outboxPath: join(dir, "outbox.jsonl") });
  const result = await runTask(task, session, opts);
  return { session, result };
}