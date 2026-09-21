# 9 · The box: deploy, idle-stop, wake

**Goal:** prod on one EC2 box behind Restate Cloud, off when nothing needs
it, up within two minutes when something does.

## Shape

- One t3.medium, the worker container from ECR, `/data` (profiles,
  recordings, credentials) on its own volume, secrets in SSM, **no inbound
  port**. Restate Cloud reaches the worker through the tunnel the worker
  dials; you reach the UI through SSM port forwarding.
- Every push to `main` deploys (`.github/workflows/deploy.yml`): the box is
  started, pulls the image, reads the env store, starts the worker; the
  worker registers itself with Restate Cloud.
- `IDLE_STOP_MINUTES=30`: the worker stops its own instance once nothing has
  needed it (no flow, site call, agent session, run event or UI write, and
  nothing queued for it in Restate). Before stopping it sends the session's
  ledger summary (guide 1).
- Waking: wren starts the instance before a `sites` call and Restate holds
  the call until the tunnel is back. By hand: `deploy/scripts/box.sh start`
  — a person's box is never stopped by the worker; `box.sh stop` ends it.

```sh
deploy/scripts/box.sh status
deploy/scripts/box.sh start          # boot + wait for SSM; worker up in ~1 min; tagged person
deploy/scripts/box.sh stop
```

## Reach it

```sh
cd deploy/terraform && tofu output ui_forward     # the SSM port-forward command
open http://localhost:9080                        # with UI_TOKEN
aws ssm start-session --target <instance_id>      # a shell
docker logs -f autobrowse-worker-1
```

## Change a secret

```sh
pnpm autobrowse env push NAME                     # from .env
pnpm autobrowse env push --from deploy/prod.env
git push                                          # or: aws ssm send-command … autobrowse-deploy
```

## First time

`deploy/README.md` "Once": `tofu apply` (reads wren's OIDC provider), the
Restate Cloud keys, `deploy/prod.env` pushed to the store, the four GitHub
secrets/variables (`DEPLOY_ENABLED=true` turns the workflow on).

## Runs that outlive the box

Every durable run is a Restate object; a stop mid-run is a resume from the
journal on the next boot. A run waiting on a person (`human`, `purchase`)
costs no box time.
