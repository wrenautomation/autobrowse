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
- **Ledgers are hash-chained** (credkeep `chain`, was `src/deps/chain.ts`): each row carries
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
- **Langfuse is the endpoint, OpenTelemetry is the wire.** It is not a
  choice between them: what the code speaks is OTLP/JSON with GenAI
  semantic-convention attributes (`gen_ai.usage.input_tokens`,
  `gen_ai.response.model`), and Langfuse is one URL that accepts it.
  Three env names (`OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS/SERVICE_NAME`)
  point the same sink at Honeycomb, Grafana or a local collector, so
  nothing above the sink knows the vendor. Langfuse earns the default
  because it reads spans back as model calls — prompt/reply sizes,
  tokens, cost per model — on a free tier, with no collector to run.
- **The keys are minted, not pasted.** Langfuse's create-key API is
  Enterprise-only, so `site setup langfuse project-keys` is a compiled
  browser flow on the project's API-keys page; `langfuse wire` derives
  the OTEL names (and the Basic value the `langfuse` site API reads
  with) from the two keys. The values go to the SSM env store and are
  never printed.
- **A short-lived CLI loses its spans unless it flushes.** The sink
  batches (20 spans / 5 s) and the timer is unref'd, so a command that
  makes one model call and exits took the batch with it — the first
  symptom was a wired, 200-answering endpoint with an empty Langfuse UI.
  `traceSinkFor` now flushes on `beforeExit`/SIGINT/SIGTERM. Proving a
  door opens is not proving a span landed: `autobrowse langfuse recent`
  reads them back (the v2 observations API; the legacy trace APIs are
  closed to orgs created after 2026-09-16).
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
6. ✅ Langfuse: keys minted by `site setup langfuse project-keys`,
   pushed to SSM, `langfuse wire` / `check` / `recent`, flush at exit,
   GenAI semconv attributes — real spans land as GENERATION rows
7. Span per browser act (`fp.act`) under the same trace, once the LLM
   spans prove useful
