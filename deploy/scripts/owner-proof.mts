/**
 * Live proof of designs/2026-09-30-owner-keys.md: what an owner's AWS
 * session may and may not touch. Writes a probe value and two probe objects,
 * checks each rule, then removes them. Prints outcomes and error names only
 * (an AccessDenied message carries the account id).
 *
 *   AUTOBROWSE_OWNER_ROLE_ARN=$(cd deploy/terraform && tofu output -raw owner_role_arn) \
 *     pnpm -s tsx deploy/scripts/owner-proof.mts
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { loadEnvFile, loadSettings } from "../../src/app/config.ts";
import { awsConfig, ownerKeys } from "../../src/owner.ts";

const OWNER = "ownerproof";
const OTHER = "ownerother";

loadEnvFile();
const s = loadSettings();
const bucket = s.shotsBucket;
const role = process.env.AUTOBROWSE_OWNER_ROLE_ARN;
if (!bucket || !role) throw new Error("needs SHOTS_BUCKET and AUTOBROWSE_OWNER_ROLE_ARN");
const own = awsConfig({ owner: OWNER, ownerRoleArn: role, region: s.awsRegion });
const ssm = new SSMClient(own);
const s3 = new S3Client(own);
const operatorS3 = new S3Client({ region: s.awsRegion });
const mine = ownerKeys(OWNER);
const theirs = ownerKeys(OTHER);
const probe = `${mine.ssm}/PROBE`;

let failed = 0;
async function check(label: string, want: "ok" | "denied", run: () => Promise<unknown>) {
  let got = "ok";
  try {
    await run();
  } catch (e) {
    got = (e as Error).name;
  }
  const pass = want === "ok" ? got === "ok" : /AccessDenied/.test(got);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${got}`);
}
const read = (Name: string) => () =>
  ssm.send(new GetParameterCommand({ Name, WithDecryption: false }));
const put = (Key: string) => () =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: "probe" }));
const get = (Key: string) => () => s3.send(new GetObjectCommand({ Bucket: bucket, Key }));

// Targets the owner must not read exist first: without s3:ListBucket a missing key is a 403 too.
const operatorInput = "inputs/owner-proof-probe.txt";
const otherInput = `${theirs.inputs}probe.txt`;
for (const Key of [operatorInput, otherInput])
  await operatorS3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: "probe" }));

await check("own env store write", "ok", () =>
  ssm.send(
    new PutParameterCommand({ Name: probe, Value: "probe", Type: "SecureString", Overwrite: true }),
  ),
);
await check("own env store read", "ok", read(probe));
await check("operator's env store read", "denied", read("/autobrowse/config/SHOTS_BUCKET"));
await check("another owner's env store read", "denied", read(`${theirs.ssm}/PROBE`));
await check("wallet read", "denied", read("/wallet/cards"));
await check("own shots write", "ok", put(`${mine.shots}probe.txt`));
await check("own shots read (ship only)", "denied", get(`${mine.shots}probe.txt`));
await check("bucket root write", "denied", put("probe.txt"));
await check("another owner's shots write", "denied", put(`${theirs.shots}probe.txt`));
await check("own inputs write", "ok", put(`${mine.inputs}probe.txt`));
await check("own inputs read", "ok", get(`${mine.inputs}probe.txt`));
await check("operator's inputs read", "denied", get(operatorInput));
await check("another owner's inputs read", "denied", get(otherInput));
await check("own env store delete", "ok", () =>
  ssm.send(new DeleteParameterCommand({ Name: probe })),
);
// Owners never delete objects; the operator clears the probes.
for (const Key of [`${mine.shots}probe.txt`, `${mine.inputs}probe.txt`, operatorInput, otherInput])
  await operatorS3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
console.log(failed ? `${failed} failed` : "all held; probes removed");
process.exitCode = failed ? 1 : 0;
