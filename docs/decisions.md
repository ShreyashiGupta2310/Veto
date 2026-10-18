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
Plan: ask the model for a JSON object, validate it with Zod, then dispatch by hand.
This works with any model. Native tool-calling depends on model support.
The smoke test result is recorded below once it has been run.