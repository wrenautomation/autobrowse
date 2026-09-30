/**
 * Minutes-long work behind the API (a proof run, a heal) is a job: the
 * request answers at once with the job, the page polls it. One job per
 * key at a time: a second click on "prove" joins the running one instead
 * of starting a second browser on the same flow. Finished jobs are kept
 * for a while so a page that reloads still finds its result. `wait` holds
 * a poll until the job settles, so a page asks once, not every second.
 */
import { randomBytes } from "node:crypto";

export interface JobView {
  id: string;
  kind: string;
  key: string;
  status: "running" | "done" | "failed";
  /** Who started it: `operator` or an agent key's name; each sees only its own. */
  by: string;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}

export interface JobsOptions {
  /** Finished jobs to remember. */
  keep?: number;
  now?: () => number;
}

export class Jobs {
  private readonly jobs = new Map<string, JobView>();
  private readonly running = new Map<string, string>();
  /** Settles (never rejects) when the job does; `wait` races it. */
  private readonly settled = new Map<string, Promise<void>>();
  private readonly keep: number;
  private readonly now: () => number;
  constructor(opts: JobsOptions = {}) {
    this.keep = opts.keep ?? 100;
    this.now = opts.now ?? Date.now;
  }

  /** Start work under `kind/key`, or return the job already running it for the same caller. */
  start(kind: string, key: string, work: () => Promise<unknown>, by = "operator"): JobView {
    const slot = `${by}:${kind}/${key}`;
    const runningId = this.running.get(slot);
    const running = runningId ? this.jobs.get(runningId) : undefined;
    if (running) return running;
    const job: JobView = {
      id: randomBytes(6).toString("hex"),
      kind,
      key,
      status: "running",
      by,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.running.set(slot, job.id);
    // Status and finish time land together: a trim between the two would see a
    // finished job with no time and drop it as the oldest.
    const settle = (patch: Partial<JobView>) => {
      Object.assign(job, patch, { finishedAt: new Date(this.now()).toISOString() });
      if (this.running.get(slot) === job.id) this.running.delete(slot);
      this.trim();
    };
    this.settled.set(
      job.id,
      work().then(
        (result) => settle({ status: "done", result }),
        (err: unknown) =>
          settle({ status: "failed", error: err instanceof Error ? err.message : String(err) }),
      ),
    );
    return job;
  }

  get(id: string): JobView | null {
    return this.jobs.get(id) ?? null;
  }

  /** The job once it has settled, or as it stands after `ms`; null when unknown. */
  async wait(id: string, ms: number): Promise<JobView | null> {
    const job = this.jobs.get(id);
    if (job?.status !== "running") return job ?? null;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.settled.get(id),
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
      }),
    ]);
    clearTimeout(timer);
    return job;
  }

  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Oldest finished jobs go first; running ones are never dropped. */
  private trim(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== "running")
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    for (const j of finished.slice(0, Math.max(0, finished.length - this.keep))) {
      this.jobs.delete(j.id);
      this.settled.delete(j.id);
    }
  }
}
