import { ModelError, type ModelClient, type ModelRequest, type ModelResponse } from "./client";

export interface OllamaOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  fetchFn?: typeof fetch;
}

export function createOllamaClient(opts: OllamaOptions): ModelClient {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const temperature = opts.temperature ?? 0;
  const doFetch = opts.fetchFn ?? fetch;

  return {
    id: opts.model,
    settings: { provider: "ollama", temperature, timeoutMs },

    async chat(req: ModelRequest): Promise<ModelResponse> {
      const body: Record<string, unknown> = {
        model: opts.model,
        stream: false,
        messages: req.messages,
        options: { temperature },
      };
      if (req.format) body["format"] = req.format;

      const started = Date.now();
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new ModelError("timeout", `No answer from Ollama within ${timeoutMs} ms.`);
        }
        const why = err instanceof Error ? err.message : String(err);
        throw new ModelError("ollama_unreachable", `Could not reach Ollama at ${baseUrl}. Is it running? (${why})`);
      }
      const latencyMs = Date.now() - started;

      if (res.status === 404) {
        throw new ModelError("model_not_found", `Ollama does not have the model "${opts.model}". Try: ollama pull ${opts.model}`);
      }
      if (!res.ok) {
        throw new ModelError("http_error", `Ollama answered with HTTP ${res.status}.`);
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new ModelError("bad_response", "Ollama's reply was not valid JSON.");
      }

      const obj = data as {
        message?: { content?: unknown };
        eval_count?: unknown;
        prompt_eval_count?: unknown;
      } | null;
      const raw = obj?.message?.content;
      const content = typeof raw === "string" ? raw : "";
      if (content.trim() === "") {
        throw new ModelError("empty_response", "The model returned an empty answer.");
      }
      return {
        content,
        latencyMs,
        promptTokens: typeof obj?.prompt_eval_count === "number" ? obj.prompt_eval_count : undefined,
        outputTokens: typeof obj?.eval_count === "number" ? obj.eval_count : undefined,
      };
    },
  };
}