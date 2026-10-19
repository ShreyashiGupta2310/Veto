# Decision log

A short record of what I chose, what I rejected, and why.

## 1. Name: Veto
A veto is the power to say "no". That is the whole job of this project:
the model proposes, plain code can say no.

## 2. TypeScript on Node.js
Chosen because I already know it, so the day goes into agent ideas and not a new language.
Rejected: Python. It has more eval tooling, but switching languages costs time I don't have.

## 3. Zod at every boundary
Model output, tool arguments, policy config, eval scenarios and audit events are all
checked with Zod at the edge. After that, the code inside can trust the types.

## 4. The model never calls tools directly
The model only proposes an action. The gateway decides. Permissions live in code,
because the model is the part that can be tricked by text.

## 5. Hand-written agent loop
About 100 lines, and it is the main thing I want to learn.
Rejected for now: agent frameworks. Only worth a look if everything else is done.

## 6. Files only, no database
JSONL for logs, JSON for fixtures and policy. Fewer moving parts for a one-day build.

## 7. Money is stored as integer paise, never floats
Floats can give wrong results in comparisons (0.1 + 0.2 is not exactly 0.3).
A refund limit check must be exact, so 1 rupee = 100 paise, stored as a whole number.

## 8. Vitest for tests
Fast, TypeScript works out of the box, and it fits the Vite-style setup.

## 9. No lint config
Cut to save time. Type checking (`npm run typecheck`) stays.

## 10. How the model proposes actions

I ask the model for one JSON object, check it with Zod, then call the tool myself.
This works with any model, unlike native tool-calling, which depends on model support.
I pass a JSON schema in Ollama's `format` field and also describe the shape in the prompt.

Smoke test (`scripts/smoke.ts`, 2026-10-18, structured mode, temperature 0, 5 prompts x 2 runs per model):
- gemma4:e2b: 10 of 10 valid proposals. 16.2 s fastest and 53.6 s slowest per call.
  237 to 392 output tokens per call, in the lines I could read.
- gemma3:4b: 10 of 10 valid proposals. 8.3 s fastest and 30.4 s slowest per call.
  39 to 115 output tokens per call.
- Not tested: plain mode (no `format` field), and whether the proposed actions are sensible.
  This only checks the shape of the output.
- Only 10 calls per model, so this is a quick check and not a reliability claim.

## 11. Model for development and the end-to-end eval: gemma3:4b
Both models passed the shape check, and gemma3:4b was faster in my runs with far fewer output tokens.
The end-to-end eval needs many model calls, so speed decides it.
The model sits behind a ModelClient interface, so gemma4:e2b can be swapped in later.
I still need to read the license on the Ollama page for the model I ship and write it in the README.

## 12. Policy rules: first match decides, default deny
The policy engine goes down a fixed list of rules and the first one that applies decides.
A tool that is not in the policy file is denied. A tool-specific rule (refunds, emails) wins over the
general rule "irreversible tools need approval". A refund above the order total is a hard DENY, not a
request for approval, because a human cannot fix a wrong amount by clicking yes.
Email domains are compared exactly (the text after the last @), never with "contains", so
example.com.evil.test and a@example.com@evil.test are blocked. "Today" for the daily cap is the UTC date.

## 13. The gateway fails closed
The audit event for a decision is written before the tool runs. If writing the log fails, the call
throws and the tool never runs. Arguments are validated once and the cleaned copy goes to both the
policy and the tool. A test (tests/architecture.test.ts) fails if any file in src/gateway/ imports
model or agent code, so the guard cannot start depending on the model.

## 14. Approvals can never overrule a hard DENY
When a human approves, the policy is checked again first. If the answer is now DENY (for example,
another refund used up the order total while this one waited), the approval is blocked.
A request is marked approved before the tool runs, so a double click cannot run it twice.

## 15. Audit log and masking
One JSONL file per run, named by a run id that may only contain letters, digits, _ and -.
Emails are masked but keep the first letter and the domain, because the domain is what an auditor
needs. Email subject and body are replaced by their length. Keys that look like secrets are hidden.

## 16. Model client
I call Ollama with plain fetch, with no SDK, so there is one less thing to learn and to break.
Temperature is 0 and streaming is off. Each failure has its own code: ollama_unreachable,
model_not_found, timeout, http_error, bad_response, empty_response.