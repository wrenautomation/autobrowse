#!/usr/bin/env bash
# The worker box on demand: a stopped instance bills nothing but its volume.
#   box.sh start     boot it and wait until SSM can reach it (then the worker is up in ~1 min)
#   box.sh stop      shut it down; flows resume from Restate's journal on the next start
#   box.sh release   stop it unless a person started it (by hand; a deploy leaves the stop to the worker's idle stop)
#   box.sh status
# Who started it is an instance tag (autobrowse:started-by = person|deploy), set on
# a start from stopped and cleared on stop: the worker's idle stop and `release` end
# a deploy's or a caller's box, never one a person booted. BOX_STARTED_BY=deploy in CI.
set -euo pipefail
ID="${AUTOBROWSE_INSTANCE_ID:-$(cd "$(dirname "$0")/../terraform" && tofu output -raw instance_id)}"
TAG="autobrowse:started-by"
state() {
  aws ec2 describe-instances --instance-ids "$ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}
started_by() {
  aws ec2 describe-instances --instance-ids "$ID" \
    --query "Reservations[0].Instances[0].Tags[?Key=='$TAG'].Value | [0]" --output text
}
stop() {
  aws ec2 stop-instances --instance-ids "$ID" >/dev/null
  aws ec2 delete-tags --resources "$ID" --tags "Key=$TAG" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$ID"
  echo "$ID stopped"
}
case "${1:-status}" in
  start)
    if [ "$(state)" = "stopped" ]; then
      aws ec2 create-tags --resources "$ID" --tags "Key=$TAG,Value=${BOX_STARTED_BY:-person}" >/dev/null
    fi
    aws ec2 start-instances --instance-ids "$ID" >/dev/null
    aws ec2 wait instance-running --instance-ids "$ID"
    for _ in $(seq 1 30); do
      s="$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$ID" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
      [ "$s" = "Online" ] && { echo "$ID online"; exit 0; }
      sleep 5
    done
    echo "$ID running but SSM not online yet" >&2; exit 1 ;;
  stop) stop ;;
  release)
    by="$(started_by)"
    if [ "$by" = "person" ]; then echo "$ID left running: a person started it"; exit 0; fi
    [ "$(state)" = "stopped" ] && { echo "$ID already stopped"; exit 0; }
    stop ;;
  status) state ;;
  *) echo "usage: box.sh start|stop|release|status" >&2; exit 2 ;;
esac
