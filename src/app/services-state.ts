/** The owner's state folder: identities and credentials, the ledgers and dirs beside them, shots and traces, the timers that keep them. */
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { SSMClient } from "@aws-sdk/client-ssm";
import {
  aesGcmCipher,
  type CanaryOptions,
  type CredentialHistory,
  type CredentialStore,
  canaryStore,
  envCredentials,
  fileAudit,
  fileCredentials,
  keychainKey,
  layeredCredentials,
  plainCipher,
  type SecretAudit,
  ssmCredentialHistory,
  syncedCredentials,
  versionsFile,
} from "credvault";
import type { Logger } from "pino";
import { fileStepLedger, type StepLedger } from "../agent/ledger.js";
import {
  envIdentities,
  fileIdentities,
  type IdentityStore,
  layeredIdentities,
} from "../auth/identities.js";
import { CRED_ENV, keychainOf } from "../auth/keep.js";
import { type NamedStore, namedStore } from "../auth/roles.js";
import { addSiteLogins } from "../auth/sites.js";
import { type Fixes, fileFixes } from "../browser/fixes.js";
import { fileScreens, type LearnedScreens } from "../browser/screens.js";
import { httpClient } from "../clients/http.js";
import { expandHome } from "../google/auth.js";
import { registerDataLogins } from "../mods/login.js";
import { modFixes, modScreens, withModFixes, withModScreens } from "../mods/mod.js";
import { isDefaultOwner, ownerKeys } from "../owner.js";
import { clearRun, keepRun, packStale } from "../runs/capture.js";
import { s3BlobStore, s3TraceStore } from "../shots/s3.js";
import { keepArtifact, keepRecording, type ShipReport, shipShots } from "../shots/ship.js";
import { scrubKeptTraces } from "../shots/trace-scrub.js";
import { keptTraceSteps } from "../shots/trace-steps.js";
import { backupTraces, dirTraceStore, sweepTraces, traceDirName } from "../shots/traces.js";
import { fileSendJournal, type SendJournal } from "../sites/index.js";
import { fileMintedTokens } from "../sites/oauth.js";
import { walkLogins } from "../walks/login.js";
import type { Settings } from "./config.js";
import { type OpsLane, opsLane } from "./ops.js";
import { awsFor } from "./owner.js";
import { envStoreFor, ssmFor } from "./services-keys.js";
import { profilesFor } from "./services-money.js";

/** Env credentials first (a Secret in k8s), then the sealed 0600 file; writes go to the file. */
/**
 * The credential store, armed: a read of a canary credential is refused,
 * written to the ledger and, with `notify`, told to a person. `armed:
 * false` is for the operator's own listing; nothing that signs in gets it.
 */
/** The person's accounts and what each is for: the file, else `AUTOBROWSE_ACCOUNTS` (the box). */
export function identitiesFor(settings: Settings): IdentityStore {
  return layeredIdentities(fileIdentities(settings.accountsFile), envIdentities(settings.accounts));
}

const syncedStores = new Map<string, CredentialStore>();

export function credentialsFor(
  settings: Settings,
  o: {
    armed?: boolean;
    notify?: CanaryOptions["notify"];
    by?: string;
    /** Off for a pull or a push: the file alone, not the shared store. */
    shared?: boolean;
  } = {},
): NamedStore {
  const cipher =
    settings.credentialsCipher === "keychain"
      ? aesGcmCipher(keychainKey(keychainOf(settings.owner)))
      : plainCipher;
  const file = fileCredentials(settings.credentialsFile, cipher);
  const env = envCredentials(process.env, CRED_ENV);
  // SSM is the truth: reads ask it first and refresh the file, writes land in both.
  // Env baked in at deploy is only the fallback, so a changed password is never stale on the box.
  // One synced store per file for the whole process: its cache is what keeps KMS reads down.
  const key = `${settings.owner}|${settings.credentialsFile}|${settings.credentialsCipher}|${settings.awsRegion}`;
  const syncedNow = () => {
    const made = syncedStores.get(key);
    if (made) return made;
    const synced = syncedCredentials(file, envStoreFor(settings), {
      ...CRED_ENV,
      history: credentialHistoryFor(settings),
      // Which SSM version the file holds per site, so the next CLI run trusts the file.
      versions: versionsFile(`${expandHome(settings.credentialsFile)}.versions.json`),
      onSharedError: (site, err, during) => {
        if (during === "write")
          console.error(
            `${site}: kept here, not in the shared store (${err instanceof Error ? err.message : String(err)}); autobrowse creds push ${site}`,
          );
      },
    });
    syncedStores.set(key, synced);
    return synced;
  };
  const store =
    settings.credentialsShared === "ssm" && o.shared !== false
      ? (() => {
          const synced = syncedNow();
          return layeredCredentials([synced, env], synced);
        })()
      : layeredCredentials([env, file]);
  // Addressed by account names (`x`, `x@wren`, `x@<username>`); roles are read below the canary layer.
  if (o.armed === false) return namedStore(store);
  const armed = canaryStore(store, {
    audit: auditFor(settings),
    ...(o.notify ? { notify: o.notify } : {}),
    ...(o.by ? { by: o.by } : {}),
  });
  return namedStore(armed, store);
}

/** Ships new screenshots to the bucket; null when no bucket is set (they stay local). */
export function shipperFor(
  settings: Settings,
  o: { dry?: boolean } = {},
): (() => Promise<ShipReport>) | null {
  const bucket = settings.shotsBucket;
  if (!bucket) return null;
  // An owner's shots are fenced by its IAM session; an S3-compatible store has no such fence.
  if (settings.shotsEndpoint && !isDefaultOwner(settings.owner))
    throw new Error(
      `owner ${settings.owner}: shots ship to S3 only (SHOTS_ENDPOINT has no per-owner scope)`,
    );
  const artifacts = expandHome(settings.artifactsDir);
  const store = s3BlobStore({
    bucket,
    aws: awsFor(settings),
    ...(settings.shotsEndpoint ? { endpoint: settings.shotsEndpoint } : {}),
  });
  const runs = runsDirFor(settings);
  return () => {
    packStale(runs);
    return shipShots({
      roots: [
        { name: "artifacts", dir: artifacts, keep: keepArtifact },
        { name: "recordings", dir: expandHome(settings.recordingsDir), keep: keepRecording },
        { name: "runs", dir: runs, keep: keepRun, clear: clearRun },
      ],
      store,
      ledgerFile: join(artifacts, ".shots-shipped.tsv"),
      machine: `${ownerKeys(settings.owner).shots}${settings.shotsMachine ?? hostname().replace(/\.local$/, "")}`,
      ...o,
    });
  };
}

/** Traces kept for good (src/shots/traces.ts): null when no TRACES_TO is set. */
export function tracesFor(settings: Settings) {
  const to = settings.tracesTo;
  if (!to) return null;
  const machine = settings.shotsMachine ?? hostname().replace(/\.local$/, "");
  const own = expandHome(settings.artifactsDir);
  const dirs = [own, ...settings.traceDirs.map(expandHome)].map((dir) => ({
    name: traceDirName(dir, dir === own),
    dir,
  }));
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(to);
  const store = s3
    ? s3TraceStore({
        bucket: s3[1] as string,
        prefix: `${s3[2] ? `${s3[2].replace(/\/?$/, "/")}` : ""}${ownerKeys(settings.owner).shots}`,
        aws: awsFor(settings),
      })
    : dirTraceStore(expandHome(to));
  const base = {
    dirs,
    ledgerFile: join(stateDirFor(settings), "traces-kept.tsv"),
    prefix: `traces/${machine}/`,
  };
  return {
    where: store.where,
    keepDays: settings.tracesKeepDays,
    backup: (o: { dry?: boolean } = {}) => backupTraces({ ...base, store, ...o }),
    scrub: (o: { backup: boolean; log?: (line: string) => void }) => {
      const push = () => backupTraces({ ...base, store });
      return scrubKeptTraces({
        ...base,
        ...o,
        store,
        push,
        under: "traces/",
        doneFile: join(stateDirFor(settings), "traces-scrubbed.tsv"),
        workDir: join(stateDirFor(settings), "traces-scrub-work"),
      });
    },
    sweep: (o: { dry?: boolean } = {}) =>
      sweepTraces({ ...base, keepDays: settings.tracesKeepDays, now: new Date(), ...o }),
    steps: (o: { backup: boolean; out?: string }) =>
      keptTraceSteps({
        ...base,
        store,
        backup: o.backup,
        under: "traces/",
        out: o.out ?? join(stateDirFor(settings), "trace-steps.jsonl"),
        workDir: join(stateDirFor(settings), "traces-steps-work"),
      }),
  };
}

/** Copy then sweep traces every SHOTS_EVERY_MINUTES (at least 15), and a minute after start. One run at a time. */
export function keepTracesOnTimer(settings: Settings, log: Logger): void {
  const keep = tracesFor(settings);
  if (!keep) return;
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void keep
      .backup()
      .then(async (r) => {
        const swept = await keep.sweep();
        if (r.shipped || r.refused || swept.removed)
          log.info({ ...r, unreadable: r.unreadable.length, swept }, "traces");
      })
      .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "traces"))
      .finally(() => {
        busy = false;
      });
  };
  setInterval(tick, Math.max(settings.shotsEveryMinutes, 15) * 60_000).unref();
  setTimeout(tick, 60_000).unref();
}

/** The shared library's queue goes to Wren's ingest on the trace timer's beat (`share/share`). */
export function sendSharedOnTimer(log: Logger): void {
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void import("../share/share.js")
      .then(({ sendShared }) => sendShared({ budgetMs: 120_000 }))
      .then((r) => {
        if (r.sent || r.dropped) log.info(r, "share");
      })
      .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "share"))
      .finally(() => {
        busy = false;
      });
  };
  setInterval(tick, 15 * 60_000).unref();
  setTimeout(tick, 90_000).unref();
}

/**
 * Wren's second scrub (`share/presidio`): hourly, when the ingest's inbox holds files and
 * SHARE_ADMIN_TOKEN is set. Presidio's container runs only for the pass (it holds ~1.5 GB).
 */
/** Nightly: re-prove registry flows that have a local plan; a broken one opens a registry issue. */
export function reproofOnTimer(
  log: Logger,
  root: string,
  prove: (name: string, plan: Record<string, unknown>) => Promise<{ status: string }>,
): void {
  const tick = (): void => {
    void import("../share/gate.js")
      .then(({ reproofRegistry }) => reproofRegistry(root, prove))
      .then((r) => {
        if (r.broken.length) log.warn(r, "registry re-proof: broken flows");
        else if (r.proven) log.info(r, "registry re-proof");
      })
      .catch((err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "registry re-proof"),
      );
  };
  setInterval(tick, 24 * 60 * 60_000).unref();
  setTimeout(tick, 30 * 60_000).unref();
}

export function keepSharedOnTimer(log: Logger): void {
  const token = process.env.SHARE_ADMIN_TOKEN;
  if (!token) return;
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void (async () => {
      const { keepShared } = await import("../share/presidio.js");
      const r = await keepShared(token);
      if (r.held) log.warn(r, "share kept: traces held, the pass could not read them");
      else if (r.kept || r.bad) log.info(r, "share kept");
      const { gateShared } = await import("../share/gate.js");
      const { shareAdmin } = await import("../share/presidio.js");
      const g = await gateShared(shareAdmin(token));
      if (g.review) log.warn(g, "share gate: flows wait for a yes (autobrowse share review)");
    })()
      .catch((err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "share kept"),
      )
      .finally(() => {
        busy = false;
      });
  };
  setInterval(tick, 60 * 60_000).unref();
  setTimeout(tick, 5 * 60_000).unref();
}

/**
 * The profile's values (name, email, phone, address) are known values for
 * every shared trace: masked wherever they show. Read once, on the first share.
 */
export async function shareKnownFor(settings: Settings): Promise<void> {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return;
  const { setKnownSource } = await import("../share/share.js");
  setKnownSource(async () => {
    const out: { value: string; kind: string }[] = [];
    const walk = (v: unknown, kind: string): void => {
      if (typeof v === "string") out.push({ value: v, kind });
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) if (k !== "id") walk(x, k);
    };
    walk(await (await profilesFor(settings)).list(), "profile");
    return out;
  });
}

/** Where every secret use is written: next to the credential file, 0600, one JSON line each. */
/** The ledgers live beside the credential file, one hash-chained JSONL each (`autobrowse ledger verify`). */
export function ledgerPath(
  settings: Settings,
  name: "audit" | "spend" | "steps" | "charges" | "cards-on-file",
): string {
  return join(dirname(expandHome(settings.credentialsFile)), `${name}.jsonl`);
}

/** The owner's state folder: where the credentials file lives, and every ledger beside it. */
/** Notices to the ops lane, an owner's named; none without its webhook. */
export function noticeFor(settings: Settings): { notice?: OpsLane } {
  const ops = opsLane(httpClient());
  if (!ops) return {};
  const who = isDefaultOwner(settings.owner) ? "" : `[${settings.owner}] `;
  return { notice: (text, o) => ops(`${who}${text}`, o) };
}

export const stateDirFor = (settings: Settings): string =>
  dirname(expandHome(settings.credentialsFile));

/** Run history (src/runs/log.ts): one folder per site, kept for good. */
export const runsDirFor = (settings: Settings): string => join(stateDirFor(settings), "runs");
/** Minted access tokens the desk and every CLI run on this machine share. */
export const mintedTokensFor = (settings: Settings) =>
  fileMintedTokens(join(stateDirFor(settings), "access-tokens.json"));

/** Walks built from runs (src/walks): `walks/<site>/<name>.json`. */
export const walksDirFor = (settings: Settings): string => join(stateDirFor(settings), "walks");

/** Installed mods (src/mods): `mods/<dir>/`, beside the owner's own walks. */
export const modsDirFor = (settings: Settings): string => join(stateDirFor(settings), "mods");

/** The owner's own sign-ins as data (src/mods/login.ts): `logins/<site>.json`. */
export const loginsDirFor = (settings: Settings): string => join(stateDirFor(settings), "logins");

/** Add the owner's data logins, then installed mods', then sign-in walks, to `SITE_LOGINS`; every entry point, after `boot()`. */
export const loadDataLogins = (settings: Settings): void => {
  registerDataLogins(loginsDirFor(settings), modsDirFor(settings));
  addSiteLogins(walkLogins(walksDirFor(settings)));
};

/** The owner's learned screens, then installed mods' (src/mods). */
export const screensFor = (settings: Settings): LearnedScreens =>
  withModScreens(fileScreens(expandHome(settings.screensFile)), modScreens(modsDirFor(settings)));

/** The owner's fixes, then installed mods' (src/mods). */
export const fixesFor = (settings: Settings): Fixes =>
  withModFixes(fileFixes(expandHome(settings.fixesFile)), modFixes(modsDirFor(settings)));

/** Every model call, one file per month (src/llm/ledger.ts). */
export const llmCallsDirFor = (settings: Settings): string => join(stateDirFor(settings), "llm");

/** Every flow run (src/runs/flows.ts): `flows/flows-YYYY-MM.jsonl`, the `deps/stats` default after `boot`. */
export const flowRunsDirFor = (settings: Settings): string => join(stateDirFor(settings), "flows");

/** Every try of a `sites`/`desk` call (src/runs/calls.ts): `calls/calls-YYYY-MM.jsonl`, kept for good. */
export const siteCallsDirFor = (settings: Settings): string => join(stateDirFor(settings), "calls");

/**
 * What each keyed write left on this machine (`sites/send-journal.ts`): one file per send key,
 * beside the done-acts files the legs guard themselves with. `sites` (box) and `desk` (Mac) each
 * keep their own.
 */
export const sendJournalFor = (settings: Settings): SendJournal =>
  fileSendJournal(join(expandHome(settings.artifactsDir), "sends"));

export function stepLedgerFor(settings: Settings): StepLedger {
  return fileStepLedger(ledgerPath(settings, "steps"));
}

export function auditFor(settings: Settings): SecretAudit {
  return fileAudit(ledgerPath(settings, "audit"));
}

/**
 * Every state each credential has had: a version per change, one SSM
 * parameter per site under <owner's path>/history (one level down, so
 * env listings and the box's deploy never see it). `creds history`, `creds restore`.
 */
export function credentialHistoryFor(
  settings: Settings,
  ssm: SSMClient = ssmFor(settings),
): CredentialHistory {
  return ssmCredentialHistory(ssm, `${ownerKeys(settings.owner).ssm}/history`);
}
