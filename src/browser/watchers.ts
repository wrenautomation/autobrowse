/**
 * Tab watchers: a fake webhook for a site that pushes nothing to us (designs/2026-10-12-watchers-and-arming.md).
 * One extra tab per watched account sits on a light page while the site's own live channel
 * updates it; the unread count in the tab's title is the signal. A rise sends the lease's sink
 * (a Restate ingress `send`), so the caller reads the account only when something came in.
 *
 * Reading the title is a local CDP call every `everyMs`: the site sees one open tab, never a
 * request from us. The tab blocks images, media and fonts (not in the person's own browser),
 * reloads every `reloadMs` to keep its memory flat, and reopens with a backoff when the
 * browser under it closes (a broken run, a restart).
 *
 * While titles read, the sink also hears `kind: "alive"` every `beatMs`: the caller may then poll
 * the account less, trusting the tab to say when something came in.
 *
 * Leases come from the caller and lapse on their own (`until`): the caller renews each pass,
 * so a caller that stops leaves no tab behind. They are kept in a file, so a restart reopens them.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page, Route } from "playwright";
import { z } from "zod";
import { type ProfileBusy, profileBusyOf } from "./browsers.js";
import type { FlowRunner, HeldTab } from "./flow.js";

/** Where a site's watcher sits: a page that never marks anything read, and its title's count. */
export interface WatchSpec {
  url: string;
  /** The unread count in the title, group 1 (`(3) Feed | LinkedIn`). */
  title: RegExp;
}

const COUNT = /^\((\d+)\+?\)/;
/**
 * Sites whose title carries the unread count. A page off notifications and messages, so
 * sitting there marks nothing seen, and light: LinkedIn's and X's saved posts (a short list,
 * not a feed that keeps loading), Facebook's and Instagram's home.
 */
export const WATCH_SPECS: Record<string, WatchSpec> = {
  linkedin: { url: "https://www.linkedin.com/my-items/saved-posts/", title: COUNT },
  x: { url: "https://x.com/i/bookmarks", title: COUNT },
  facebook: { url: "https://www.facebook.com/", title: COUNT },
  instagram: { url: "https://www.instagram.com/", title: COUNT },
};

export const watchLease = z.object({
  /** The site whose spec applies (`linkedin`). */
  site: z.string().min(1),
  /** The profile the tab opens in (`linkedin@wren`); the site's own when absent. */
  account: z.string().min(1).optional(),
  /** What a rise sends: an ingress path ending in `/send`, and its body (`kind` is added). */
  sink: z.object({
    path: z
      .string()
      .regex(/^\/[A-Za-z][\w-]*\/(?:[^/]+\/)?[A-Za-z]\w*\/send$/, "an ingress `.../send` path"),
    body: z.record(z.string(), z.unknown()).default({}),
  }),
  /** The lease lapses then: the caller renews it each pass. At most a day out. */
  until: z.string().datetime(),
});
export type WatchLease = z.infer<typeof watchLease>;

export interface WatchState {
  id: string;
  site: string;
  until: string;
  open: boolean;
  /** The count the title last showed. */
  count: number | null;
  /** The last title read, ms since epoch; a watcher with none for a minute is not alive. */
  readAt: number | null;
  firedAt: number | null;
  fires: number;
  /** The title, when it carries no count: shows a spec gone stale. */
  title: string | null;
  error: string | null;
  /** Another process holds the profile (an explore session): the watch waits, then opens. */
  paused: string | null;
}

export interface WatchersDeps {
  runner: FlowRunner;
  /** POST an ingress path; `key` is its idempotency key. */
  send(path: string, body: Record<string, unknown>, key: string): Promise<void>;
  file: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
  everyMs?: number;
  reloadMs?: number;
  /** Two rises closer than this send once. */
  quietMs?: number;
  /** How often a reading watcher says it is alive. */
  beatMs?: number;
  specs?: Record<string, WatchSpec>;
}

interface Live {
  lease: WatchLease;
  held: HeldTab | null;
  state: WatchState;
  timer: ReturnType<typeof setInterval> | null;
  openedAt: number;
  retryAt: number;
  backoffMs: number;
  /** A rise waiting out `quietMs`. */
  pending: ReturnType<typeof setTimeout> | null;
  misses: number;
  beatAt: number;
}

const MAX_LEASE_MS = 24 * 60 * 60_000;
/** Nothing a title count needs: pictures, video, fonts, styles. */
const BLOCKED = new Set(["image", "media", "font", "stylesheet"]);

/**
 * What a watch tab skips: anything in `BLOCKED`, and every frame from another site (ads,
 * trackers, embeds). Each such frame costs a renderer process of its own, ~100 MB.
 */
export function watchSkips(
  req: { type: string; subframe: boolean; host: string },
  site: string,
): boolean {
  if (BLOCKED.has(req.type)) return true;
  if (req.type !== "document" || !req.subframe) return false;
  const base = new URL(site).hostname.split(".").slice(-2).join(".");
  return req.host !== base && !req.host.endsWith(`.${base}`);
}

/** Still on the spec's page and not a sign-in form: a quiet title then means nothing is unread. */
const signedIn = (page: Page, spec: WatchSpec, title: string) =>
  page.url().startsWith(spec.url) && !/log ?in|sign ?in|sign up/i.test(title);

export const watchId = (l: Pick<WatchLease, "site" | "account">) => l.account ?? l.site;

export class Watchers {
  private readonly live = new Map<string, Live>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly reloadMs: number;
  private readonly quietMs: number;
  private readonly beatMs: number;
  private readonly specs: Record<string, WatchSpec>;

  constructor(private readonly d: WatchersDeps) {
    this.now = d.now ?? Date.now;
    this.everyMs = d.everyMs ?? 20_000;
    this.reloadMs = d.reloadMs ?? 3 * 60 * 60_000;
    this.quietMs = d.quietMs ?? 30_000;
    this.beatMs = d.beatMs ?? 10 * 60_000;
    this.specs = d.specs ?? WATCH_SPECS;
  }

  /** Reopen the kept leases and check every minute for lapsed ones and closed tabs. */
  start(): void {
    for (const lease of this.read()) this.adopt(lease);
    this.sweeper ??= setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
    void this.sweep();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.live.values()].map((l) => this.close(l)));
  }

  /** Watch, or renew a watch: a later `until` or a new sink replace the old. */
  async lease(raw: unknown): Promise<WatchState> {
    const lease = watchLease.parse(raw);
    if (!this.specs[lease.site]) throw new Error(`no watch spec for ${lease.site}`);
    const until = Math.min(Date.parse(lease.until), this.now() + MAX_LEASE_MS);
    const kept = { ...lease, until: new Date(until).toISOString() };
    const l = this.adopt(kept);
    this.write();
    if (!l.held && l.retryAt <= this.now()) await this.open(l);
    return { ...l.state };
  }

  async unwatch(id: string): Promise<boolean> {
    const l = this.live.get(id);
    if (!l) return false;
    this.live.delete(id);
    this.write();
    await this.close(l);
    return true;
  }

  states(): WatchState[] {
    return [...this.live.values()].map((l) => ({ ...l.state }));
  }

  private adopt(lease: WatchLease): Live {
    const id = watchId(lease);
    const had = this.live.get(id);
    if (had) {
      had.lease = lease;
      had.state.until = lease.until;
      return had;
    }
    const l: Live = {
      lease,
      held: null,
      timer: null,
      openedAt: 0,
      retryAt: 0,
      backoffMs: 60_000,
      pending: null,
      misses: 0,
      beatAt: 0,
      state: {
        id,
        site: lease.site,
        until: lease.until,
        open: false,
        count: null,
        readAt: null,
        firedAt: null,
        fires: 0,
        title: null,
        error: null,
        paused: null,
      },
    };
    this.live.set(id, l);
    return l;
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const l of [...this.live.values()]) {
      if (Date.parse(l.lease.until) <= now) {
        this.live.delete(l.state.id);
        this.write();
        await this.close(l);
      } else if (!l.held && l.retryAt <= now) await this.open(l);
      else if (l.held && now - l.openedAt >= this.reloadMs) {
        l.openedAt = now;
        await l.held.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      }
    }
  }

  private async open(l: Live): Promise<void> {
    const spec = this.specs[l.lease.site];
    if (!spec || !this.d.runner.tab) return;
    try {
      const held = await this.d.runner.tab(watchId(l.lease));
      l.held = held;
      const page = held.page;
      if (!held.shared)
        await page.route("**/*", (r: Route) => {
          const req = r.request();
          let subframe = false;
          try {
            subframe = req.isNavigationRequest() && req.frame().parentFrame() !== null;
          } catch {} // a service worker's request has no frame
          const host = new URL(req.url()).hostname;
          return watchSkips({ type: req.resourceType(), subframe, host }, spec.url)
            ? r.abort()
            : r.continue();
        });
      page.once("close", () => {
        if (l.held !== held) return;
        this.closed(l, "the tab closed");
      });
      await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      l.openedAt = this.now();
      l.backoffMs = 60_000;
      l.misses = 0;
      l.state.open = true;
      l.state.error = null;
      if (l.state.paused) this.d.log?.("watch resumed", { id: l.state.id });
      l.state.paused = null;
      l.state.count = null;
      l.timer = setInterval(() => void this.check(l, page, spec), this.everyMs);
      l.timer.unref?.();
      await this.check(l, page, spec);
    } catch (err) {
      const busy = profileBusyOf(err);
      if (busy) this.paused(l, busy);
      else this.closed(l, (err as Error).message);
    }
  }

  /**
   * The profile is open elsewhere (an explore session): nothing failed. Look again at the next
   * sweep, a minute on, without the closed tab's doubling: it opens once the profile frees.
   */
  private paused(l: Live, busy: ProfileBusy): void {
    const first = l.state.paused === null;
    l.state.open = false;
    l.state.paused = `profile ${busy.profile} is open in ${busy.owner}`;
    l.retryAt = this.now() + 60_000;
    if (first) this.d.log?.("watch paused", { id: l.state.id, owner: busy.owner });
  }

  /** The tab or its browser went: try again later, a minute first, doubling to half an hour. */
  private closed(l: Live, why: string): void {
    const held = l.held;
    l.held = null;
    if (l.timer) clearInterval(l.timer);
    l.timer = null;
    l.state.open = false;
    l.state.error = why;
    l.retryAt = this.now() + l.backoffMs;
    l.backoffMs = Math.min(l.backoffMs * 2, 30 * 60_000);
    void held?.release();
    this.d.log?.("watch closed", { id: l.state.id, why });
  }

  private async close(l: Live): Promise<void> {
    if (l.timer) clearInterval(l.timer);
    if (l.pending) clearTimeout(l.pending);
    l.timer = null;
    l.pending = null;
    const held = l.held;
    l.held = null;
    l.state.open = false;
    await held?.release();
  }

  private async check(l: Live, page: Page, spec: WatchSpec): Promise<void> {
    if (l.held?.page !== page) return;
    let title: string;
    try {
      title = await page.title();
    } catch (err) {
      if (++l.misses >= 3) this.closed(l, (err as Error).message);
      return;
    }
    l.misses = 0;
    l.state.readAt = this.now();
    const m = spec.title.exec(title);
    const count = m ? Number(m[1]) : 0;
    l.state.title = m ? null : title.slice(0, 120);
    const before = l.state.count;
    l.state.count = count;
    // The first read counts what was already unread; after it, only a rise.
    if (count > 0 && (before === null || count > before)) this.rise(l);
    else if (this.now() - l.beatAt >= this.beatMs && signedIn(page, spec, title))
      void this.send(l, "alive");
  }

  private rise(l: Live): void {
    if (l.pending) return;
    const wait = (l.state.firedAt ?? 0) + this.quietMs - this.now();
    if (wait <= 0) return void this.fire(l);
    l.pending = setTimeout(() => {
      l.pending = null;
      void this.fire(l);
    }, wait);
    l.pending.unref?.();
  }

  private async fire(l: Live): Promise<void> {
    l.state.firedAt = this.now();
    l.state.fires += 1;
    await this.send(l, "activity");
  }

  /** A rise is also a beat. A signed-out tab never beats: the caller keeps polling. */
  private async send(l: Live, kind: "activity" | "alive"): Promise<void> {
    const at = this.now();
    l.beatAt = at;
    const { path, body } = l.lease.sink;
    await this.d
      .send(path, { ...body, kind }, `watch-${l.state.id}-${kind}-${at}`)
      .catch((err: unknown) => {
        l.state.error = `sink: ${(err as Error).message}`;
        this.d.log?.("watch sink failed", { id: l.state.id, error: l.state.error });
      });
  }

  private read(): WatchLease[] {
    try {
      const raw = JSON.parse(readFileSync(this.d.file, "utf8")) as unknown;
      const now = this.now();
      return z
        .array(watchLease)
        .parse(raw)
        .filter((l) => Date.parse(l.until) > now);
    } catch {
      return [];
    }
  }

  private write(): void {
    mkdirSync(dirname(this.d.file), { recursive: true });
    const tmp = `${this.d.file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        [...this.live.values()].map((l) => l.lease),
        null,
        2,
      ),
    );
    renameSync(tmp, this.d.file);
  }
}
