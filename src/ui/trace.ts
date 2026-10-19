import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTrace } from "../audit/logger";

function latestRun(dir = "runs"): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const newest = files[0];
  return newest ? join(dir, newest.f) : undefined;
}

const arg = process.argv[2];
const path = !arg || arg === "latest" ? latestRun() : arg;
if (!path) {
  console.error("No runs found in runs/. Run the demo first.");
  process.exit(1);
}

const events = readTrace(path);
const first = events[0];
if (!first) {
  console.error("That log is empty.");
  process.exit(1);
}
console.log(`Run ${first.runId}`);
console.log(`Model ${first.modelId} | prompt ${first.promptVersion} | policy ${first.policyVersion}\n`);

for (const e of events) {
  const parts = [`step ${e.step}`, e.eventType];
  if (e.toolName) parts.push(e.toolName);
  if (e.decision) parts.push(e.decision);
  if (e.ruleId) parts.push(`rule=${e.ruleId}`);
  if (e.latencyMs !== undefined) parts.push(`${e.latencyMs} ms`);
  if (e.outputTokens !== undefined) parts.push(`${e.outputTokens} output tokens`);
  if (e.status) parts.push(`status=${e.status}`);
  if (e.error) parts.push(`error=${e.error}`);
  console.log(parts.join(" | "));
}

const problem = events.find(
  (e) => e.error !== undefined || e.decision === "DENY" || e.eventType === "proposal_invalid",
);
const finished = events.find((e) => e.eventType === "run_finished");
console.log("");
console.log(`Result: ${finished ? `${finished.status} (${finished.detail ?? ""})` : "run did not finish"}`);
console.log(
  problem
    ? `First problem: step ${problem.step}, ${problem.eventType}${problem.ruleId ? `, rule ${problem.ruleId}` : ""}${problem.error ? `, ${problem.error}` : ""}`
    : "No problems found in this run.",
);