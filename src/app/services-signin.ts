/** Signing in: walks and their secrets, watchers, the paired phone, one-time codes, logins, Linq, the runner's pace. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  type CodeSource,
  codeSources,
  fileSignInHolds,
  type LoginProvider,
  loginProvider,
  messageSource,
  SITE_LOGINS,
  totpSource,
} from "../auth/index.js";
import { loginSecrets, type SecretValues } from "../auth/signup.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { FILM_PACE, HUMAN_PACE, type Pace } from "../browser/human/index.js";
import { Watchers } from "../browser/watchers.js";
import { channels } from "../channels/index.js";
import { HttpError, httpClient } from "../clients/http.js";
import { type LinqClient, linqClient } from "../clients/linq.js";
import { twilioReader } from "../clients/twilio.js";
import type { SecretSink } from "../deps/sink.js";
import {
  openFullDiskAccessPane,
  type PhoneOptions,
  phoneReader,
  phoneStatus,
} from "../devices/phone.js";
import { expandHome } from "../google/auth.js";
import type { GmailUserClient } from "../google/gmail.js";
import type { Profile } from "../money/profile.js";
import { isDefaultOwner } from "../owner.js";
import { type WalkDeps, type WalkInput, type WalkOutput, walkFlow } from "../walks/flow.js";
import { loadWalk, saveWalk, type WalkSpec } from "../walks/spec.js";
import type { Settings } from "./config.js";
import { llmFor } from "./services-browser.js";
import { sinkFor } from "./services-keys.js";
import { profilesForPlace } from "./services-money.js";
import { channelsFor, gmailFor } from "./services-reach.js";
import { auditFor, credentialsFor, stateDirFor, walksDirFor } from "./services-state.js";
import type { DeviceLink } from "./setup.js";

/**
 * Tab watchers on this worker's browser (`browser/watchers.ts`): leases kept in `watchers.json`,
 * a rise sent to the Restate ingress. Null without a park, or without the ingress token on Cloud.
 */
export function watchersFor(settings: Settings, runner: FlowRunner, log: Logger): Watchers | null {
  if (!runner.tab) return null;
  const http = httpClient();
  const base = settings.restateIngressUrl.replace(/\/$/, "");
  return new Watchers({
    runner,
    file: join(stateDirFor(settings), "watchers.json"),
    log: (msg, extra) => log.info(extra ?? {}, msg),
    send: async (path, body, key) => {
      const r = await http.json(`${base}${path}`, {
        method: "POST",
        body,
        headers: {
          "idempotency-key": key,
          ...(settings.restateAuthToken
            ? { authorization: `Bearer ${settings.restateAuthToken}` }
            : {}),
        },
      });
      if (!r.ok) throw new HttpError("POST", `${base}${path}`, r.status, "watch sink");
    },
  });
}

/** Placed secrets a walk asks for: its sites' stored logins, codes from their inboxes; a bare `password` is the walk's own site's. */
function walkSecrets(settings: Settings, spec: WalkSpec): SecretValues {
  const sites = [
    ...new Set([
      spec.site,
      ...spec.secrets.flatMap((s) =>
        s.key.includes(".") ? [s.key.slice(0, s.key.lastIndexOf("."))] : [],
      ),
    ]),
  ];
  const own = loginSecrets(
    credentialsFor(settings),
    sites,
    {},
    {
      codes: { source: codesFor(settings, gmailFor(settings)), since: new Date() },
      phone: ourPhone(settings),
    },
  );
  const bare: Record<string, string> = {
    email: "username",
    username: "username",
    password: "password",
    code: "code",
  };
  return (name) => {
    const field = bare[name];
    return own.secrets(name.includes(".") || !field ? name : `${spec.site}.${field}`);
  };
}

/**
 * A walk by its catalog name, `<site>/walk-<name>`, with the owner's logins
 * and sink; null when there is none. Profile values come from `o.profile`
 * (else the only profile), on the Mac only; `o.ask` answers a field with no
 * value and no default.
 */
export function walkFor(
  settings: Settings,
  flowName: string,
  sink: SecretSink = sinkFor(settings),
  o: { profile?: string; ask?: WalkDeps["ask"] } = {},
): BrowserFlow<WalkInput, WalkOutput> | null {
  const m = /^([a-z0-9][a-z0-9._-]*)(?:@[\w-]+)?\/walk-([a-z][a-z0-9-]*)$/i.exec(flowName);
  if (!m) return null;
  const dir = walksDirFor(settings);
  const spec = loadWalk(dir, m[1] as string, m[2] as string);
  if (!spec) return null;
  const profiles = profilesForPlace(settings);
  let who: Promise<Profile | null> | null = null;
  return walkFlow(spec, {
    secrets: walkSecrets(settings, spec),
    sink,
    load: (site, name) => loadWalk(dir, site, name),
    ...(profiles
      ? {
          profile: async (field) => {
            who ??= profiles(o.profile ?? null);
            const p = await who;
            if (!p && o.profile)
              throw new Error(`no profile ${o.profile}: autobrowse profile list`);
            const { profileField } = await import("../money/profile.js");
            return p ? profileField(p, field) : null;
          },
        }
      : {}),
    ...(o.ask ? { ask: o.ask } : {}),
    // A page that changed under a records op: the configured model re-writes it on that page.
    rewrite: async (fp, op) => {
      const llm = llmFor(settings);
      if (!llm) return null;
      const { writeRecords } = await import("../agent/records.js");
      const w = await writeRecords({ fp, llm, ...op });
      return "error" in w ? null : w;
    },
    save: (s) => saveWalk(dir, s),
    archive: (as, html) =>
      writeFileSync(recordsFile(settings, spec.site, spec.name, as, "html"), html, {
        mode: 0o600,
      }),
    ai: async (op, prompt) => {
      const cheap = settings.cohereApiKey ? "cohere" : "claude-code";
      const llm = llmFor(
        op.model === "cheap" ? { ...settings, llmProvider: cheap, llmModel: undefined } : settings,
      );
      if (!llm) throw new Error(`${op.goal}: no ${op.model} model is configured`);
      const reply = await llm.complete({
        system: "Do the instruction with the data given. Answer plainly and briefly; never invent.",
        prompt,
        maxTokens: op.maxTokens,
        purpose: "walk-ai",
      });
      return reply.text.trim();
    },
  });
}

/** Where a walk's records land: `<artifacts>/records/<site>-<walk>-<as>-<time>.<ext>`. */
export function recordsFile(
  settings: Settings,
  site: string,
  walk: string,
  as: string,
  ext: "jsonl" | "html",
): string {
  const dir = join(expandHome(settings.artifactsDir), "records");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${site.replace(/@.*/, "")}-${walk}-${as}-${at}.${ext}`);
}

/** The paired phone, when one is configured: reader, notifier and channel share these options. */
export function phoneFor(settings: Settings): PhoneOptions | null {
  if (!settings.phoneNumber) return null;
  return {
    number: settings.phoneNumber,
    ...(settings.phoneMessagesDb ? { dbPath: settings.phoneMessagesDb } : {}),
  };
}

/** What `setup` checks and guides: the phone link when a number is configured. */
export function devicesFor(settings: Settings): DeviceLink[] {
  const phone = phoneFor(settings);
  if (!phone) return [];
  return [
    {
      name: `phone ${phone.number}`,
      async check() {
        const st = await phoneStatus(phone.dbPath);
        return { ok: st.read && st.send, fix: st.fix };
      },
      guide: async () => {
        if (!(await phoneStatus(phone.dbPath)).read) await openFullDiskAccessPane();
      },
    },
  ];
}

/**
 * Every way a code reaches us: TOTP from the stored seed, email through
 * Gmail, SMS from the paired phone and/or Linq and/or Twilio (all first
 * class; the phone is asked first).
 */
export function codesFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): CodeSource {
  const sources = [
    totpSource(),
    messageSource({
      kind: "email",
      reader: gmail,
      ...(settings.codesInbox ? { inbox: settings.codesInbox } : {}),
    }),
  ];
  const phone = phoneFor(settings);
  if (phone)
    sources.push(messageSource({ kind: "sms", inbox: phone.number, reader: phoneReader(phone) }));
  // The operator's lines (Linq, Twilio) carry only the operator's codes.
  const operators = isDefaultOwner(settings.owner);
  const linq = operators ? linqFor(settings, http) : null;
  if (linq)
    sources.push(messageSource({ kind: "sms", inbox: linq.to, reader: linq.client.reader() }));
  if (operators && settings.twilioAccountSid && settings.twilioAuthToken && settings.twilioNumber)
    sources.push(
      messageSource({
        kind: "sms",
        inbox: settings.twilioNumber,
        reader: twilioReader({
          accountSid: settings.twilioAccountSid,
          authToken: settings.twilioAuthToken,
          http,
        }),
      }),
    );
  return codeSources(...sources);
}

/** The number a site may text us on: the paired phone, else Linq, else Twilio; an owner's own phone only. */
export function ourPhone(settings: Settings, http = httpClient()): string | null {
  const own = phoneFor(settings)?.number ?? null;
  if (!isDefaultOwner(settings.owner)) return own;
  return own ?? linqFor(settings, http)?.to ?? settings.twilioNumber ?? null;
}

/**
 * Sign-in for every known site: codes from `codesFor`, device prompts by
 * a note over every channel that reaches a person (phone, email).
 */
export function loginFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): LoginProvider {
  const people = channelsFor(settings, gmail, http).filter((c) => c.note);
  const all = channels(people);
  const notify = people.length && all.note ? all.note.bind(all) : undefined;
  return loginProvider(SITE_LOGINS, {
    credentials: credentialsFor(settings, {
      by: "login",
      ...(notify ? { notify: (title: string, body: string) => notify(`${title}\n${body}`) } : {}),
    }),
    codes: codesFor(settings, gmail, http),
    audit: auditFor(settings),
    holds: fileSignInHolds(expandHome(settings.signInHoldsFile)),
    ...(notify ? { notify } : {}),
  });
}

/** Linq when the key and our number are set; the operator's number falls back to the paired phone's (never an owner's). */
export function linqFor(
  settings: Settings,
  http = httpClient(),
): { client: LinqClient; to: string } | null {
  const to = settings.linqTo ?? (isDefaultOwner(settings.owner) ? settings.phoneNumber : undefined);
  if (!settings.linqApiKey || !settings.linqNumber || !to) return null;
  return {
    client: linqClient({ apiKey: settings.linqApiKey, from: settings.linqNumber, http }),
    to,
  };
}

/** Whether flow runs draw the overlay: a flag first, then the setting; auto is on for a watched run. */
export function overlayOn(
  settings: Settings,
  o: { headless?: boolean; overlay?: boolean } = {},
): boolean {
  if (o.overlay !== undefined) return o.overlay;
  if (settings.overlay !== "auto") return settings.overlay === "on";
  // A film stays clean: its json carries each step, drawn on in the edit.
  return o.headless === false && !settings.film;
}

/** The runner's pace from settings; `fast` means no delays at all. */
export function paceFor(settings: Settings): Pace | null {
  // A film is watched: a demo's pace, whatever PACE says.
  if (settings.film) return FILM_PACE;
  if (settings.pace === "fast") return null;
  return settings.showPointer ? { ...HUMAN_PACE, showPointer: true } : HUMAN_PACE;
}
