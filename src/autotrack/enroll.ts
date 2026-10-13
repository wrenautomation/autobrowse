/**
 * Enrolling a device: IAM user `track-<device>` (path /track/) whose only right is `s3:PutObject`
 * on `<bucket>/<device>/*`, plus one access key. A lost laptop leaks nothing: the key reads
 * nothing and writes only its own prefix. Idempotent: enrolling again rotates the key.
 */
import { checkDevice, encodeCode, type TrackCode } from "./code.js";

export const TRACK_PATH = "/track/";
export const POLICY_NAME = "track-put";
export const userName = (device: string) => `track-${device}`;

/** The IAM calls enroll needs; `iamClient` is the real one, tests pass a fake. */
export interface Iam {
  userExists(name: string): Promise<boolean>;
  createUser(name: string, path: string): Promise<void>;
  putUserPolicy(user: string, policy: string, document: string): Promise<void>;
  listAccessKeys(user: string): Promise<string[]>;
  createAccessKey(user: string): Promise<{ keyId: string; secret: string }>;
  deleteAccessKey(user: string, keyId: string): Promise<void>;
  deleteUserPolicy(user: string, policy: string): Promise<void>;
  deleteUser(name: string): Promise<void>;
  /** Users under a path, with their key count. */
  listUsers(path: string): Promise<{ name: string; created: string; keys: number }[]>;
}

export function putOnlyPolicy(bucket: string, device: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${bucket}/${device}/*`,
      },
    ],
  });
}

export async function enroll(
  iam: Iam,
  o: { bucket: string; region: string; device: string },
): Promise<{ code: string; payload: TrackCode; rotated: number }> {
  const device = checkDevice(o.device);
  const user = userName(device);
  if (!(await iam.userExists(user))) await iam.createUser(user, TRACK_PATH);
  await iam.putUserPolicy(user, POLICY_NAME, putOnlyPolicy(o.bucket, device));
  // A user holds two keys at most, and a re-enrolled device must not keep the old one alive.
  const old = await iam.listAccessKeys(user);
  for (const id of old) await iam.deleteAccessKey(user, id);
  const key = await iam.createAccessKey(user);
  const payload: TrackCode = {
    v: 1,
    bucket: o.bucket,
    region: o.region,
    device,
    keyId: key.keyId,
    secret: key.secret,
  };
  return { code: encodeCode(payload), payload, rotated: old.length };
}

/** Keys, then the policy, then the user: IAM refuses to delete a user that still has any. */
export async function revoke(iam: Iam, deviceName: string): Promise<boolean> {
  const user = userName(checkDevice(deviceName));
  if (!(await iam.userExists(user))) return false;
  for (const id of await iam.listAccessKeys(user)) await iam.deleteAccessKey(user, id);
  await iam.deleteUserPolicy(user, POLICY_NAME);
  await iam.deleteUser(user);
  return true;
}

export async function devices(iam: Iam) {
  const users = await iam.listUsers(TRACK_PATH);
  return users
    .filter((u) => u.name.startsWith("track-"))
    .map((u) => ({ device: u.name.slice("track-".length), created: u.created, keys: u.keys }));
}
