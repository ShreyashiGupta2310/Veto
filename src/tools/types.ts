import { z } from "zod";
import type { RiskClass } from "../schemas";
import type { StoreContext } from "./store";

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface ToolDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodType;
  riskClass: RiskClass;
  execute: (rawArgs: unknown, ctx: StoreContext) => Promise<ToolResult>;
}

// Lets each tool write its logic with properly typed args,
// while the outside world only sees the plain ToolDefinition shape.
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  argsSchema: S;
  riskClass: RiskClass;
  run: (args: z.infer<S>, ctx: StoreContext) => Promise<ToolResult>;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    argsSchema: def.argsSchema,
    riskClass: def.riskClass,
    // Second lock: validate again even if the gateway already did.
    execute: async (rawArgs, ctx) => def.run(def.argsSchema.parse(rawArgs), ctx),
  };
}