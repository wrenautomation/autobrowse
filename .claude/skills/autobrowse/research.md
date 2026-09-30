# Research: read, search, Google, Perplexity

No explore session. Cheapest first.

```sh
pnpm -s autobrowse read <url> --max 4000     # a page as plain text: jina, then a plain fetch
pnpm -s autobrowse search <words…> -n 5      # exa, then brave, then duckduckgo: the first with a key
pnpm -s autobrowse doctor                    # which backends and tokens answer right now
```

`--via a,b` sets the backend order for one call. `--json` for machine use.

Google's own page: the AI Overview and its sources, every organic result, ads,
People also ask. A browser leg, paced like a person and capped per day. Run it
on the Mac; Google bot-checks the box.

```sh
pnpm -s autobrowse site call web GET "/google?q=<url-encoded>&n=10"   # gl=us, hl=en narrow it
```

Perplexity: an answer with citations. Its API with a key, else the signed-in
page (free plan, paced).

```sh
pnpm -s autobrowse site call perplexity POST /chat/completions \
  --body '{"messages":[{"role":"user","content":"…"}]}'
```

Which one:

- A known URL: `read`.
- Many candidates: `search`, then `read` the few that matter.
- What Google itself shows (Overview, ads, rank): `/google`. Slow and capped;
  don't loop it.
- A synthesized answer with sources: Perplexity. Check its citations with `read`.
- A page behind a login, or blank without scripts: explore.md.

The same calls over HTTP or Restate: the `web` site, `GET /search?q=…`,
`GET /read?url=…`, `GET /google?q=…` (site-apis.md).
