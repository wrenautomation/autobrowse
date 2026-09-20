#!/usr/bin/env bash
# The worker box on demand: a stopped instance bills nothing but its volume.
#   box.sh start   boot it and wait until SSM can reach it (then the worker is up in ~1 min)
#   box.sh stop    shut it down; flows resume from Restate's journal on the next start
#   box.sh status
set -euo pipefail
ID="${AUTOBROWSE_INSTANCE_ID:-$(cd "$(dirname "$0")/../terraform" && tofu output -raw instance_id)}"
case "${1:-status}" in
  start)
    aws ec2 start-instances --instance-ids "$ID" >/dev/null
    aws ec2 wait instance-running --instance-ids "$ID"
    for _ in $(seq 1 30); do
      s="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$ID" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
      [ "$s" = "Online" ] && { echo "$ID online"; exit 0; }
      sleep 5
    done
    echo "$ID running but SSM not online yet" >&2; exit 1 ;;
  stop)
    aws ec2 stop-instances --instance-ids "$ID" >/dev/null
    aws ec2 wait instance-stopped --instance-ids "$ID"
    echo "$ID stopped" ;;
  status)
    aws ec2 describe-instances --instance-ids "$ID" \
      --query 'Reservations[0].Instances[0].State.Name' --output text ;;
  *) echo "usage: box.sh start|stop|status" >&2; exit 2 ;;
esac
