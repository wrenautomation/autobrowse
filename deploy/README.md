# autobrowse on AWS

One t3.medium box, the worker container from ECR, `/data` on its own volume,
secrets in SSM, no inbound port. Restate Cloud reaches the worker through the
tunnel the worker dials; you reach the UI through SSM port forwarding. The box is
**stopped between jobs**: a stopped instance bills nothing, the volume ~$2/month.
Running it is ~$1/day (t3.medium). `deploy/scripts/box.sh start|stop|release|status`.
A deploy starts it, ships, and releases it: stopped again unless a person started it
(the `autobrowse:started-by` instance tag; `box.sh start` by hand sets `person`).

## Once

1. `aws login` (same account and region as wren). `cd deploy/terraform && tofu init && tofu apply`.
   wren's terraform must already be applied: this reads its GitHub OIDC provider.
2. Restate Cloud, the wren env: Developers > API keys > a **Full** key
   (`RESTATE_AUTH_TOKEN`); the env id (`RESTATE_ENVIRONMENT_ID`, `env_…`);
   the request-identity key: `restate cloud login`, then
   `deploy/scripts/identity-key.py --env >> deploy/prod.env` (or copy it from
   Developers > Security).
3. `cp deploy/prod.env.example deploy/prod.env`, fill it, `pnpm autobrowse env push --from deploy/prod.env`.
   `UI_TOKEN` is required. Site credentials go in as `AUTOBROWSE_CRED_<SITE>_*`
   (`CREDENTIALS_CIPHER=none`: no Keychain on Linux).
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

## After

- UI: the `ui_forward` output, then `http://localhost:9080` with the token.
- Shell: `aws ssm start-session --target <instance_id>`; logs with
  `docker logs -f autobrowse-worker-1`.
- Secrets changed: `pnpm autobrowse env push NAME…` (from `.env`) or
  `--from deploy/prod.env`, then redeploy (push, or
  `aws ssm send-command … autobrowse-deploy`). `pnpm autobrowse env ls|get|pull`
  reads them back on any machine with AWS access.
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
