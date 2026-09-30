/**
 * Files a run needs, on whichever machine runs it. `autobrowse run` hands a
 * plan to Restate, and the prod box runs it: a path on this Mac means
 * nothing there. So the CLI ships each local file the plan names to the
 * `inputs/` prefix of the shots bucket (`inputs/owners/<owner>/` for an
 * owner, src/owner.ts) and puts an `s3://` ref in its place. The box may
 * read only its prefix, and objects there expire after a week
 * (deploy/terraform/shots.tf): it sees the files a plan named, nothing else.
 * The upload act turns a ref (or a signed https URL) back into a temp file.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type AwsConfig, awsConfigFromEnv, DEFAULT_OWNER, ownerKeys } from "../owner.js";

export const INPUTS_PREFIX = ownerKeys(DEFAULT_OWNER).inputs;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
};

const looksLikePath = (s: string) => /^(\/|~\/|\.\.?\/)/.test(s) && !s.includes("\n");
const expand = (s: string) => (s.startsWith("~/") ? join(homedir(), s.slice(2)) : resolve(s));

export interface InputStore {
  /** Store the file under `key` (streamed: a video never sits in memory); the ref the box reads it back by. */
  put(key: string, path: string, size: number, contentType: string): Promise<string>;
}

/**
 * Every string in the plan that names a file on this machine, shipped and
 * swapped for its ref. Keys are content hashes, so the same file ships once.
 */
export async function shipPlanFiles(
  plan: unknown,
  store: InputStore,
  prefix: string = INPUTS_PREFIX,
): Promise<{ plan: unknown; shipped: string[] }> {
  const shipped: string[] = [];
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") {
      if (!looksLikePath(v)) return v;
      const path = expand(v);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) return v;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      const ext = extname(path).toLowerCase();
      const key = `${prefix}${hash.digest("hex").slice(0, 24)}${ext}`;
      shipped.push(v);
      return store.put(key, path, st.size, TYPES[ext] ?? "application/octet-stream");
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    }
    return v;
  };
  return { plan: await walk(plan), shipped };
}

export interface RemoteReaders {
  /** An `s3://bucket/key` ref as a byte stream. */
  s3?: (bucket: string, key: string) => Promise<ReadableStream<Uint8Array>>;
  fetch?: typeof fetch;
}

const s3Read = async (bucket: string, key: string) => {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  // The worker's owner reads with its own session: the box role may not read another owner's inputs.
  const s3 = new S3Client({ ...awsConfigFromEnv(), followRegionRedirects: true });
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!got.Body) throw new Error(`s3://${bucket}/${key}: empty`);
  return got.Body.transformToWebStream() as ReadableStream<Uint8Array>;
};

/**
 * Local paths for the files an upload names: a path stays as is, an
 * `s3://` ref or an https URL is fetched to a temp dir that `done` removes.
 * A URL is never put in an error: a signed one is a bearer.
 */
export async function localCopies(
  files: readonly string[],
  r: RemoteReaders = {},
): Promise<{ paths: string[]; done: () => Promise<void> }> {
  if (!files.some((f) => /^(s3|https?):\/\//i.test(f)))
    return { paths: [...files], done: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "run-files-"));
  const done = () => rm(dir, { recursive: true, force: true });
  try {
    const paths = await Promise.all(
      files.map(async (f, i) => {
        const s3 = f.match(/^s3:\/\/([^/]+)\/(.+)$/);
        const http = /^https?:\/\//i.test(f);
        if (!s3 && !http) return f;
        let body: ReadableStream<Uint8Array>;
        let ext: string;
        if (s3) {
          body = await (r.s3 ?? s3Read)(s3[1] as string, s3[2] as string);
          ext = extname(s3[2] as string);
        } else {
          const res = await (r.fetch ?? fetch)(f);
          if (!res.ok || !res.body)
            throw new Error(`file ${i + 1}: the URL answered ${res.status}`);
          body = res.body;
          ext = extname(new URL(f).pathname);
        }
        const path = join(dir, `file-${i}${ext.toLowerCase()}`);
        await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
        return path;
      }),
    );
    return { paths, done };
  } catch (err) {
    await done();
    throw err;
  }
}

/** The shots bucket as the input store: refs are `s3://<bucket>/inputs/…`. */
export function s3InputStore(bucket: string, aws: AwsConfig): InputStore {
  const client = import("@aws-sdk/client-s3").then(({ S3Client, PutObjectCommand }) => ({
    s3: new S3Client(aws),
    PutObjectCommand,
  }));
  return {
    async put(key, path, size, contentType) {
      const { s3, PutObjectCommand } = await client;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return `s3://${bucket}/${key}`;
    },
  };
}
