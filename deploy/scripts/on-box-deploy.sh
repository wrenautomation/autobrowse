#!/bin/bash
# Runs ON THE BOX as /usr/local/bin/autobrowse-deploy <image tag>. CI ships this
# file before each run (so edits here land without a rebuild); first boot
# installs it too. Fresh env from the store, pull the image, restart the worker.
# Never echoes a value.
set -euo pipefail
cd /opt/autobrowse
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/placement/region)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
export ECR_IMAGE="$ECR/autobrowse-prod:${1:-latest}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR" >/dev/null
# The store: one SecureString per name under /autobrowse/config. The container wants KEY=VALUE lines;
# a multi-line value (a service-account JSON) goes to its own 0600 file and the variable names the path.
aws ssm get-parameters-by-path --region "$REGION" --path /autobrowse/config --with-decryption \
  --query 'Parameters[].[Name,Value]' --output json \
  | python3 -c 'import json,sys,os
for name, v in json.load(sys.stdin):
    k = name.rsplit("/", 1)[1]
    if "\n" in v or v.lstrip().startswith("{"):
        path = f"/data/env/{k.lower()}.json"
        with open(path, "w") as f: f.write(v)
        os.chmod(path, 0o600); os.chown(path, 1000, 1000)
        v = path
    print(f"{k}={v}")' > /data/env/.env.tmp
chmod 600 /data/env/.env.tmp
mv /data/env/.env.tmp /data/env/.env
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
echo "deployed $ECR_IMAGE with $(grep -c . /data/env/.env) env keys"
