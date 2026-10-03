# autobrowse in prod

The worker runs on the operator's Mac: `deploy/desk/install.sh` puts the desk
worker (`src/app/desk.ts`) under launchd. It serves `desk` on Restate Cloud
through the tunnel it dials, with the Mac's home IP and Chrome profiles. wren
sends every `sites` call there. Calls wait in Restate while the Mac sleeps.

A commit on `main` that touches `src/`, `package.json` or the lockfile restarts
the worker within a minute (`deploy/desk/update.mjs`, a second launchd agent).
Uncommitted edits there hold it. A restart that never logs "desk up" pings #ops.
Log: `~/Library/Logs/autobrowse-desk-deploy.log`. Why:
`designs/2026-10-03-desk-deploy.md`.

The AWS box (t3.medium, ECR image, `/data` volume, CI deploy) was retired on
2026-10-02 to cut cost. Its `/data` (profiles, artifacts) is archived at
`s3://<shots bucket>/retired-box/2026-10-02-data.tgz`. Git history before that
date has the box's terraform, compose file and scripts.

## AWS left

`deploy/terraform`: the screenshots bucket (`shots.tf`), the owners role
(`owners.tf`) and the env store path (`env-store.tf`). `aws login`, then
`cd deploy/terraform && tofu apply`.

## Env store

SSM `/autobrowse/config`, one SecureString per name.
`pnpm autobrowse env push NAME…` (from `.env`) or `--from deploy/prod.env`;
`pnpm autobrowse env ls|get|pull` reads them back on any machine with AWS
access. Site credentials: `pnpm autobrowse creds push <site>`.

## `aws login` without a person

The AWS sign-in page is a known site (`aws`): `autobrowse creds set aws` with
the root email or `<account>/<iam user>`, the console password and the MFA
seed. Then `aws login --remote` prints a URL; an explore session on it with
site `aws` signs in and allows the CLI.
