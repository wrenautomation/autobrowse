/**
 * The operator's own limits over the code's defaults: `limits.json` beside the
 * caps ledger. Each site's daily caps, each account's caps and the pace
 * between calls are set apart, bucket by bucket; what the file leaves out
 * keeps the site's default. The file is read again when it changes, so a new
 * limit holds from the next call. A file that does not parse keeps the last
 * good one and says why on stderr. Each `edit` notes the site's limits before
 * and after in `limits-changes.jsonl` beside it.
 *
 * {
 *   "linkedin": {
 *     "caps": { "connect": 40 },
 *     "accounts": { "linkedin": { "profile": 40 } },
 *     "pace": { "gapMs": 5000, "jitterMs": 10000 }
 *   }
 * }
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Pace } from "./caps.js";
import type { SiteApi } from "./types.js";

const counts = z.record(z.string(), z.number().int().nonnegative());

const siteLimits = z.strictObject({
  caps: counts.optional(),
  /** By credential name, as `SiteApi.accountCaps`. */
  accounts: z.record(z.string(), counts).optional(),
  pace: z
    .strictObject({
      gapMs: z.number().int().nonnegative(),
      jitterMs: z.number().int().nonnegative().optional(),
      maxWaitMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export const limitsSchema = z.record(z.string(), siteLimits);
export type Limits = z.infer<typeof limitsSchema>;
export type SiteLimits = z.infer<typeof siteLimits>;

/** A site's limits after the file: what a call is held to. */
export interface Effective {
  caps?: Record<string, number>;
  accountCaps?: Record<string, Record<string, number>>;
  pace?: Pace;
}

/** The site's defaults with the file's limits over them, bucket by bucket. */
export function effective(s: SiteApi, l: Limits): Effective {
  const own = l[s.site] ?? {};
  const caps = s.caps || own.caps ? { ...s.caps, ...own.caps } : undefined;
  const names = new Set([...Object.keys(s.accountCaps ?? {}), ...Object.keys(own.accounts ?? {})]);
  const accountCaps = names.size
    ? Object.fromEntries(
        [...names].map((n) => [n, { ...s.accountCaps?.[n], ...own.accounts?.[n] }]),
      )
    : undefined;
  // Parsed JSON holds no undefined values, so the merge is a whole Pace.
  const pace = own.pace ? ({ ...s.pace, ...own.pace } as Pace) : s.pace;
  return {
    ...(caps ? { caps } : {}),
    ...(accountCaps ? { accountCaps } : {}),
    ...(pace ? { pace } : {}),
  };
}

export interface LimitStore {
  path: string;
  read(): Limits;
  write(l: Limits): void;
  /** One site's limits changed by `fn`, written and noted; an empty result drops the site. */
  edit(site: string, fn: (l: SiteLimits) => SiteLimits): { before: SiteLimits; after: SiteLimits };
}

/** Limits kept in `path`; none when it is missing. */
export function fileLimits(path: string): LimitStore {
  let seen: { mtimeMs: number; limits: Limits } | null = null;
  const read = (): Limits => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return {};
    }
    if (seen?.mtimeMs === mtimeMs) return seen.limits;
    const parsed = (() => {
      try {
        return limitsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      } catch (e) {
        return { success: false as const, error: e as Error };
      }
    })();
    if (!parsed.success) {
      console.error(`${path}: not valid limits, the last good ones hold: ${parsed.error.message}`);
      // Said once per change of the file.
      seen = { mtimeMs, limits: seen?.limits ?? {} };
      return seen.limits;
    }
    seen = { mtimeMs, limits: parsed.data };
    return parsed.data;
  };
  const write = (l: Limits) => {
    const checked = limitsSchema.parse(l);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(checked, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    path,
    read,
    write,
    edit(site, fn) {
      const all = read();
      const before = all[site] ?? {};
      const after = fn(structuredClone(before));
      const { [site]: _, ...rest } = all;
      write(Object.keys(after).length ? { ...rest, [site]: after } : rest);
      appendFileSync(
        join(dirname(path), "limits-changes.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), site, before, after })}\n`,
      );
      return { before, after };
    },
  };
}
