import { describe, it, expect } from "vitest";
import { createOllamaClient } from "../src/model/ollama";

type FakeFetch = (url: unknown, init: unknown) => Promise<Response>;
const asFetch = (fn: FakeFetch) => fn as unknown as typeof fetch;
const request = { messages: [{ role: "user" as const, content: "hi" }] };
const okBody = (content: string) =>
  JSON.stringify({ message: { content }, eval_count: 7, prompt_eval_count: 12 });
const reply = (body: string, status = 200) => new Response(body, { status });
const clientWith = (fn: FakeFetch) =>
  createOllamaClient({ model: "gemma3:4b", fetchFn: asFetch(fn), timeoutMs: 1000 });

describe("ollama client", () => {
  it("returns the content and the token counts Ollama reported", async () => {
    const r = await clientWith(async () => reply(okBody("hello"))).chat(request);
    expect(r).toMatchObject({ content: "hello", promptTokens: 12, outputTokens: 7 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves token counts empty when Ollama does not report them", async () => {
    const r = await clientWith(async () => reply(JSON.stringify({ message: { content: "x" } }))).chat(request);
    expect(r.promptTokens).toBeUndefined();
    expect(r.outputTokens).toBeUndefined();
  });

  it("sends the model, temperature and format schema", async () => {
    let sent: Record<string, unknown> = {};
    const client = clientWith(async (_url, init) => {
      sent = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return reply(okBody("x"));
    });
    await client.chat({ ...request, format: { type: "object" } });
    expect(sent).toMatchObject({
      model: "gemma3:4b",
      stream: false,
      options: { temperature: 0 },
      format: { type: "object" },
    });
  });

  it("reports ollama_unreachable when the connection fails", async () => {
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.chat(request)).rejects.toMatchObject({ code: "ollama_unreachable" });
  });

  it("reports timeout", async () => {
    const client = clientWith(async () => {
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    });
    await expect(client.chat(request)).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports model_not_found on HTTP 404", async () => {
    const client = clientWith(async () => reply('{"error":"model not found"}', 404));
    await expect(client.chat(request)).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("reports http_error on other failures", async () => {
    const client = clientWith(async () => reply("oops", 500));
    await expect(client.chat(request)).rejects.toMatchObject({ code: "http_error" });
  });

  it("reports bad_response when the reply is not JSON", async () => {
    const client = clientWith(async () => reply("<html>nope</html>"));
    await expect(client.chat(request)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reports empty_response for blank or missing content", async () => {
    await expect(clientWith(async () => reply(okBody("   "))).chat(request)).rejects.toMatchObject({
      code: "empty_response",
    });
    await expect(clientWith(async () => reply("{}")).chat(request)).rejects.toMatchObject({
      code: "empty_response",
    });
  });
});