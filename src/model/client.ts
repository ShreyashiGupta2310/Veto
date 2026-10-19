export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ChatMessage[];
  // A JSON schema that tells the model what shape its answer must have.
  format?: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  latencyMs: number;
  // Only filled in if the model server really reported them. Never guessed.
  promptTokens?: number;
  outputTokens?: number;
}

export type ModelErrorCode =
  | "ollama_unreachable"
  | "model_not_found"
  | "timeout"
  | "http_error"
  | "bad_response"
  | "empty_response";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

export interface ModelClient {
  readonly id: string;
  readonly settings: Record<string, unknown>;
  chat(req: ModelRequest): Promise<ModelResponse>;
}