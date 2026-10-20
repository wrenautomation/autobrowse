/**
 * The one file that names the bucket vendor. S3 by default; any S3-compatible
 * store (Cloudflare R2) by `endpoint`, with its keys in the usual AWS names.
 */
import type { AwsConfig } from "../owner.js";
import type { BlobStore } from "./ship.js";

export function s3BlobStore(o: { bucket: string; aws: AwsConfig; endpoint?: string }): BlobStore {
  // The SDK loads on the first put, not at every CLI start.
  const client = import("@aws-sdk/client-s3").then(({ S3Client, PutObjectCommand }) => ({
    s3: new S3Client({
      ...o.aws,
      ...(o.endpoint ? { region: "auto", endpoint: o.endpoint } : {}),
    }),
    PutObjectCommand,
  }));
  return {
    async put(key, body, contentType) {
      const { s3, PutObjectCommand } = await client;
      await s3.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
  };
}

/**
 * The files bucket (files/store.ts `FileBucket`): put, get, list, delete under one prefix,
 * the record in `x-amz-meta-record`. Only William's own AWS user may call it (papers.tf).
 */
export function s3FileBucket(o: { bucket: string; aws: AwsConfig }) {
  const client = import("@aws-sdk/client-s3").then((sdk) => ({ s3: new sdk.S3Client(o.aws), sdk }));
  return {
    async put(key: string, data: Buffer, meta: string) {
      const { s3, sdk } = await client;
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: data,
          Metadata: { record: meta },
        }),
      );
    },
    async get(key: string) {
      const { s3, sdk } = await client;
      try {
        const got = await s3.send(new sdk.GetObjectCommand({ Bucket: o.bucket, Key: key }));
        const meta = got.Metadata?.record;
        if (!got.Body || !meta) return null;
        return { data: Buffer.from(await got.Body.transformToByteArray()), meta };
      } catch (err) {
        if ((err as Error).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async keys(prefix: string) {
      const { s3, sdk } = await client;
      const out: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new sdk.ListObjectsV2Command({
            Bucket: o.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const c of page.Contents ?? []) if (c.Key) out.push(c.Key);
        token = page.NextContinuationToken;
      } while (token);
      return out;
    },
    async remove(key: string) {
      const { s3, sdk } = await client;
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
    },
  };
}
