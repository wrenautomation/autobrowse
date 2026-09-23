# Screenshots in a bucket

2026-09-22. Status: built, live on the Mac (229 files, 7.3 MB shipped); the box ships from its next deploy.

## Why

Screenshots are signal: what a page looked like when a flow failed, and
every step of a recording or an explore. They lived on one disk each (the
box's volume, the Mac). One lost machine lost them, and nothing could look
across machines.

## What ships

- `artifacts/`: a failed flow's PNG, its `.aria.txt` and its `.failure.json`
- `recordings/`: screenshots, `manifest.json`, `summary.json`, journals (`.jsonl`)
- never trace zips (they hold network bodies), never other state (`llm-budget.json`, ledgers)
- nothing over 20 MB

Key: `<machine>/<artifacts|recordings>/<path>`. The box is `box`
(`SHOTS_MACHINE` in `compose.prod.yml`); a laptop is its hostname.

## How

- `shipShots` (`src/shots/ship.ts`) walks both dirs and ships what the ledger
  lacks, oldest first. Ledger: `<artifacts>/.shots-shipped.tsv`, one line
  per file (`key size mtime`), written after each put. Stop any time; the
  next run resumes. A rewritten file ships again.
- The first refusal stops the run (the store is down; the rest would fail the
  same way). An unreadable file is skipped and counted.
- When: the worker every `SHOTS_EVERY_MINUTES` (60), and before an idle stop;
  `autobrowse shots push [--dry]` by hand. No `SHOTS_BUCKET` = off.

## Where: S3, not R2

- A shot of a settings page can show a token. The bucket sits in the same
  AWS account as the vault, private, encrypted, public access blocked.
- R2 needs a card on the Cloudflare account (William's call) and would put
  those shots at a second vendor.
- Cost: S3 Standard is $0.023/GB-month. At today's rate that is cents a year.
- `src/shots/s3.ts` is the one file that names the vendor. `SHOTS_ENDPOINT`
  points it at R2 (keys in the AWS names) if that changes.

Infra: `deploy/terraform/shots.tf`. The box role may only `PutObject`.
Applied with `-target`: a full plan also shows drift on the instance and two
policies, left for a separate look.

## Where to attack (ranked)

1. **Terraform drift.** `tofu plan` wants to change `aws_instance.box`,
   `box_self` and `ci` in place. Read the diff before any full apply.
2. **Nothing reads the bucket yet.** The evaluator and repairer still read
   local failures. Next: the evaluator reads the bucket so it sees every
   machine's failures.
3. **Journals are redacted by a heuristic.** A typed value that does not look
   like a secret ships in a `.jsonl` as typed. Same account as the vault, so
   acceptable; revisit before a client's shots land here.
4. **The ledger grows by one line per file.** Fine to ~100k files. Past
   that, roll it by month.
