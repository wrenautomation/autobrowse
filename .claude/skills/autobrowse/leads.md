# Leads: Google Maps and LinkedIn

Output is a CSV that wren imports. Re-running a job resumes it.

```sh
pnpm -s autobrowse maps "staffing agency in austin tx" --max-minutes 10   # listings with phone, site, emails → wren --format google-maps
pnpm -s autobrowse people recruiting founder austin --pages 2 --enrich    # LinkedIn people → wren --format linkedin
pnpm -s autobrowse people founder --company <handle> --enrich             # one firm's people; keywords narrow
```

`maps`: several searches in one run; `--depth` goes further down each list
(1 ≈ 20 places); `--no-email` skips visiting each site. Needs Docker.
`people`: `--network F,S,O`, `--max`, `--out` (appended to).

One LinkedIn read at a time, through the facade (paced and capped per day):

```sh
pnpm -s autobrowse site call linkedin GET "/search/results/people?keywords=ria%20founder&pages=2"
pnpm -s autobrowse site call linkedin GET "/in/<vanity>?company=true"          # every role + current employer's page
pnpm -s autobrowse site call linkedin GET "/company/<handle>"                  # website, size, industry, HQ, phone
pnpm -s autobrowse site call linkedin GET "/company/<handle>/people?keywords=founder&max=30"
pnpm -s autobrowse site call linkedin GET "/company/<handle>/jobs?max=50"      # open roles; location= narrows
```

LinkedIn reads run as the account the accounts policy names for research.
A day's cap refused (429) means stop for the day, not retry.
`POST /in/<vanity>/connect` and `/message` send: never without William's yes.

Into wren: `wren email import-people <file> --format linkedin --niche <niche>`.
