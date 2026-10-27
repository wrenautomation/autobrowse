#!/usr/bin/env node
/**
 * Continuous deploy for the desk worker: launchd runs this every minute
 * (`install.sh` writes both agents). A new commit on `main` that touches
 * src/, package.json or the lockfile restarts the worker; nothing else does.
 *
 * - Only a committed tree ships. The worker runs this checkout, so edits
 *   under src/ not yet committed (a session mid-change) hold the deploy
 *   until they land.
 * - A changed lockfile runs `pnpm install --frozen-lockfile` first.
 * - After the restart the worker must log "desk up" within 2 minutes, or
 *   #ops on Discord hears about it.
 * - No pull: commits are made in this checkout. A push from elsewhere ships
 *   on the next pull here.
 *
 * - The desk's own wren checkout (`../wren-desk`, a worktree of wren) moves to
 *   origin/main, fetched at most every 5 minutes. The desk runs `wren` there
 *   (`wrenCheckout`), never in the main `wren` checkout where sessions edit.
 *   Its `bin/wren` installs and rebuilds itself on the next call.
 *
 * Plain node, no tsx: launchd's node has the Full Disk Access ~/Documents needs.
 * State: ~/.config/autobrowse/desk-deploy.json. Log: ~/Library/Logs/autobrowse-desk-deploy.log.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LABEL = "com.wrenautomation.autobrowse-desk";
const STATE = join(homedir(), ".config/autobrowse/desk-deploy.json");
const DESK_LOG = join(homedir(), "Library/Logs/autobrowse-desk.log");
const SHIPPED = ["src", "package.json", "pnpm-lock.yaml"];
const UP_WITHIN_MS = 120_000;

const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: "utf8" }).trim();
const say = (line) => console.log(`${new Date().toISOString()} ${line}`);
const short = (sha) => sha.slice(0, 7);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { deployed: null, held: null };
  }
}
const writeState = (s) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(s)}\n`);
};

/** One name from the repo's .env; the value never leaves this process. */
function envValue(name) {
  try {
    const line = readFileSync(join(REPO, ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

async function tellOps(text) {
  const url = envValue("WREN_DISCORD_WEBHOOK_URL");
  if (!url) return;
  const ping = envValue("WREN_DISCORD_PING_USER_ID");
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `${ping ? `<@${ping}> ` : ""}${text}`,
        allowed_mentions: { parse: [], users: ping ? [ping] : [] },
      }),
    });
  } catch {
    say("could not reach #ops");
  }
}

/** Whether the desk log gained a "desk up" line past `from` (bytes). */
function upSince(from) {
  const size = statSync(DESK_LOG).size;
  if (size <= from) return false;
  const fd = openSync(DESK_LOG, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8").includes('"msg":"desk up"');
  } finally {
    closeSync(fd);
  }
}

const WREN_DESK = join(REPO, "../wren-desk");
const WREN_FETCH_MS = 5 * 60_000;

/** `../wren-desk` to origin/main; quiet when there is none or nothing moved. Never fails the deploy. */
function syncWren(state) {
  if (!existsSync(join(WREN_DESK, ".git"))) return state;
  if (state.wrenFetched && Date.now() - state.wrenFetched < WREN_FETCH_MS) return state;
  const git = (args) =>
    execFileSync("git", ["-C", WREN_DESK, ...args], { encoding: "utf8" }).trim();
  try {
    git(["fetch", "-q", "origin", "main"]);
    const at = git(["rev-parse", "HEAD"]);
    const main = git(["rev-parse", "origin/main"]);
    if (at !== main) {
      git(["checkout", "-q", "--detach", main]);
      say(`wren-desk ${short(at)} -> ${short(main)}`);
    }
  } catch (err) {
    say(`wren-desk sync failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
  const next = { ...state, wrenFetched: Date.now() };
  writeState(next);
  return next;
}

const METERED = join(homedir(), ".config/metered/metered.sh");

/**
 * The same rule as src/app/metered.ts: on a metered network a restart (Chrome, the watcher tabs)
 * and the wren-desk fetch wait for wifi. The script decides; no script, no hold.
 */
function metered() {
  if (!existsSync(METERED)) return false;
  try {
    const [mode, net] = execFileSync("bash", [METERED, "status"], {
      encoding: "utf8",
      timeout: 5_000,
    })
      .trim()
      .split(/\s+/);
    return mode === "on" || (mode === "auto" && net === "metered");
  } catch {
    return false;
  }
}

async function main() {
  if (metered()) {
    if (!readState().metered) {
      say("metered network: deploys and the wren-desk fetch wait for wifi");
      writeState({ ...readState(), metered: true });
    }
    return;
  }
  if (readState().metered) {
    say("unmetered: deploys resume");
    writeState({ ...readState(), metered: false });
  }
  syncWren(readState());
  if (sh("git", ["symbolic-ref", "--short", "HEAD"]) !== "main") return;
  const head = sh("git", ["rev-parse", "HEAD"]);
  const state = readState();
  if (head === state.deployed) return;
  try {
    sh("git", ["diff", "--quiet", "HEAD", "--", ...SHIPPED]);
  } catch {
    if (state.held !== head) {
      say(
        `${short(head)}: uncommitted changes under ${SHIPPED.join(", ")}; holding until they land`,
      );
      writeState({ ...readState(), held: head });
    }
    return;
  }
  const changed = (paths) => {
    try {
      sh("git", ["diff", "--quiet", state.deployed, head, "--", ...paths]);
      return false;
    } catch {
      return true;
    }
  };
  if (state.deployed && !changed(SHIPPED)) {
    writeState({ ...readState(), deployed: head, held: null });
    return;
  }
  if (state.deployed) {
    if (changed(["pnpm-lock.yaml"])) {
      say(`${short(head)}: lockfile changed, installing`);
      sh("pnpm", ["install", "--frozen-lockfile"]);
    }
  }
  const from = (() => {
    try {
      return statSync(DESK_LOG).size;
    } catch {
      return 0;
    }
  })();
  say(`${short(state.deployed ?? "unknown")} -> ${short(head)}: restarting the desk`);
  sh("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`]);
  // Written before the wait: a commit that will not boot is reported once, not retried every minute.
  writeState({ ...readState(), deployed: head, held: null });
  const until = Date.now() + UP_WITHIN_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    if (upSince(from)) {
      say(`${short(head)}: desk up`);
      return;
    }
  }
  const subject = sh("git", ["log", "-1", "--format=%s", head]);
  say(`${short(head)}: no "desk up" in 2 minutes`);
  await tellOps(
    `autobrowse desk did not come up after deploying ${short(head)} (${subject}). Log: ~/Library/Logs/autobrowse-desk.log`,
  );
}

main().catch(async (err) => {
  say(`deploy failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  await tellOps(
    `autobrowse desk deploy failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
  );
  process.exitCode = 1;
});
