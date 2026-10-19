import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadPolicy } from "../src/gateway/policy-config";
import { createOllamaClient } from "../src/model/ollama";
import { loadDataset } from "./dataset";
import { runE2eScenario, type E2eScenarioResult } from "./e2e-layer";
import { runGatewayLayer } from "./gateway-layer";
import { buildReport, type E2eFile, type GatewayFile } from "./report";

const REPORTS = "eval/reports";
const args = process.argv.slice(2);
const mode = args[0] ?? "gateway";

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const writeJson = (path: string, data: unknown): void =>
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

async function main(): Promise<void> {
  mkdirSync(REPORTS, { recursive: true });
  const dataset = loadDataset();
  const policy = loadPolicy("policy/policy.v1.json");

  if (mode === "gateway") {
    const results = await runGatewayLayer(dataset);
    const file: GatewayFile = {
      datasetVersion: dataset.version,
      policyVersion: policy.version,
      date: new Date().toISOString(),
      results,
    };
    writeJson(`${REPORTS}/gateway-results.json`, file);
    for (const r of results) {
      console.log(`${r.applicable ? (r.pass ? "PASS" : "FAIL") : "N/A "}  ${r.id}`);
    }
    const failed = results.filter((r) => r.applicable && !r.pass);
    console.log(`\n${results.filter((r) => r.applicable).length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  if (mode === "e2e") {
    const repeats = Number(flag("--repeats") ?? "5");
    if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a whole number of 1 or more");
    const model = createOllamaClient({ model: process.env["VETO_MODEL"] ?? "gemma3:4b" });
    const file: E2eFile = {
      datasetVersion: dataset.version,
      policyVersion: policy.version,
      modelId: model.id,
      modelSettings: model.settings,
      repeats,
      date: new Date().toISOString(),
      results: [],
    };
    for (const scenario of dataset.scenarios) {
      if (!scenario.e2e) continue;
      console.log(`Running ${scenario.id} x${repeats} ...`);
      const result: E2eScenarioResult = await runE2eScenario(scenario, scenario.e2e, model, repeats, "runs");
      file.results.push(result);
      writeJson(`${REPORTS}/e2e-results.json`, file); // saved after every scenario
      console.log(`  ${result.state.toUpperCase()}  ${result.passCount}/${result.total}  ${JSON.stringify(result.statusCounts)}`);
    }
    return;
  }

  if (mode === "report") {
    const gPath = `${REPORTS}/gateway-results.json`;
    if (!existsSync(gPath)) throw new Error("Run `npm run eval:gateway` first.");
    const gateway = JSON.parse(readFileSync(gPath, "utf8")) as GatewayFile;
    const ePath = `${REPORTS}/e2e-results.json`;
    const e2e = existsSync(ePath) ? (JSON.parse(readFileSync(ePath, "utf8")) as E2eFile) : undefined;
    writeFileSync(`${REPORTS}/report.md`, buildReport(gateway, e2e));
    console.log(`Wrote ${REPORTS}/report.md`);
    return;
  }

  throw new Error(`Unknown mode "${mode}". Use: gateway, e2e or report.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});