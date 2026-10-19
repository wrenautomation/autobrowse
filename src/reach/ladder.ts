/**
 * The fetch ladder (designs/2026-10-18-fetch-ladder.md in wren): one URL, four
 * rungs, climbed only on a block signal.
 *
 *   plain        `fetch` with our UA
 *   impersonate  Chrome's TLS and HTTP/2 fingerprint and headers (`impit`)
 *   render       the page in a stealth browser, profile `fetch`
 *   exit         the same, profile `fetch@exit`: out of the exit `EGRESS_SITES` maps to it
 *
 * A block is data (`Fetched.block`), never a thrown error. A 401, 404 or 410 is
 * an answer, not a block. Rungs are injected, so tests use fakes; `realRungs`
 * builds the live ones. Serves `web GET /fetch`.
 */
import type { Render, RenderedPage } from "../browser/render.js";
import { htmlText, looksLikeJsShell } from "./html.js";

/** A desktop browser's name: some sites answer a bare fetch with a bot page. */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
export const TIMEOUT_MS = 30_000;

export const TIERS = ["plain", "impersonate", "render", "exit"] as const;
export type Tier = (typeof TIERS)[number];

/** What one rung got: the page as it came, whatever its status. */
export type Got = RenderedPage;

export interface Try {
  tier: Tier;
  status: number | null;
  block: string | null;
  ms: number;
}

export interface Fetched {
  /** As asked. */
  url: string;
  /** After redirects. */
  finalUrl: string;
  /** The answering rung's HTTP status. */
  status: number | null;
  /** Its content-type. */
  type: string | null;
  /** Its body, cut to `max`; "" when none. */
  html: string;
  /** Characters cut. */
  cut: number;
  /** The rung that answered (the last that returned a page, else the last tried). */
  tier: Tier;
  /** null: a usable page; else the signal the last rung still hit. */
  block: string | null;
  tries: Try[];
}

/* ---------------- blocks ---------------- */

/** Under this much visible text, a page is a wall, not a page. */
const THIN_TEXT = 1500;

/**
 * One bot wall's name and the markers it leaves in the page (lowercase). `thin`:
 * the marker alone is no wall on a page with real text (Turnstile guards many
 * contact forms), at any status.
 */
const FAMILIES: { block: string; markers: string[]; thin?: true }[] = [
  {
    block: "cloudflare",
    markers: [
      "cf-chl-",
      "cf_chl_opt",
      "/cdn-cgi/challenge-platform/",
      "<title>just a moment...</title>",
      "attention required! | cloudflare",
    ],
  },
  { block: "turnstile", markers: ["challenges.cloudflare.com/turnstile"], thin: true },
  { block: "akamai", markers: ["errors.edgesuite.net"] },
  { block: "datadome", markers: ["captcha-delivery.com", "datadome"] },
  { block: "perimeterx", markers: ["px-captcha", "_pxhd", "press & hold", "press &amp; hold"] },
  { block: "imperva", markers: ["_incapsula_resource", "incapsula incident id"] },
  { block: "sucuri", markers: ["sucuri_cloudproxy_js", "sucuri website firewall"] },
  { block: "aws-waf", markers: ["awswaf.com", "aws-waf-token"] },
  { block: "vercel", markers: ["vercel security checkpoint"] },
  { block: "kasada", markers: ["x-kpsdk"] },
];

const STATUS_BLOCKS = new Set([403, 429, 503]);

/**
 * The bot wall a page shows by its markers, or null. A marker counts only when
 * the status is 400 or more, or the visible text is thin: a real page with a
 * Turnstile contact form is not a wall. Render polls this while a challenge clears.
 */
export function challengeOf(page: Pick<Got, "status" | "html">): string | null {
  const html = page.html.toLowerCase();
  const thin = htmlText(page.html).text.length < THIN_TEXT;
  const counts = (page.status ?? 0) >= 400 || thin;
  if (!counts) return null;
  if (page.status === 403 && html.includes("reference #") && html.includes("access denied"))
    return "akamai";
  const has = (f: { markers: string[]; thin?: true }) =>
    (thin || !f.thin) && f.markers.some((m) => html.includes(m));
  return FAMILIES.find(has)?.block ?? null;
}

/**
 * Why a page is not usable, or null. A marker beats a bare status; a shell (words
 * live in JavaScript) is the last test and only on a page that answered.
 */
export function blockOf(page: Pick<Got, "status" | "html" | "type">): string | null {
  const marker = challengeOf(page);
  if (marker) return marker;
  if (page.status !== null && STATUS_BLOCKS.has(page.status)) return `status-${page.status}`;
  if ((page.status ?? 200) >= 400) return null;
  const isHtml = /html/i.test(page.type ?? "") || /^\s*</.test(page.html);
  if (isHtml && looksLikeJsShell(page.html, htmlText(page.html).text)) return "shell";
  return null;
}

/**
 * The rung after a block, or null to stop. A shell skips ahead to `render`: a
 * different TLS fingerprint gets the same shell. Past `exit` there is nothing.
 */
export function nextRung(tier: Tier, block: string | null): Tier | null {
  const at = TIERS.indexOf(tier);
  if (block === "shell" && at < TIERS.indexOf("render")) return "render";
  return TIERS[at + 1] ?? null;
}

/* ---------------- transport ---------------- */

/** The host or the line failed before a page came. `reset` climbs; `unreachable` stops. */
export class Transport extends Error {
  constructor(
    readonly kind: "reset" | "unreachable",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "Transport";
  }
}

/** The `exit` rung has no exit: `fetch@exit` is not in `EGRESS_SITES`. */
export class NoExit extends Error {
  constructor() {
    super("no exit mapped for fetch@exit (EGRESS_SITES=fetch@exit:<name>)");
    this.name = "NoExit";
  }
}

const DEAD =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout|timed out|refused|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/i;
const RESET =
  /ECONNRESET|EPIPE|ECONNABORTED|EPROTO|UND_ERR_SOCKET|ERR_SSL|ERR_TLS|ERR_CONNECTION_(RESET|CLOSED)|reset by peer|connection (reset|closed|aborted)|socket hang up|other side closed|handshake|\btls\b|\bssl\b|certificate/i;

/** Names a thrown fetch failure by what it says and what its causes say; null for anything else. */
export function transportOf(e: unknown): Transport["kind"] | null {
  if (e instanceof Transport) return e.kind;
  const said: string[] = [];
  for (let c: unknown = e, hops = 0; c && hops < 5; hops++) {
    const err = c as {
      name?: string;
      message?: string;
      code?: string;
      constructor?: { name?: string };
    };
    said.push(err.constructor?.name ?? "", err.name ?? "", err.code ?? "", err.message ?? "");
    c = (c as { cause?: unknown }).cause;
  }
  const text = said.join(" ");
  if (DEAD.test(text)) return "unreachable";
  if (RESET.test(text)) return "reset";
  return null;
}

/* ---------------- pacing ---------------- */

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const HOST_GAP_MS = 2_000;

/** At least `gapMs` between two requests to one host, across rungs. In process. */
export class HostGap {
  private readonly next = new Map<string, number>();
  constructor(
    private readonly gapMs = HOST_GAP_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = sleepFor,
  ) {}

  /** Books the host's next slot at once, so callers that overlap queue instead of racing. */
  async wait(host: string): Promise<void> {
    const t = this.now();
    if (this.next.size > 1_000) for (const [h, at] of this.next) if (at <= t) this.next.delete(h);
    const at = Math.max(t, this.next.get(host) ?? 0);
    this.next.set(host, at + this.gapMs);
    if (at > t) await this.sleep(at - t);
  }
}

const processGap = new HostGap();

/* ---------------- climb ---------------- */

export type Rung = (url: string) => Promise<Got>;

/**
 * The rungs a climb may use. A missing `render` ends the climb after `impersonate`
 * with the block as found. A missing `exit` beside a `render` is block `no-exit`.
 */
export interface Rungs {
  plain: Rung;
  impersonate: Rung;
  render?: Rung;
  exit?: Rung;
}

export interface ClimbDeps {
  gap?: HostGap;
  now?: () => number;
}

export const FETCH_MAX = { min: 10_000, max: 5_000_000, def: 2_000_000 } as const;

/** The first rung that exists at or below `from`: a leg with no browser starts a `render` ask at `impersonate`. */
function startAt(from: Tier, rungs: Rungs): Tier {
  if (from === "plain" || rungs.render) return from;
  return "impersonate";
}

export async function climb(
  url: string,
  o: { from?: Tier; max?: number },
  rungs: Rungs,
  deps: ClimbDeps = {},
): Promise<Fetched> {
  const gap = deps.gap ?? processGap;
  const now = deps.now ?? Date.now;
  const max = o.max ?? FETCH_MAX.def;
  const host = new URL(url).host;
  const tries: Try[] = [];
  let shown: { tier: Tier; got: Got | null } | null = null;
  let block: string | null = null;
  let tier: Tier | null = startAt(o.from ?? "plain", rungs);

  while (tier) {
    const rung = rungs[tier];
    if (!rung) {
      // Past `render` with no exit: say so. Without a browser at all, stop as found.
      if (tier === "exit" && rungs.render) {
        tries.push({ tier, status: null, block: "no-exit", ms: 0 });
        block = "no-exit";
        shown ??= { tier, got: null };
      }
      break;
    }
    await gap.wait(host);
    const t0 = now();
    try {
      const got = await rung(url);
      block = blockOf(got);
      shown = { tier, got };
      tries.push({ tier, status: got.status, block, ms: now() - t0 });
    } catch (e) {
      if (e instanceof NoExit) {
        tries.push({ tier, status: null, block: "no-exit", ms: now() - t0 });
        block = "no-exit";
        shown ??= { tier, got: null };
        break;
      }
      const kind = transportOf(e);
      if (!kind) throw e;
      tries.push({ tier, status: null, block: kind, ms: now() - t0 });
      block = kind;
      shown = { tier, got: null };
      if (kind === "unreachable") break;
    }
    if (!block) break;
    tier = nextRung(tier, block);
  }

  const got = shown?.got ?? null;
  const html = got?.html.slice(0, max) ?? "";
  return {
    url,
    finalUrl: got?.finalUrl ?? url,
    status: got?.status ?? null,
    type: got?.type ?? null,
    html,
    cut: (got?.html.length ?? 0) - html.length,
    tier: shown?.tier ?? "plain",
    block,
    tries,
  };
}

/* ---------------- live rungs ---------------- */

const gotOf = async (res: {
  url: string;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}): Promise<Got> => ({
  finalUrl: res.url,
  status: res.status,
  type: res.headers.get("content-type"),
  html: await res.text(),
});

/** A transport failure becomes a `Transport`; anything else stays what it was. */
const named = (e: unknown): never => {
  const kind = transportOf(e);
  if (!kind) throw e;
  throw e instanceof Transport
    ? e
    : new Transport(kind, e instanceof Error ? e.message : String(e), e);
};

let impit: Promise<import("impit").Impit> | undefined;
/** One Chrome-shaped client for the process (its connection pool); loaded on first use, a native module. */
const chrome = () =>
  (impit ??= import("impit").then(
    ({ Impit }) => new Impit({ browser: "chrome", timeout: TIMEOUT_MS, followRedirects: true }),
  ));

/** The live rungs. `fetch` is the plain rung's (tests pass a fake); `render` is the api leg's browser. */
export function realRungs(deps: { fetch?: typeof fetch; render?: Render }): Rungs {
  const f = deps.fetch ?? fetch;
  const render = deps.render;
  return {
    plain: (url) =>
      f(url, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(gotOf, named),
    impersonate: async (url) => {
      try {
        return await gotOf(await (await chrome()).fetch(url));
      } catch (e) {
        return named(e);
      }
    },
    ...(render
      ? {
          render: (url) => render(url, { profile: "fetch" }),
          exit: (url) => render(url, { profile: "fetch@exit" }),
        }
      : {}),
  };
}
