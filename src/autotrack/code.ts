/**
 * The install code `autobrowse autotrack enroll` prints and the installers take (`AUTOTRACK=<code>`):
 * base64url of this JSON. It IS a credential: a write-only key for one device prefix. By design.
 *
 * `autotrack src/config.ts` must accept the same shape: { v: 1, bucket, region, device, keyId, secret }.
 */
import { z } from "zod";

/** kebab-case, short enough for the IAM user `track-<device>` (64 chars) and a path segment. */
export const DEVICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DEVICE_MAX = 40;

/**
 * Top-level prefixes of the bucket that are not a device's: `labels/` holds the offline labels,
 * `steps/` the RL view and its quality report.
 */
export const RESERVED_DEVICES = ["labels", "steps"];

export function checkDevice(device: string): string {
  if (!DEVICE.test(device) || device.length > DEVICE_MAX)
    throw new Error(`device must be kebab-case, at most ${DEVICE_MAX} chars, got "${device}"`);
  if (RESERVED_DEVICES.includes(device))
    throw new Error(`"${device}" is a prefix of the bucket, not a device name`);
  return device;
}

const codeSchema = z
  .object({
    v: z.literal(1),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,62}$/),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
    device: z.string().regex(DEVICE).max(DEVICE_MAX),
    keyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
    secret: z.string().min(16),
  })
  .strict();
export type TrackCode = z.infer<typeof codeSchema>;

export const encodeCode = (c: TrackCode): string =>
  Buffer.from(JSON.stringify(codeSchema.parse(c))).toString("base64url");

export function decodeCode(code: string): TrackCode {
  const text = code.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not an install code (base64url expected)");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new Error("not an install code (does not decode to JSON)");
  }
  const parsed = codeSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `bad install code: ${parsed.error.issues.map((i) => i.path.join(".") || "code").join(", ")}`,
    );
  return parsed.data;
}

const BASE = "https://raw.githubusercontent.com/wrenautomation/autotrack/main/install";

/**
 * The two one-line installs, with the code filled in. Windows is for a PowerShell window: wrapped
 * in `powershell -c "..."`, PowerShell itself would expand `$env:AUTOTRACK` to nothing first.
 */
export const installCommands = (code: string) => ({
  windows: `$env:AUTOTRACK='${code}'; irm ${BASE}/install.ps1 | iex`,
  mac: `AUTOTRACK='${code}' sh -c "$(curl -fsSL ${BASE}/install.sh)"`,
});
