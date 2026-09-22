# Observability and tamper evidence (2026-09-22)

What William asked after the AWS port-25 workflow: is the agent loop
durable and traced, should credential transactions be signed, can the
last mile of a compile be done by a model too.

## Decisions

- **No signatures or ZK on credential use.** One party reads the store
  (the worker) and it would also hold the signing key: nothing is proven
  that the audit row does not already say. Two-party calls are already
  signed (Restate request identity). What was missing was tamper
  *evidence* on the ledgers.
- **Ledgers are hash-chained** (`src/deps/chain.ts`): each row carries
  `prev` (the hash of the row before) and `hash` (SHA-256 over prev + the
  row's fields in key order). `autobrowse ledger verify` walks a file and
  names the first row that does not fit; rows from before chaining may
  only lead the file and are bound by the first chained row's `prev`.
  Audit (secret uses), spend (gate decisions) and steps (agent) sit on it.
- **The agent loop stays out of Restate.** A live browser cannot be
  replayed; what lasts is its output. Two gaps were real and are closed:
  sessions are now rows of the Runs registry (workflow `agent`: started,
  `step` per agent step, finished; a session that died with the worker is
  finished as failed on the next start), and every step is a row of the
  step ledger with its own model spend and wall time
  (`src/agent/ledger.ts`, `autobrowse steps`).
- **Tracing is one seam, no vendor SDK.** `tracedLlm` wraps any `Llm`;
  `withTrace({session, step})` tags every call under it; the OTLP/JSON
  sink posts batches to `<endpoint>/v1/traces` with the env's headers.
  Spans carry token counts, sizes and hashes; never a prompt or a reply.
- **No agent framework.** The loop is ~300 lines whose hard parts (aria
  digest, secret placement, origin binding, evaluator, pause) a framework
  would not own; tracing came cheaper as a seam.

## Where to attack (ranked)

1. ✅ chained ledgers + `ledger verify`
2. ✅ agent sessions as registry rows; step ledger; `steps` CLI
3. ✅ `tracedLlm` + OTLP sink; `OTEL_*` settings
4. ✅ `send` gate for compiled irreversible steps (the `human` gate was
   the host's; approving it reran the step into the same gate)
5. ✅ `compile --finish` / `finish <name>`: a model finishes the rendered
   file inside the typecheck + test loop; heal triggers it —
   `2026-09-22-self-finishing-compile.md`
6. Langfuse/Honeycomb key minted by `site setup` and pushed to SSM
   (William's account first)
7. Span per browser act (`fp.act`) under the same trace, once the LLM
   spans prove useful
