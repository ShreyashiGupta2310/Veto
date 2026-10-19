import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactArgs } from "../src/audit/redact";
import { Gateway } from "../src/gateway/gateway";
import { loadPolicy } from "../src/gateway/policy-config";
import { loadStore } from "../src/tools/store";
import { tools } from "../src/tools/tools";
import type { EvalDataset } from "./dataset";

export interface GatewayStepResult {
  index: number;
  expectedStatus: string;
  expectedRuleId?: string;
  actualStatus: string;
  actualRuleId: string;
  pass: boolean;
}

export interface GatewayScenarioResult {
  id: string;
  category: string;
  applicable: boolean; // false when the scenario has no scripted gateway steps
  pass: boolean;
  steps: GatewayStepResult[];
}

export async function runGatewayLayer(dataset: EvalDataset): Promise<GatewayScenarioResult[]> {
  const results: GatewayScenarioResult[] = [];

  for (const scenario of dataset.scenarios) {
    if (scenario.gateway.length === 0) {
      results.push({ id: scenario.id, category: scenario.category, applicable: false, pass: true, steps: [] });
      continue;
    }

    const dir = mkdtempSync(join(tmpdir(), "veto-eval-"));
    const policy = loadPolicy("policy/policy.v1.json");
    const ctx = loadStore({
      fixturesDir: "fixtures",
      outboxPath: join(dir, "outbox.jsonl"),
      now: () => new Date("2026-10-19T00:00:00.000Z"),
    });
    const gateway = new Gateway({
      tools,
      policy,
      ctx,
      audit: () => {},
      redact: redactArgs,
      run: { runId: `eval-${scenario.id}`, modelId: "none (scripted)", promptVersion: "n/a" },
    });

    const steps: GatewayStepResult[] = [];
    for (const [index, step] of scenario.gateway.entries()) {
      const outcome = await gateway.handle(step.proposal, index);
      const actualRuleId = outcome.decision.ruleId;
      steps.push({
        index,
        expectedStatus: step.expect.status,
        expectedRuleId: step.expect.ruleId,
        actualStatus: outcome.status,
        actualRuleId,
        pass:
          outcome.status === step.expect.status &&
          (step.expect.ruleId === undefined || step.expect.ruleId === actualRuleId),
      });
    }
    results.push({
      id: scenario.id,
      category: scenario.category,
      applicable: true,
      pass: steps.every((s) => s.pass),
      steps,
    });
  }
  return results;
}