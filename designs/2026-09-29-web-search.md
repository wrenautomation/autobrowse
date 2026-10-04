# Web search: Google's page, Exa, Perplexity

2026-09-29. Status: built. All three answered live.

## Ask

William: search the way a person does, in the browser, and audit every
result and the AI Overview, behind an API. Add Exa and Perplexity as sources.

## Shape

| Source | Call | Leg |
|---|---|---|
| Google | `web GET /google?q=&n=&hl=&gl=` | browser, `browser/flows/google-search.ts` |
| Exa, Brave, DuckDuckGo | `web GET /search?q=&n=&via=` | API, `reach/web.ts` (EXA_API_KEY live) |
| Perplexity | `perplexity POST /chat/completions` | API with PERPLEXITY_API_KEY, else browser, `browser/flows/perplexity-ask.ts` |

- **Google** returns `{query, overview: {text, sources}, results, ads, questions}`.
  Results are numbered across up to 3 pages. Each `/goto` link is resolved
  by one redirect read; the target is never loaded.
- **Perplexity** answers in the API's shape (`choices`, `citations`,
  `search_results`) either way, so a caller never knows which leg ran. The
  browser leg asks only the last user message, on the free plan.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Google by browser, not an API | No search API for new callers; the page (Overview, ads, PAA) is what gets audited |
| 2 | `signedOut` on `web` | A search has no account; the policy's account made the facade demand a signed-in profile |
| 3 | Google on the Mac's desk | The box's IP gets /sorry (reCAPTCHA); the flow solves one if the Mac meets it |
| 4 | Overview read until stable | It streams in; source cards land last. Re-read until the text stops growing and sources exist |
| 5 | Pace 5-15 s, 300 pages a day | A person's rate |
| 6 | Perplexity `via: "google"` | Made with Continue with Google as william@. Its session dies with a profile of its own but lives in google-admin, where explore and login already put it |
| 7 | OAuth sign-in names the site's own account | A spec with no account fell back to the `google` credential (his personal) and typed its password once, rejected. Now `ctx.cred.via` → its username, and `credFor` also finds `google-admin` |
| 8 | Perplexity API stays off | Paid; his spend. The key name is ready |
| 9 | Titles lose Perplexity's breadcrumb | It glues "host › path" onto the title; stripped using the URL's own segments |
| 10 | Google's zero-result page is `results: []` (2026-10-03) | 7 of 12 `site:` lookups landed there and threw. Read by its text ("did not match any documents", "No results found for"), since `#search` may be absent. A quotes-relaxed page answers another query, so it also counts as none. English pages only |
| 11 | LinkedIn pages from Exa's cache, never live (2026-10-03) | `GET /linkedin/profile` and `/linkedin/company` post `livecrawl: "never"` to Exa `/contents`: LinkedIn sees no request, no account is used. Parsed to the `linkedin` site's shapes so wren swaps legs without new types; raw `text` kept. Wren's design: `wren/designs/2026-10-03-lead-sheet.md` |
| 12 | One `exa` budget in mills (2026-10-03) | Exa bills in dollars: `/people` and `/companies` 7, a cache read 1, cap 330 a day (about $10 a month, the free credit). Raising it is William's call. A 404 still spends its mill here; Exa charges nothing for it. `/search`'s Exa leg stays unmetered |
| 13 | A page Exa lacks is 404 (2026-10-03) | Exa answers 200 with `ENTITY_NOT_FOUND` in `statuses`. 404 lets wren count it as one refusal; the URL stays out of the message |

## Proven

- `web GET /google` "…", n=12: Overview + sources, 12 results with real URLs, 11-26 s.
- `perplexity POST /chat/completions`: answer + 10 sources, 24 s.
- `web GET /search` through Exa.
- `web GET /linkedin/company` and `/linkedin/profile` on real cached pages (2026-10-03): every field parsed, `source: cached`.

## Open

- wren calls: send `web /google` and `perplexity` to the desk (`restateSites(ctx, undefined, DESK)`), like Reddit.
- Explore runs any `via` site in the provider's profile; the facade only does for sites that say `via`. LinkedIn (his personal) is why this isn't global.
