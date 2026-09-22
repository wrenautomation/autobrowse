/**
 * `autobrowse langfuse …`: the trace back end, set up the way every other
 * key is — minted in the browser, kept in the store, derived into the three
 * OTEL names the sink reads. Nothing prints a key.
 */
import type { Command } from "commander";
import type { EnvStore } from "credvault";
import { checkTracing, recentSpans, wireTracing } from "../chores/langfuse.js";
import { httpClient } from "../clients/http.js";

export function registerLangfuseCommands(program: Command, store: () => EnvStore): void {
  const langfuse = program
    .command("langfuse")
    .description("Langfuse as the trace back end: wire the OTLP sink to it, then prove it");
  langfuse
    .command("wire")
    .description(
      "Derive OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS/SERVICE_NAME in the store from the Langfuse keys already there",
    )
    .option("--service <name>", "what the traces are labelled", "autobrowse")
    .option("--base-url <url>", "a self-hosted Langfuse instead of cloud.langfuse.com")
    .action(async (o: { service: string; baseUrl?: string }) => {
      const r = await wireTracing(store(), {
        serviceName: o.service,
        ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      });
      console.log(`wrote ${r.wrote.join(", ")}\ntraces go to ${r.endpoint}`);
      console.log("pull them into this machine's .env: autobrowse env pull");
    });
  langfuse
    .command("check")
    .description("Post an empty OTLP batch through the wired door: proves the keys and the URL")
    .action(async () => {
      const http = httpClient();
      const r = await checkTracing(store(), async (url, init) => {
        const res = await http.json<unknown>(url, {
          method: "POST",
          headers: init.headers,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return { status: res.status };
      });
      console.log(r.ok ? `Langfuse accepted the batch (${r.status})` : `Langfuse said ${r.status}`);
      if (!r.ok) process.exitCode = 1;
    });
  langfuse
    .command("recent")
    .description(
      "The spans Langfuse actually holds: proves model calls are landing, not just posting",
    )
    .option("--minutes <n>", "how far back to look", "60")
    .action(async (o: { minutes: string }) => {
      const http = httpClient();
      const spans = await recentSpans(
        store(),
        async (url, init) => {
          const res = await http.json<unknown>(url, { headers: init.headers });
          return { status: res.status, body: res.body };
        },
        { minutes: Number(o.minutes) },
      );
      if (spans.length === 0) {
        console.log(`no spans in the last ${o.minutes} min`);
        return;
      }
      for (const s of spans)
        console.log(`${s.startTime}  ${s.type.padEnd(10)} ${s.name}  ${s.traceId}`);
    });
}
