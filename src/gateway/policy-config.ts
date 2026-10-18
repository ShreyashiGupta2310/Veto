import { readFileSync } from "node:fs";
import { z } from "zod";

export const ToolPolicy = z.strictObject({
  mode: z.enum(["allow", "deny"]),
  allowedEmailDomains: z.array(z.string().min(1)).min(1).optional(),
  refund: z
    .strictObject({
      autoApproveLimitPaise: z.number().int().positive(),
      dailyCapPaise: z.number().int().positive(),
    })
    .optional(),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const PolicyConfig = z.strictObject({
  version: z.string().min(1),
  tools: z.record(z.string(), ToolPolicy),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export function loadPolicy(path: string): PolicyConfig {
  return PolicyConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}