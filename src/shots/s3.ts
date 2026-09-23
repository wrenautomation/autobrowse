/**
 * The one file that names the bucket vendor. S3 by default; any S3-compatible
 * store (Cloudflare R2) by `endpoint`, with its keys in the usual AWS names.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { BlobStore } from "./ship.js";

export function s3BlobStore(o: { bucket: string; region: string; endpoint?: string }): BlobStore {
  const s3 = new S3Client({
    region: o.endpoint ? "auto" : o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
  });
  return {
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
  };
}
