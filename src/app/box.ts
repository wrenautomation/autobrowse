/**
 * The machine this worker runs on, when it is an EC2 instance: stop it from
 * the inside. Mirrors deploy/scripts/box.sh: the `autobrowse:started-by` tag
 * says who booted it; `person` means someone is at the keyboard and the box
 * stays up; any other start (a deploy, a caller waking it) is ours to end,
 * and the tag is cleared on the way down.
 */
import {
  DeleteTagsCommand,
  DescribeInstancesCommand,
  type EC2Client,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";

export const STARTED_BY_TAG = "autobrowse:started-by";

export interface Ec2Port {
  startedBy(id: string): Promise<string | null>;
  stop(id: string): Promise<void>;
}

export function ec2Port(client: EC2Client): Ec2Port {
  return {
    async startedBy(id) {
      const out = await client.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
      const tags = out.Reservations?.[0]?.Instances?.[0]?.Tags ?? [];
      return tags.find((t) => t.Key === STARTED_BY_TAG)?.Value ?? null;
    },
    async stop(id) {
      await client.send(
        new DeleteTagsCommand({ Resources: [id], Tags: [{ Key: STARTED_BY_TAG }] }),
      );
      await client.send(new StopInstancesCommand({ InstanceIds: [id] }));
    },
  };
}

/** IMDSv2: the instance id of the machine we are on, or null off EC2 (or past the hop limit). */
export async function instanceIdFromMetadata(
  fetchFn: typeof fetch = fetch,
  base = "http://169.254.169.254",
): Promise<string | null> {
  try {
    const tok = await fetchFn(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!tok.ok) return null;
    const res = await fetchFn(`${base}/latest/meta-data/instance-id`, {
      headers: { "X-aws-ec2-metadata-token": await tok.text() },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const id = (await res.text()).trim();
    return /^i-[0-9a-f]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Stop this machine unless a person started it. Returns false when it
 * stays up (a person's, or not on EC2). Once EC2 accepts the stop the OS
 * halts within a minute; the caller need not exit.
 */
export function selfStopper(o: {
  ec2: Ec2Port;
  instanceId: () => Promise<string | null>;
}): () => Promise<boolean> {
  return async () => {
    const id = await o.instanceId();
    if (!id) return false;
    if ((await o.ec2.startedBy(id)) === "person") return false;
    await o.ec2.stop(id);
    return true;
  };
}
