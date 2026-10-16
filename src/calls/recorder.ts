/**
 * The call recorder on the desk (wren designs/2026-10-16-call-recording.md). Every 15 s: is a
 * booked call due (5 min before its start to its end) with a Meet or Zoom window open? Record.
 * A recording stops after 3 min with no call window, 30 min past the booked end, or when OBS
 * was stopped by hand. Record now / Stop come from the portal or the CLI. Each finished file
 * moves to ~/Movies/Wren calls (out of `wren video watch`'s way) and is queued for
 * `wren calls add`: 3 tries, then a notice. State lives in a file, so a desk restart mid-call
 * picks the recording back up.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Wren } from "../studio/service.js";
import type { Saved } from "./obs.js";
import { callWindow } from "./windows.js";

export const ARM_EARLY_MS = 5 * 60_000;
export const NO_WINDOW_MS = 3 * 60_000;
export const PAST_END_MS = 30 * 60_000;
export const MANUAL_MAX_MS = 3 * 3600_000;
export const UPCOMING_EVERY_MS = 5 * 60_000;
export const ADD_TRIES = 3;
export const SETTLE_MS = 60_000;
export const BANNER = "Recording this call. Tell them it's recorded.";

/** OBS, as the recorder needs it. */
export interface Booth {
  /** Window names open now ("[App] Title"); opens OBS first when it isn't running. */
  windows(): Promise<string[]>;
  recording(): Promise<boolean>;
  start(): Promise<Saved>;
  /** Stops (if recording) and puts back what start changed; the file, if OBS gave one. */
  stop(saved: Saved | null): Promise<string | null>;
  /** The newest recording made since `since`: what a stop by hand left. */
  lastFile(since: Date): Promise<string | null>;
  /** Nothing to watch: let go of OBS, and quit it if the desk opened it. */
  idle(): Promise<void>;
}

/** A booked call, as `wren calls upcoming` gives it. */
export interface Upcoming {
  id: number;
  start: string;
  end: string;
  who: string;
}

export interface Live {
  since: string;
  booking: number | null;
  who: string | null;
  by: "desk" | "manual";
  saved: Saved | null;
  /** Last time a call window was seen; null for a manual one that never saw one. */
  seen: string | null;
  /** Stop by this time whatever else. */
  until: string;
}

export interface Queued {
  file: string;
  booking: number | null;
  by: "desk" | "manual";
  started: string;
  tries: number;
  /** Not before this time (a retry waits). */
  after?: string;
}

export interface RecorderFile {
  live: Live | null;
  queue: Queued[];
  /** Booked calls already recorded (or stopped by hand): not armed again. */
  done: number[];
}

export interface RecorderState {
  recording: boolean;
  since: string | null;
  booking: number | null;
  who: string | null;
  by: "desk" | "manual" | null;
  next: string | null;
}

export const statePath = (home = homedir()) => join(home, ".config/autobrowse/call-recording.json");
export const callsDir = (home = homedir()) => join(home, "Movies/Wren calls");

/** wren's checkout doesn't have `wren calls` yet: wait for it, don't spend tries. */
const notReady = (msg: string) => /unknown command '?calls'?/i.test(msg);

export interface RecorderDeps {
  booth: Booth;
  wren: Wren;
  log: (msg: string) => void;
  /** A banner on the Mac (Notification Center); never input. */
  notify: (msg: string) => Promise<void>;
  now?: () => Date;
  path?: string;
  dir?: string;
}

export class Recorder {
  private file: RecorderFile = { live: null, queue: [], done: [] };
  private upcoming: Upcoming[] = [];
  private upcomingAt = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private adding = false;
  private waitedAt = 0;
  private readonly now: () => Date;
  private readonly path: string;
  private readonly dir: string;

  constructor(private readonly d: RecorderDeps) {
    this.now = d.now ?? (() => new Date());
    this.path = d.path ?? statePath();
    this.dir = d.dir ?? callsDir();
  }

  /** One at a time: the 15 s check and a portal press never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  /** Read fresh each time: the CLI's Record now and the desk share the file. */
  private async load(): Promise<void> {
    const raw = await readFile(this.path, "utf8").catch(() => null);
    this.file = {
      live: null,
      queue: [],
      done: [],
      ...(raw ? (JSON.parse(raw) as RecorderFile) : {}),
    };
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }

  state(): RecorderState {
    const live = this.file.live;
    const now = this.now().getTime();
    const next = this.upcoming.find(
      (c) => !this.file.done.includes(c.id) && Date.parse(c.end) > now && c.id !== live?.booking,
    );
    return {
      recording: Boolean(live),
      since: live?.since ?? null,
      booking: live?.booking ?? null,
      who: live?.who ?? null,
      by: live?.by ?? null,
      next: next?.start ?? null,
    };
  }

  status(): Promise<RecorderState> {
    return this.serial(async () => {
      await this.load();
      return this.state();
    });
  }

  /** Record now (a manual call); a recording already going is left as it is. */
  start(): Promise<RecorderState> {
    return this.serial(async () => {
      await this.load();
      if (!this.file.live) {
        const now = this.now();
        const due = this.due(now.getTime());
        await this.begin({
          by: "manual",
          booking: due?.id ?? null,
          who: due?.who ?? null,
          until: new Date(now.getTime() + MANUAL_MAX_MS),
          seen: null,
        });
      }
      return this.state();
    });
  }

  stop(): Promise<RecorderState> {
    return this.serial(async () => {
      await this.load();
      if (this.file.live) await this.finish("stopped");
      return this.state();
    });
  }

  /** The 15 s check. */
  tick(): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const now = this.now();
      await this.refresh(now);
      const live = this.file.live;
      if (live) await this.watchLive(live, now);
      else {
        const due = this.due(now.getTime());
        if (due) {
          const win = callWindow(await this.d.booth.windows());
          if (win)
            await this.begin({
              by: "desk",
              booking: due.id,
              who: due.who,
              until: new Date(Date.parse(due.end) + PAST_END_MS),
              seen: now,
            });
        } else await this.d.booth.idle();
      }
    }).then(() => this.drain());
  }

  /** A booked call in its window that isn't recorded yet. */
  private due(now: number): Upcoming | undefined {
    return this.upcoming.find(
      (c) =>
        !this.file.done.includes(c.id) &&
        Date.parse(c.start) - ARM_EARLY_MS <= now &&
        Date.parse(c.end) > now,
    );
  }

  private async refresh(now: Date): Promise<void> {
    if (now.getTime() - this.upcomingAt < UPCOMING_EVERY_MS) return;
    this.upcomingAt = now.getTime();
    try {
      this.upcoming = JSON.parse(await this.d.wren(["calls", "upcoming", "--hours", "24"], 60_000));
      // Done ids only matter while their call is listed.
      const listed = new Set(this.upcoming.map((c) => c.id));
      this.file.done = this.file.done.filter((id) => listed.has(id));
    } catch (err) {
      const msg = (err as Error).message;
      if (!notReady(msg)) this.d.log(`calls upcoming: ${msg}`);
    }
  }

  private async begin(o: {
    by: Live["by"];
    booking: number | null;
    who: string | null;
    until: Date;
    seen: Date | null;
  }): Promise<void> {
    const saved = (await this.d.booth.recording()) ? null : await this.d.booth.start();
    const now = this.now();
    this.file.live = {
      since: now.toISOString(),
      booking: o.booking,
      who: o.who,
      by: o.by,
      saved,
      seen: o.seen?.toISOString() ?? null,
      until: o.until.toISOString(),
    };
    await this.save();
    this.d.log(`call recording started (${o.by}${o.booking ? `, booking ${o.booking}` : ""})`);
    await this.d.notify(BANNER).catch(() => {});
  }

  private async watchLive(live: Live, now: Date): Promise<void> {
    if (!(await this.d.booth.recording())) return this.finish("stopped in OBS", true);
    const t = now.getTime();
    if (t > Date.parse(live.until)) return this.finish("past its time");
    const win = callWindow(await this.d.booth.windows());
    if (win) {
      live.seen = now.toISOString();
      await this.save();
      return;
    }
    if (live.seen && t - Date.parse(live.seen) > NO_WINDOW_MS)
      return this.finish("the call window closed");
  }

  /** Stop, put OBS back, move the file out of the OBS folder and queue it. */
  private async finish(why: string, byHand = false): Promise<void> {
    const live = this.file.live;
    if (!live) return;
    const since = new Date(live.since);
    const got = byHand
      ? await this.d.booth.lastFile(since)
      : await this.d.booth.stop(live.saved).catch(async (err: Error) => {
          this.d.log(`call recording stop: ${err.message}`);
          return this.d.booth.lastFile(since);
        });
    if (byHand && live.saved) await this.d.booth.stop(live.saved).catch(() => null);
    this.file.live = null;
    if (live.booking !== null && !this.file.done.includes(live.booking))
      this.file.done.push(live.booking);
    if (got) {
      await mkdir(this.dir, { recursive: true });
      const file = join(this.dir, basename(got));
      await rename(got, file);
      this.file.queue.push({
        file,
        booking: live.booking,
        by: live.by,
        started: live.since,
        tries: 0,
        // OBS finishes writing the file for a few seconds after StopRecord answers.
        after: new Date(this.now().getTime() + SETTLE_MS).toISOString(),
      });
    } else this.d.log("call recording stopped but OBS gave no file");
    await this.save();
    this.d.log(`call recording stopped: ${why}`);
  }

  /** `wren calls add` for each queued file, one at a time, outside the lock (minutes each). */
  async drain(): Promise<void> {
    if (this.adding) return;
    this.adding = true;
    try {
      for (;;) {
        const now = this.now().getTime();
        const job = await this.serial(async () => {
          await this.load();
          return this.file.queue.find((q) => !q.after || Date.parse(q.after) <= now);
        });
        if (!job) return;
        const drop = () => {
          this.file.queue = this.file.queue.filter((q) => q.file !== job.file);
        };
        const args = ["calls", "add", job.file, "--by", job.by, "--started", job.started];
        if (job.booking !== null) args.push("--booking", String(job.booking));
        try {
          const out = (await this.d.wren(args, 3 * 3600_000)).trim();
          this.d.log(`calls add: ${out.split("\n").at(-1) ?? ""}`);
          await this.serial(async () => {
            await this.load();
            drop();
            await this.save();
          });
        } catch (err) {
          const msg = (err as Error).message;
          if (notReady(msg)) {
            // Kept for when wren has it; said once an hour.
            if (now - this.waitedAt > 3600_000) {
              this.waitedAt = now;
              this.d.log(
                "calls add: wren has no `calls` command yet; recordings wait in the queue",
              );
            }
            return;
          }
          await this.serial(async () => {
            await this.load();
            const q = this.file.queue.find((x) => x.file === job.file);
            if (!q) return;
            q.tries += 1;
            this.d.log(`calls add (try ${q.tries}): ${msg}`);
            if (q.tries >= ADD_TRIES) {
              drop();
              await this.d
                .notify(
                  `A call recording didn't save. It's in Movies/Wren calls: ${basename(job.file)}`,
                )
                .catch(() => {});
            } else q.after = new Date(now + q.tries * 10 * 60_000).toISOString();
            await this.save();
          });
        }
      }
    } finally {
      this.adding = false;
    }
  }
}
