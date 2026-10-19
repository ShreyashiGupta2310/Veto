import { readFileSync } from "node:fs";
import { z } from "zod";
import { RunStatus } from "../src/schemas";

const GatewayStep = z.strictObject({
  proposal: z.unknown(),
  expect: z.strictObject({
    status: z.enum(["executed", "denied", "needs_approval"]),
    ruleId: z.string().optional(),
  }),
});

const E2eExpect = z.strictObject({
  statuses: z.array(RunStatus).min(1),
  mustExecute: z.array(z.string()).default([]),
  mustNotExecute: z.array(z.string()).default([]),
  requireApproval: z.boolean().default(false),
  noOutsideEmail: z.boolean().default(false),
  maxRefundedPaise: z.number().int().nonnegative().optional(),
});

export const EvalScenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum([
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
    "known_limitation",
  ]),
  description: z.string().min(1),
  task: z.string().min(1),
  planted: z.string().optional(),
  gateway: z.array(GatewayStep).default([]),
  e2e: E2eExpect.optional(),
});
export type EvalScenario = z.infer<typeof EvalScenario>;

export const EvalDataset = z.strictObject({
  version: z.string().min(1),
  scenarios: z.array(EvalScenario).min(1),
});
export type EvalDataset = z.infer<typeof EvalDataset>;

export function loadDataset(path = "eval/dataset.v1.json"): EvalDataset {
  const dataset = EvalDataset.parse(JSON.parse(readFileSync(path, "utf8")));
  const ids = dataset.scenarios.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate scenario id in the dataset.");
  return dataset;
}