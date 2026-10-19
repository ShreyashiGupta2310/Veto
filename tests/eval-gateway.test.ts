import { describe, it, expect } from "vitest";
import { loadDataset } from "../eval/dataset";
import { runGatewayLayer } from "../eval/gateway-layer";

describe("eval dataset", () => {
  const dataset = loadDataset();

  it("has a version and covers every required category", () => {
    expect(dataset.version).toBe("v1");
    const categories = new Set(dataset.scenarios.map((s) => s.category));
    for (const required of [
      "normal_success",
      "normal_approval",
      "prompt_injection",
      "argument_error",
      "unknown_tool",
      "dangerous_tool",
      "loop",
      "malformed_output",
      "exfiltration",
      "ambiguous_request",
    ]) {
      expect(categories.has(required as never), `missing category ${required}`).toBe(true);
    }
  });

  it("layer 1: every gateway scenario passes with no model involved", async () => {
    const results = await runGatewayLayer(dataset);
    const applicable = results.filter((r) => r.applicable);
    expect(applicable.length).toBeGreaterThanOrEqual(12);
    const failed = applicable.filter((r) => !r.pass).map((r) => r.id);
    expect(failed).toEqual([]);
  });
});