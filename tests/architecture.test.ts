import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("architecture", () => {
  it("keeps the gateway free of model and agent code", () => {
    const dir = "src/gateway";
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, `${file} imports from model/ or agent/`).not.toMatch(/from\s+["'][^"']*\/(model|agent)(\/|["'])/);
      expect(text, `${file} mentions Ollama`).not.toMatch(/ollama/i);
    }
  });
});