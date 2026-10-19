// Masks personal data in tool arguments before they are written to the log.
// It returns a copy. The real arguments are never changed, because the tool still needs them.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HIDDEN_KEYS = new Set(["body", "subject"]);
const SECRET_KEY = /key|token|secret|password/i;
const MAX_DEPTH = 5;

// "asha@example.com" becomes "a***@example.com". I keep the domain because it is useful in an audit.
export function maskEmail(text: string): string {
  return text.replace(EMAIL, (match) => `${match.charAt(0)}***${match.slice(match.lastIndexOf("@"))}`);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") return maskEmail(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactEntry(k, v, depth + 1)]),
    );
  }
  return "[unsupported]";
}

function redactEntry(key: string, value: unknown, depth: number): unknown {
  if (HIDDEN_KEYS.has(key.toLowerCase())) {
    return typeof value === "string" ? `[redacted: ${value.length} chars]` : "[redacted]";
  }
  if (SECRET_KEY.test(key)) return "[redacted]";
  return redactValue(value, depth);
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, redactEntry(k, v, 1)]));
}