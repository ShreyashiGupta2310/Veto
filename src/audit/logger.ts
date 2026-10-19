import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AuditEvent } from "../schemas";

// Only these characters are allowed in a run id, so it can never point outside the log folder.
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

// Example: run-20261019T003000Z-a1b2c3
export function makeRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

export interface RunLogger {
  path: string;
  audit: (event: AuditEvent) => void;
}

export function createRunLogger(opts: { dir: string; runId: string }): RunLogger {
  if (!SAFE_RUN_ID.test(opts.runId)) {
    throw new Error(`Unsafe run id: ${opts.runId}`);
  }
  mkdirSync(opts.dir, { recursive: true });
  const path = join(opts.dir, `${opts.runId}.jsonl`);
  return {
    path,
    // Synchronous on purpose: if writing fails it throws, and the gateway then refuses to run the tool.
    audit: (event) => {
      appendFileSync(path, JSON.stringify(AuditEvent.parse(event)) + "\n");
    },
  };
}

export function readTrace(path: string): AuditEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => AuditEvent.parse(JSON.parse(line)));
}
