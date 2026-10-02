# Walkthrough

The path from a fresh clone to running autobrowse for real. Each guide is
short, in order, with the exact commands and what they print. `demos/` are
scripts you can run now; they read, dry-run or list — nothing spends, posts
or leaves a mailing list without you.

| # | Guide | You end up with |
|---|-------|-----------------|
| 0 | [Setup](00-setup.md) | the CLI running on your Mac, the UI on :9080 |
| 1 | [Secrets and money](01-secrets-and-money.md) | credentials sealed, gates on, the ledger in your channel |
| 2 | [Sites: APIs with a token, browser without](02-sites.md) | `site call` against YouTube/Gmail, setup steps for the rest |
| 3 | [Meta app: ads, Pages, Instagram](03-meta-app.md) | one token that runs ads and posts, from wren |
| 4 | [Google OAuth: YouTube and Gmail](04-google-oauth.md) | consent kept per account, codes read from any inbox |
| 5 | [Explore → record → compile → run](05-explore-to-flow.md) | a deterministic workflow from one exploration |
| 6 | [The agent, `do`, healing](06-agent-and-do.md) | one verb that routes or builds |
| 7 | [Accounts: login, signup, OAuth sign-in](07-accounts.md) | a site signed in by itself; a Wren account made by the agent |
| 8 | [Chores: unsubscribe](08-chores.md) | the inbox off every list you did not mean to join |
| 9 | [The box (retired)](09-box.md) | prod moved to the Mac desk worker, 2026-10-02 |

Demos:

```sh
walkthrough/demos/01-sites.sh          # what every site can do right now, one real read on YouTube
walkthrough/demos/02-unsubscribe.sh    # the inbox's mailing lists (list only)
walkthrough/demos/03-explore.sh        # map a page by aria tree, journal two acts, save + compile, try it
walkthrough/demos/04-do-dry.sh         # how `do` routes three goals, running nothing
walkthrough/demos/05-ledger.sh         # where secrets went and what the gate decided
walkthrough/demos/06-needs.sh          # which account is for what; every open need with its command
```

Each demo prints what it did; `03-explore.sh` ends with the compiled flow
running and answering `{"title":"Example Domains"}` — one exploration, then
a deterministic step with no model. Demos that read your inbox or YouTube
need the tokens guide 4 makes (both are there today).

Reference: `../README.md` (everything, dense), `../designs/` (why), `../NEEDS-WILLIAM.md` (what only you can do).
