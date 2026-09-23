/**
 * The one file that names the bucket vendor. S3 by default; any S3-compatible
 * store (Cloudflare R2) by `endpoint`, with its keys in the usual AWS names.
 */
import type { BlobStore } from "./ship.js";

export function s3BlobStore(o: { bucket: string; region: string; endpoint?: string }): BlobStore {
  // The SDK loads on the first put, not at every CLI start.
  const client = import("@aws-sdk/client-s3").then(({ S3Client, PutObjectCommand }) => ({
    s3: new S3Client({
      region: o.endpoint ? "auto" : o.region,
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
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
