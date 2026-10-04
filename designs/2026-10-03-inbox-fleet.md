# inbox-fleet: cold-email domains to warming inboxes

2026-10-03. Code: `src/workflows/inbox-fleet/`. Clients: `src/clients/dynadot.ts`, `inbox-insiders.ts`, `aws-domain.ts`. Test: `test/inbox-fleet.test.ts`.

## What it does

Give it domains, a mailbox kind for each (`private_smtp` or `google_workspace`), and a sender name. Each domain gets three mailboxes. The workflow:

1. checks each domain at Dynadot (ours, or free and its price) and against Inbox Insiders' blocklist check;
2. buys the free ones from the Dynadot balance;
3. orders the mailboxes from Inbox Insiders in full-control mode, which writes the mail DNS at Dynadot and uploads the inboxes to Instantly;
4. waits until every mailbox shows in Instantly;
5. gives each domain its own Route 53 zone, copies Dynadot's records over, then moves the name servers;
6. masks the site: an ACM certificate, a CloudFront distribution showing the main site under the domain's own name (no redirect), apex and www aliases;
7. checks from public DNS: Route 53 name servers, MX, SPF, DMARC, the site answering 200;
8. puts every inbox on the fleet warmup preset and turns warmup on;
9. stores SMTP and IMAP logins as `smtp@<email>` and `imap@<email>`.

```
autobrowse try inbox-fleet --plan plan.json --dry-run    # prices, buys nothing
autobrowse try inbox-fleet --plan plan.json --ask        # stops at each gate
```

```json
{ "domains": [{ "name": "example.com", "mailboxes": "private_smtp" }], "sender": "First Last" }
```

Steps: check, buy!, order!, ready, isolate!, mask, verify, warmup, credentials. `!` = irreversible.

Keys come from the env store: `DYNADOT_API_KEY`, `INBOX_INSIDERS_API_KEY`, `INSTANTLY_API_KEY`. AWS uses the owner's credentials.

## How it is built

Every step reads before it writes, so a rerun resumes. The two that spend:

- `buy` checks the Dynadot balance first. If it is short, it asks for a deposit. Each register runs only if Dynadot does not already list the domain.
- `order` sends one idempotency key per mailbox kind, derived from the sorted domains. A retry after a card failure (402) reuses the key, and Inbox Insiders answers a repeat with `duplicate`.

Gate answers are run-wide by name. `buy`'s purchase prompt names both the domains and the mailbox order, so one yes covers both. When every domain is already ours, `order` asks the purchase gate itself.

`isolate` refuses to move name servers when the copy from Dynadot misses an MX, apex TXT or DMARC record that public DNS serves, or has no DKIM. A missed record there would drop mail.

Warmup preset (`WARMUP`): +1 a day to 30 (about 21 a day after three weeks), every warmup mail opened and answered, every spam landing pulled out, 30% marked important, weekends included. It stays on.

## Decision log

- 2026-10-03: Dynadot, not Cloudflare Registrar. Cloudflare will not let a domain leave its name servers; Route 53 needs that.
- 2026-10-03: A Route 53 zone per domain. Each zone gets its own four name servers, so a burned domain shares no DNS with the main one.
- 2026-10-03: Mask, not 301. A redirect points every link back at the main domain; the mask keeps each domain looking like its own site.
- 2026-10-03: Inbox Insiders in full-control mode with the Dynadot key: they write SPF, DKIM and DMARC. We copy their records into Route 53 afterward. DNS changes they make after the move land at Dynadot and do nothing.
- 2026-10-03: Instantly does warmup only. Cold mail goes out from wren over SMTP and IMAP, which is why the logins are stored.
- 2026-10-03: Google orders have no run id; Inbox Insiders' team builds them. `ready` waits for a person to approve once they show in Instantly. Their logins come as a CSV on the orders page.
- 2026-10-03: `domains --digits` suggests one letter swapped for a look-alike digit. Cheaper names, but filters may read them as spoofs.
- 2026-10-03: Not yet run live. Dynadot's DNS reply shape, the export's field names and the run status values are unconfirmed; `isolate`'s check and `loginOf`'s error (field names only) catch a wrong guess before harm.
