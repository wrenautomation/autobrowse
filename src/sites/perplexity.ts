/**
 * Perplexity under its API's shape: `POST /chat/completions`, an answer with
 * its citations and search results. The API is paid (PERPLEXITY_API_KEY,
 * the person's spend); with no key the question goes to the signed-in web
 * page on the free plan (`browser/flows/perplexity-ask.ts`) and comes back
 * in the same shape. Only the last user message is asked there: the page
 * takes no system prompt and no model.
 */
import { z } from "zod";
import type { Asked } from "../browser/flows/perplexity-ask.js";
import { HttpError } from "../clients/http.js";
import { route, type SiteApi } from "./types.js";

export const PERPLEXITY_API = "https://api.perplexity.ai";
export const PERPLEXITY_API_KEY = "PERPLEXITY_API_KEY";

const completion = z
  .object({
    model: z.string().default("sonar"),
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
      .min(1)
      .refine((m) => m.some((x) => x.role === "user" && x.content.trim()), "no user message"),
  })
  .passthrough();
type Completion = z.infer<typeof completion>;

/** The question the web page is asked: the last user message. */
export const questionOf = (c: Completion): string =>
  c.messages.findLast((m) => m.role === "user")?.content.trim() ?? "";

/** The web page's answer in the API's response shape. */
export function completionOf(a: Asked) {
  return {
    id: a.thread.split("/").pop() ?? a.thread,
    model: "perplexity-web",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: a.text },
      },
    ],
    citations: a.sources.map((s) => s.url),
    search_results: a.sources.map((s) => ({
      title: s.title ?? s.site,
      url: s.url,
      snippet: s.snippet,
    })),
    thread: a.thread,
  };
}

export const perplexity: SiteApi = {
  site: "perplexity",
  origin: PERPLEXITY_API,
  auth: { token: PERPLEXITY_API_KEY },
  via: "google",
  // The browser leg only: the free plan, paced like a person asking.
  caps: { ask: 100 },
  pace: { gapMs: 10_000, jitterMs: 10_000 },
  routes: [
    route({
      method: "POST",
      path: "/chat/completions",
      summary:
        "An answer from the web with its citations (`messages`, `model` default sonar): the API with a key, else the signed-in page (the last user message only)",
      request: completion,
      meter: () => ({ ask: 1 }),
      api: async (body, leg) => {
        const url = `${PERPLEXITY_API}/chat/completions`;
        const res = await leg.http.json<unknown>(url, {
          method: "POST",
          headers: { authorization: `Bearer ${leg.token}` },
          body,
        });
        if (!res.ok) throw new HttpError("POST", url, res.status);
        return res.body;
      },
      browser: {
        flow: "perplexity/ask",
        input: (c) => ({ q: questionOf(c) }),
        output: (o) => completionOf(o as Asked),
      },
    }),
  ],
  setup: [],
};
