import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createSession, runTask } from "./app";
import type { ApprovalRequest } from "./gateway/approvals";
import { createOllamaClient } from "./model/ollama";
import type { AuditEvent } from "./schemas";

const SHOWN = new Set([
  "proposal_invalid",
  "model_error",
  "gateway_decision",
  "approval_requested",
  "approval_resolved",
  "tool_executed",
  "tool_failed",
]);

function show(event: AuditEvent): void {
  if (!SHOWN.has(event.eventType)) return;
  const parts = [`step ${event.step}`, event.eventType];
  if (event.toolName) parts.push(event.toolName);
  if (event.decision) parts.push(event.decision);
  if (event.ruleId) parts.push(`rule=${event.ruleId}`);
  if (event.error) parts.push(`error=${event.error}`);
  console.log("  " + parts.join(" | "));
}

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: npm run demo -- "your task here"');
    process.exit(1);
  }

  const model = createOllamaClient({ model: process.env["VETO_MODEL"] ?? "gemma3:4b" });
  const rl = createInterface({ input: stdin, output: stdout });
  const session = createSession({
    model,
    runsDir: "runs",
    outboxPath: "data/outbox.jsonl",
    onEvent: show,
  });

  const awaitApproval = async (request: ApprovalRequest): Promise<"approve" | "reject"> => {
    console.log(`\nAPPROVAL NEEDED (${request.id})`);
    console.log(`  action: ${request.action.toolName} ${JSON.stringify(request.action.args)}`);
    console.log(`  rule:   ${request.ruleId}`);
    console.log(`  why:    ${request.reason}`);
    const answer = (await rl.question("Approve? (y/n) ")).trim().toLowerCase();
    return answer === "y" ? "approve" : "reject";
  };

  console.log(`Model: ${model.id}\nTask: ${task}\n`);
  try {
    const result = await runTask(task, session, { awaitApproval });
    console.log(`\nStatus: ${result.status} (${result.detail})`);
    if (result.finalMessage) console.log(`Answer: ${result.finalMessage}`);
    console.log(`Log: ${session.logPath}`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});