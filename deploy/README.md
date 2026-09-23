# autobrowse on AWS

One t3.medium box, the worker container from ECR, `/data` on its own volume,
secrets in SSM, no inbound port. Restate Cloud reaches the worker through the
tunnel the worker dials; you reach the UI through SSM port forwarding. The box is
**stopped between jobs**: a stopped instance bills nothing, the volume ~$2/month.
Running it is ~$1/day (t3.medium). `deploy/scripts/box.sh start|stop|release|status`.
A deploy starts it (tag `autobrowse:started-by=deploy`) and ships; the worker
stops it again once idle ("Idle stop"), never a deploy: a stop from CI could land
under a call that queued while the box booted. `box.sh start` by hand sets
`person`, which nothing stops but you (`box.sh stop`).

## Once

1. `aws login` (same account and region as wren). `cd deploy/terraform && tofu init && tofu apply`.
   wren's terraform must already be applied: this reads its GitHub OIDC provider.
2. Restate Cloud, the wren env: Developers > API keys > a **Full** key
   (`RESTATE_AUTH_TOKEN`); the env id (`RESTATE_ENVIRONMENT_ID`, `env_…`);
   the request-identity key: `restate cloud login`, then
   `deploy/scripts/identity-key.py --env >> deploy/prod.env` (or copy it from
   Developers > Security).
3. `cp deploy/prod.env.example deploy/prod.env`, fill it, `pnpm autobrowse env push --from deploy/prod.env`.
   `UI_TOKEN` is required. Site credentials go in as `AUTOBROWSE_CRED_<SITE>_*`:
   `pnpm autobrowse creds push <site>` copies one from this Mac's sealed store
   (`CREDENTIALS_CIPHER=none` on the box: no Keychain on Linux).
4. GitHub, repo settings: secrets `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`,
   `INSTANCE_ID` from `tofu output`; an environment named `production`;
   variable `DEPLOY_ENABLED=true`. Until the variable is set, the deploy
   workflow is a no-op, so main can keep moving before the box exists.
5. Push main (or run `deploy` by hand). The box pulls the image, reads the
   env, starts the worker; the worker dials the tunnel and registers itself.

## `aws login` without a person

The AWS sign-in page is a known site (`aws`): `autobrowse creds set aws` with
the root email or `<account>/<iam user>`, the console password and the MFA
seed. Then `aws login --remote` prints a URL; an explore session on it with
site `aws` signs in and allows the CLI. Restate Cloud's device login was done
this way on 2026-09-21 (Google button, stored `google` credential).

## Idle stop

`IDLE_STOP_MINUTES=30` (env store) and the worker stops its own instance once
nothing has needed it for that long: no flow or site call running, no agent
session mid-goal, no run event, no write to the UI API (reads never count:
an open tab does not keep the box up), and nothing queued for its services
in Restate (`sys_invocation` over the admin API: a call that arrived while
the box was booting counts before it reaches the worker; a run suspended on
a person does not, it resumes from the journal next boot). A person's box (`box.sh start` by
hand, tag `person`) is never stopped; a deploy's or a caller's is, and the
tag is cleared like `box.sh stop`. The worker learns its instance id over
IMDSv2 (`AUTOBROWSE_INSTANCE_ID` overrides). Terraform gives the instance
role `ec2:StopInstances` + `DeleteTags` on itself and sets the IMDS hop
limit to 2 so the container can reach metadata. A stop that is refused
(no policy yet, off EC2) is one warn line and the span restarts.

Waking is the caller's: wren's worker starts the instance (tag `wren`)
before its first `sites` call and Restate holds the call until the tunnel
is back (~1–2 min). Anyone else: `box.sh start`. A Content call then costs
minutes of box time, not a day. Without `IDLE_STOP_MINUTES` the box stays
up after a deploy until `box.sh stop` (or `release`).

## Two things the deploy script guards (2026-09-22)

- **Disk.** Every deploy pulled a new 2.6 GB image and pruned only dangling ones; 61
  tagged images filled the 16 GB root and the pull died with "no space left on
  device". The script now removes every `autobrowse-prod` image but the running one
  before it pulls.
- **`$` in a secret.** Compose interpolates `$VAR` inside `env_file` values, so a
  password holding `$Eo…` reached the container truncated (compose warned
  `The "EoyB" variable is not set`). The script writes `$$` for every `$`, which
  compose turns back into one.

## After

- UI: the `ui_forward` output, then `http://localhost:9080` with the token.
- Shell: `aws ssm start-session --target <instance_id>`; logs with
  `docker logs -f autobrowse-worker-1`.
- Secrets changed: `pnpm autobrowse env push NAME…` (from `.env`) or
  `--from deploy/prod.env`, then redeploy (push, or
  `aws ssm send-command … autobrowse-deploy`). `pnpm autobrowse env ls|get|pull`
  reads them back on any machine with AWS access.
  A site token minted on the laptop needs no redeploy: the box reads SSM on
  its first "no token" miss.
- Recordings are made on a laptop; copy the directory to `/data/recordings`
  (`aws ssm` port forward + `scp` through it, or S3) and compile from the UI.
- Passkeys cannot ride in env. A site whose credential holds one (google-admin)
  needs the credentials file on the box: `autobrowse creds export` on the
  laptop is not a thing yet, so decrypt with `CREDENTIALS_CIPHER=none`
  semantics by hand and copy to `/data/credentials.json`, then set
  `CREDENTIALS_FILE=/data/credentials.json` in prod.env. Until then the
  password + TOTP path signs in.
- Persistent browser profiles live in `/data/profiles`: one worker, one box.
  `BROWSER=browserbase` moves the browser out and lets the box shrink.
