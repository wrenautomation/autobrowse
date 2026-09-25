/**
 * Google Maps listings as a lead list, through the MIT gosom/google-maps-scraper
 * running in Docker on loopback. It answers a REST API: post a job, wait for
 * it, download its CSV. The CSV is what `wren email import --format
 * google-maps` reads, unchanged.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const MAPS_IMAGE = "gosom/google-maps-scraper";
export const MAPS_CONTAINER = "autobrowse-maps";
/** Restate owns 8080 on this machine. */
export const MAPS_BASE = "http://127.0.0.1:8090";

export interface MapsJob {
  /** One search each: "hvac contractor in austin tx". */
  keywords: string[];
  /** How far down the results list to scroll; 1 is about 20 places a keyword. */
  depth: number;
  /** Visit each website for emails: slower, and the whole point for outreach. */
  email: boolean;
  /** The job gives up after this long. */
  maxMinutes: number;
  lang?: string;
}

interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Each status the job reports, as it changes. */
  onStatus?: (status: string) => void;
  base?: string;
}

const POLL_MS = 10_000;

/** Post the job, wait for it, return its CSV. */
export async function mapsScrape(job: MapsJob, deps: Deps = {}): Promise<string> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = deps.base ?? MAPS_BASE;
  const posted = await f(`${base}/api/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: job.keywords[0]?.slice(0, 60) ?? "autobrowse",
      keywords: job.keywords,
      lang: job.lang ?? "en",
      depth: job.depth,
      email: job.email,
      max_time: job.maxMinutes * 60,
    }),
  });
  if (!posted.ok)
    throw new Error(`maps: job refused, HTTP ${posted.status}: ${await posted.text()}`);
  const { id } = (await posted.json()) as { id: string };
  const deadline = Date.now() + (job.maxMinutes + 5) * 60_000;
  let last = "";
  for (;;) {
    const res = await f(`${base}/api/v1/jobs/${id}`);
    if (!res.ok) throw new Error(`maps: job ${id} status HTTP ${res.status}`);
    const status = ((await res.json()) as { Status?: string }).Status ?? "unknown";
    if (status !== last) deps.onStatus?.(status);
    last = status;
    if (status === "ok") break;
    if (status === "failed")
      throw new Error(`maps: job ${id} failed (see docker logs ${MAPS_CONTAINER})`);
    if (Date.now() > deadline) throw new Error(`maps: job ${id} still ${status} past its max time`);
    await sleep(POLL_MS);
  }
  const csv = await f(`${base}/api/v1/jobs/${id}/download`);
  if (!csv.ok) throw new Error(`maps: job ${id} download HTTP ${csv.status}`);
  return csv.text();
}

/** Rows in a CSV, header excluded; quoted newlines inside a cell do not count. */
export function csvRows(csv: string): number {
  let rows = 0;
  let quoted = false;
  for (const ch of csv.trimEnd()) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "\n" && !quoted) rows++;
  }
  return rows;
}

const up = async (base: string) => {
  try {
    return (await fetch(`${base}/api/v1/jobs`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
};

/**
 * The scraper answering on loopback: already, or started now in Docker.
 * Says whether it started it, so the caller stops what it started.
 */
export async function ensureMapsServer(dataDir: string, base = MAPS_BASE): Promise<boolean> {
  if (await up(base)) return false;
  await exec("docker", ["info"], { timeout: 20_000 }).catch(() => {
    throw new Error("maps: Docker is not running; start Docker Desktop, then run this again");
  });
  const { stdout } = await exec("docker", ["images", "-q", MAPS_IMAGE]);
  // The first pull is a few GB: its own step, no timeout, progress on stderr.
  if (!stdout.trim())
    await new Promise<void>((ok, fail) =>
      spawn("docker", ["pull", MAPS_IMAGE], { stdio: ["ignore", "inherit", "inherit"] }).on(
        "exit",
        (code) =>
          code === 0 ? ok() : fail(new Error(`maps: docker pull ${MAPS_IMAGE} exited ${code}`)),
      ),
    );
  const port = new URL(base).port;
  await exec("docker", ["rm", "-f", MAPS_CONTAINER]).catch(() => undefined);
  await exec(
    "docker",
    [
      ...["run", "-d", "--rm", "--name", MAPS_CONTAINER],
      ...["-p", `127.0.0.1:${port}:8080`, "-v", `${dataDir}:/gmapsdata`],
      ...[MAPS_IMAGE, "-data-folder", "/gmapsdata", "-c", "2"],
    ],
    { timeout: 60_000 },
  );
  for (let i = 0; i < 60; i++) {
    if (await up(base)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`maps: the scraper did not answer on ${base} (docker logs ${MAPS_CONTAINER})`);
}

/** One line: can `maps` run here, and what is missing. */
export async function mapsReady(base = MAPS_BASE): Promise<string> {
  if (await up(base)) return `scraper answering on ${base}`;
  if (
    !(await exec("docker", ["info"], { timeout: 20_000 }).then(
      () => true,
      () => false,
    ))
  )
    return "Docker is not running";
  const { stdout } = await exec("docker", ["images", "-q", MAPS_IMAGE]).catch(() => ({
    stdout: "",
  }));
  return stdout.trim() ? "ready (Docker up, image pulled)" : `ready; first run pulls ${MAPS_IMAGE}`;
}

export async function stopMapsServer(): Promise<void> {
  await exec("docker", ["stop", MAPS_CONTAINER]).catch(() => undefined);
}
