/**
 * Register the desk with wren's self-hosted Restate server. Its admin API listens on the
 * box's loopback only, so the POST runs there over SSM (the way wren's CI reaches it).
 * The server calls the desk back through the box's Cloudflare hop (wren
 * deploy/scripts/box-restate.sh), so the URL it is given is that hop on its loopback.
 */
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { AwsConfig } from "../owner.js";

/** The desk as the box's Restate server dials it: the cloudflared hop, not the Mac. */
export const DESK_ON_BOX = "http://127.0.0.1:9082";
const BOX_NAME = "wren-prod-pg";

export async function registerOnBox(
  aws: AwsConfig,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<{ id: string; services: string[] }> {
  const found = await new EC2Client(aws).send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [BOX_NAME] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }),
  );
  const box = found.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (!box) throw new Error(`no running ${BOX_NAME} to register the desk with`);
  const ssm = new SSMClient(aws);
  const body = JSON.stringify({ uri: DESK_ON_BOX, force: true });
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [box],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          `curl -sf -X POST http://127.0.0.1:9070/deployments -H 'content-type: application/json' -d '${body}'`,
        ],
      },
    }),
  );
  const CommandId = sent.Command?.CommandId;
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const r = await ssm
      .send(new GetCommandInvocationCommand({ CommandId, InstanceId: box }))
      .catch(() => null); // InvocationDoesNotExist for the first moment
    if (!r || r.Status === "Pending" || r.Status === "InProgress" || r.Status === "Delayed")
      continue;
    if (r.Status !== "Success")
      throw new Error(`desk register on box: ${r.Status} ${r.StandardErrorContent ?? ""}`);
    return parseRegistered(r.StandardOutputContent ?? "");
  }
  throw new Error("desk register on box: no answer in 2 minutes");
}

export function parseRegistered(out: string): { id: string; services: string[] } {
  const r = JSON.parse(out) as { id: string; services: Array<{ name: string }> };
  return { id: r.id, services: r.services.map((s) => s.name) };
}
