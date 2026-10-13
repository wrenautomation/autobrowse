/** The real IAM client behind `Iam` (src/track/enroll.ts): William's own AWS user, never a machine role. */
import type { AwsConfig } from "../owner.js";
import type { Iam } from "./enroll.js";

export function iamClient(aws: AwsConfig): Iam {
  // The SDK loads on the first call, not at every CLI start.
  const sdk = import("@aws-sdk/client-iam").then((m) => ({ m, c: new m.IAMClient(aws) }));
  return {
    async userExists(name) {
      const { m, c } = await sdk;
      try {
        await c.send(new m.GetUserCommand({ UserName: name }));
        return true;
      } catch (err) {
        if ((err as Error).name === "NoSuchEntityException") return false;
        throw err;
      }
    },
    async createUser(name, path) {
      const { m, c } = await sdk;
      await c.send(new m.CreateUserCommand({ UserName: name, Path: path }));
    },
    async putUserPolicy(user, policy, document) {
      const { m, c } = await sdk;
      await c.send(
        new m.PutUserPolicyCommand({
          UserName: user,
          PolicyName: policy,
          PolicyDocument: document,
        }),
      );
    },
    async listAccessKeys(user) {
      const { m, c } = await sdk;
      const r = await c.send(new m.ListAccessKeysCommand({ UserName: user }));
      return (r.AccessKeyMetadata ?? []).flatMap((k) => (k.AccessKeyId ? [k.AccessKeyId] : []));
    },
    async createAccessKey(user) {
      const { m, c } = await sdk;
      const r = await c.send(new m.CreateAccessKeyCommand({ UserName: user }));
      const k = r.AccessKey;
      if (!k?.AccessKeyId || !k.SecretAccessKey) throw new Error("IAM returned no access key");
      return { keyId: k.AccessKeyId, secret: k.SecretAccessKey };
    },
    async deleteAccessKey(user, keyId) {
      const { m, c } = await sdk;
      await c.send(new m.DeleteAccessKeyCommand({ UserName: user, AccessKeyId: keyId }));
    },
    async deleteUserPolicy(user, policy) {
      const { m, c } = await sdk;
      try {
        await c.send(new m.DeleteUserPolicyCommand({ UserName: user, PolicyName: policy }));
      } catch (err) {
        if ((err as Error).name !== "NoSuchEntityException") throw err;
      }
    },
    async deleteUser(name) {
      const { m, c } = await sdk;
      await c.send(new m.DeleteUserCommand({ UserName: name }));
    },
    async listUsers(path) {
      const { m, c } = await sdk;
      const out: { name: string; created: string; keys: number }[] = [];
      let marker: string | undefined;
      do {
        const page = await c.send(new m.ListUsersCommand({ PathPrefix: path, Marker: marker }));
        for (const u of page.Users ?? []) {
          if (!u.UserName) continue;
          const keys = await c.send(new m.ListAccessKeysCommand({ UserName: u.UserName }));
          out.push({
            name: u.UserName,
            created: u.CreateDate?.toISOString() ?? "",
            keys: keys.AccessKeyMetadata?.length ?? 0,
          });
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return out;
    },
  };
}
