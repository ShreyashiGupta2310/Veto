# Architecture

```mermaid
flowchart TD
    A[User task] --> B[Agent loop]
    B -->|asks| C[Model via Ollama]
    C -->|one JSON proposal| D{Parse and validate}
    D -->|invalid: one retry, then fail| B
    D --> E[Gateway]
    E --> E1[Tool on the allowlist?]
    E1 --> E2[Arguments valid?]
    E2 --> E3[Policy rules from policy.v1.json]
    E3 --> F{Decision}
    F -->|ALLOW| H[Execute tool]
    F -->|REQUIRE_APPROVAL| G[Approval queue]
    G -->|human approves, policy checked again| H
    G -->|human rejects| I
    F -->|DENY| I[Denial reason]
    H --> J[Result labelled untrusted data]
    J --> B
    I --> B
    E -.->|every step| L[(Audit log: runs/run-id.jsonl)]
```

## Boundaries
- `src/model/`: the model client interface and the Ollama implementation. Replaceable.
- `src/agent/`: the loop, the prompt and the proposal parser.
- `src/gateway/`: validation, policy, approvals and the executor. No model calls. A test checks this.
- `src/tools/`: simulated store tools and their Zod schemas.
- `src/audit/`: the log writer and the redaction.
- `eval/`: scenarios, the two runners and the report generator.

Design decisions are in `decisions.md`.