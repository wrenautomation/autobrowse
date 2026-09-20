/**
 * What this worker is made of, for the Status page and for a glance at
 * boot: which vendor sits behind each seam, which channels reach a
 * person, which code sources can answer a login. Names only, never a
 * value; the same rule as the log line.
 */
import type { Settings } from "./config.js";

export interface Status {
  llm: string;
  /** The daily token cap and today's spend; null when LLM_DAILY_TOKENS=0 or there is no model. */
  budget: { cap: number; usedToday: number } | null;
  browser: { tier: string; headless: boolean; pace: string; channel: string };
  memory: string;
  channels: string[];
  codes: string[];
  guards: string;
  evaluateEveryHours: number;
  autoBuild: boolean;
  sentry: boolean;
  workflows: string[];
  /** When this worker started (ISO). */
  since: string;
}

export function statusOf(
  settings: Settings,
  live: {
    llm: string | null;
    budget?: { cap: number; usedToday: number } | null;
    memory: string;
    workflows: string[];
    since?: Date;
  },
): Status {
  const channels: string[] = [];
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
  if (settings.notifyTo && notifyFrom) channels.push("email");
  if (settings.phoneNumber) channels.push("phone");
  const linqTo = settings.linqTo ?? settings.phoneNumber;
  if (settings.linqApiKey && settings.linqNumber && linqTo) channels.push("linq");
  if (settings.webhookUrl) channels.push("webhook");
  const codes = ["totp", "email"];
  if (settings.phoneNumber) codes.push("sms:phone");
  if (settings.linqApiKey && settings.linqNumber && linqTo) codes.push("sms:linq");
  if (settings.twilioAccountSid && settings.twilioAuthToken && settings.twilioNumber)
    codes.push("sms:twilio");
  return {
    llm: live.llm ?? "none",
    budget: live.budget ?? null,
    browser: {
      tier: settings.browser,
      headless: settings.browserHeadless,
      pace: settings.pace,
      channel: settings.browserChannel,
    },
    memory: live.memory,
    channels,
    codes,
    guards: settings.guards,
    evaluateEveryHours: settings.evaluateEveryHours,
    autoBuild: settings.autoBuild,
    sentry: Boolean(settings.sentryDsn),
    workflows: live.workflows,
    since: (live.since ?? new Date()).toISOString(),
  };
}
