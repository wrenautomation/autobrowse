#!/bin/bash
# First boot of the worker box (Amazon Linux 2023, x86). Idempotent: cloud-init
# runs this once; a rebuilt instance finds the data volume initialised and
# mounts it as is. Installs Docker, mounts /data, drops the deploy script CI
# calls, and runs it once so the box comes up on its own.
set -euxo pipefail
exec > >(tee /var/log/autobrowse-user-data.log) 2>&1

dnf install -y docker python3
systemctl enable --now docker
# docker compose v2 as a CLI plugin (AL2023 ships only the engine).
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# The data volume, by id so the device name never matters.
DEV="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volume_id}"
DEV="$${DEV/vol-/vol}"
until [ -e "$DEV" ]; do sleep 2; done
blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -L abdata "$DEV"
mkdir -p /data
grep -q abdata /etc/fstab || echo "LABEL=abdata /data ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /data || mount /data
# The image runs as pwuser (uid 1000); the state dirs are its.
mkdir -p /data/profiles /data/artifacts /data/recordings /data/env
chown -R 1000:1000 /data/profiles /data/artifacts /data/recordings
chmod 700 /data/env

mkdir -p /opt/autobrowse
cat > /opt/autobrowse/compose.yml <<'COMPOSE'
${compose}
COMPOSE

# What CI runs after every push to main (and what this boot runs once):
# fresh env from SSM, pull the image, restart the worker.
cat > /usr/local/bin/autobrowse-deploy <<'DEPLOY'
#!/bin/bash
set -euo pipefail
cd /opt/autobrowse
export ECR_IMAGE="${ecr}:$${1:-latest}"
aws ecr get-login-password --region ${region} \
  | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com >/dev/null
# SSM holds one JSON object; the container wants KEY=VALUE lines. Never echoed.
aws ssm get-parameter --region ${region} --name "${env_param}" --with-decryption \
  --query Parameter.Value --output text \
  | python3 -c 'import json,sys,os
# A multi-line value (a service-account JSON) cannot live in an env file:
# it goes to its own 0600 file and the variable names the path.
for k, v in json.load(sys.stdin).items():
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
echo "deployed $ECR_IMAGE"
DEPLOY
chmod +x /usr/local/bin/autobrowse-deploy

# The first boot may run before any image was pushed; that is fine, CI's first
# deploy brings the worker up.
/usr/local/bin/autobrowse-deploy || echo "no image yet; CI deploys the first one"
