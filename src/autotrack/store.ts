/**
 * Reading the track bucket (deploy/terraform track.tf). Layout, written by `autotrack ship`:
 *   <device>/<session>/session.json
 *   <device>/<session>/<segment>/events.jsonl.gz
 *   <device>/<session>/<segment>/frames/<n>.jpg      (n = frame number in the session)
 * Only William's AWS user lists and reads; a device's own key can only put.
 */
import type { AwsConfig } from "../owner.js";

export interface TrackObject {
  key: string;
  size: number;
}

export interface TrackStore {
  list(prefix: string): Promise<TrackObject[]>;
  get(key: string): Promise<Buffer>;
}

/** William's user can also write the labels (`labels/<device>/<session>.json`); a device's key never does. */
export interface TrackWriter extends TrackStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

export function s3TrackStore(o: { bucket: string; aws: AwsConfig }): TrackWriter {
  const client = import("@aws-sdk/client-s3").then((sdk) => ({ s3: new sdk.S3Client(o.aws), sdk }));
  return {
    async list(prefix) {
      const { s3, sdk } = await client;
      const out: TrackObject[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new sdk.ListObjectsV2Command({
            Bucket: o.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const c of page.Contents ?? []) if (c.Key) out.push({ key: c.Key, size: c.Size ?? 0 });
        token = page.NextContinuationToken;
      } while (token);
      return out;
    },
    async get(key) {
      const { s3, sdk } = await client;
      const got = await s3.send(new sdk.GetObjectCommand({ Bucket: o.bucket, Key: key }));
      if (!got.Body) throw new Error(`${key}: empty body`);
      return Buffer.from(await got.Body.transformToByteArray());
    },
    async put(key, body, contentType = "application/json") {
      const { s3, sdk } = await client;
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}

export interface SessionRow {
  device: string;
  session: string;
  segments: number;
  frames: number;
  bytes: number;
}

export type ParsedKey =
  | { device: string; session: string; kind: "meta" }
  | { device: string; session: string; kind: "events"; segment: string }
  | { device: string; session: string; kind: "frame"; segment: string; frame: number };

export function parseKey(key: string): ParsedKey | null {
  const p = key.split("/");
  const [device, session, third, fourth, fifth] = p;
  if (!device || !session) return null;
  if (p.length === 3 && third === "session.json") return { device, session, kind: "meta" };
  if (p.length === 4 && third && fourth === "events.jsonl.gz")
    return { device, session, kind: "events", segment: third };
  const m = /^(\d+)\.jpg$/.exec(fifth ?? "");
  if (p.length === 5 && third && fourth === "frames" && m)
    return { device, session, kind: "frame", segment: third, frame: Number(m[1]) };
  return null;
}

/** Sessions in the bucket, newest first (a session id starts with its start time). */
export async function listSessions(store: TrackStore, device?: string): Promise<SessionRow[]> {
  const rows = new Map<string, SessionRow & { segs: Set<string> }>();
  for (const obj of await store.list(device ? `${device}/` : "")) {
    const k = parseKey(obj.key);
    if (!k) continue;
    const id = `${k.device}/${k.session}`;
    let row = rows.get(id);
    if (!row) {
      row = {
        device: k.device,
        session: k.session,
        segments: 0,
        frames: 0,
        bytes: 0,
        segs: new Set(),
      };
      rows.set(id, row);
    }
    row.bytes += obj.size;
    if (k.kind === "frame") row.frames += 1;
    if (k.kind === "events") row.segs.add(k.segment);
  }
  return [...rows.values()]
    .map(({ segs, ...r }) => ({ ...r, segments: segs.size }))
    .sort((a, b) => b.session.localeCompare(a.session) || a.device.localeCompare(b.device));
}
