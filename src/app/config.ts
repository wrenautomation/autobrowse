/**
 * Settings from the environment. Every value that is a credential stays in
 * this object and in request headers; nothing here is ever logged whole.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  /** Restate Cloud ingress: autobrowse's own objects and wren's loops share the env. */
  restateIngressUrl: z.string().url(),
  restateAuthToken: z.string().min(1).optional(),
  /** Cloudflare: registrar of record and DNS for every fleet domain. */
  cloudflareApiToken: z.string().min(1).optional(),
  cloudflareAccountId: z.string().min(1).optional(),
  /** The Workspace service account (path or JSON) and the super admin it acts as. */
  googleServiceAccount: z.string().min(1).optional(),
  googleAdminUser: z.string().email().optional(),
  /** Where wren reads its roster. */
  rosterSsmParam: z.string().min(1).default("/wren/prod/senders_config"),
  awsRegion: z.string().min(1).default("us-east-1"),
  /** Who gets approval requests and completion notes, and the fleet inbox they come from. */
  notifyTo: z.string().email().optional(),
  notifyFrom: z.string().email().optional(),
  /** DMARC aggregate reports go here. */
  dmarcRua: z.string().email().optional(),
  /** GitHub token that may dispatch wren's deploy workflow (roster reload). */
  githubToken: z.string().min(1).optional(),
  wrenRepo: z.string().min(1).default("wrenautomation/wren"),
  /** Browser tier: a local Chromium with a persistent profile, or Browserbase. */
  browser: z.enum(["local", "browserbase"]).default("local"),
  browserbaseApiKey: z.string().min(1).optional(),
  browserbaseProjectId: z.string().min(1).optional(),
  /** Persistent browser profiles (logins survive between runs). */
  profilesDir: z.string().min(1).default("~/.config/autobrowse/profiles"),
  /** Local browser: the installed Chrome (default, falls back) or Playwright's chromium (containers). */
  browserChannel: z.enum(["chrome", "chromium"]).default("chrome"),
  /** Screenshots and Playwright traces from flows that needed a person or failed. */
  artifactsDir: z.string().min(1).default("~/.config/autobrowse/artifacts"),
  /** Raw Playwright codegen output from `record --flow`; may hold typed secrets, never committed. */
  recordingsDir: z.string().min(1).default("recordings"),
  logLevel: z.string().default("info"),
  /** Where the Restate endpoint listens; the UI is on `uiPort`. */
  restatePort: z.coerce.number().int().default(9081),
  uiPort: z.coerce.number().int().default(9080),
  /** Bearer the UI and inbound hooks need for anything that changes a run. Unset = local only, no auth. */
  uiToken: z.string().min(1).optional(),
  /** Bind address for the UI; see `startUiServer`. */
  uiHost: z.string().min(1).optional(),
  /** Every run event, as JSON, to one URL (iMessage/Slack/dashboards). */
  webhookUrl: z.string().url().optional(),
  webhookToken: z.string().min(1).optional(),
  /** Model behind the compiler's polish and the locator repairer. No key = both off. */
  llmProvider: z.enum(["anthropic", "openai"]).default("anthropic"),
  llmModel: z.string().min(1).optional(),
  anthropicApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  openaiBaseUrl: z.string().url().optional(),
  /** Memory between runs (repairs that worked, hand-off notes). `none` keeps it in-process. */
  memory: z.enum(["backboard", "none"]).default("none"),
  backboardApiKey: z.string().min(1).optional(),
  backboardAssistant: z.string().min(1).default("autobrowse"),
  /** Which guards stay on: `all`, `none`, or a comma list (purchase, password, irreversible). */
  guards: z.string().default("all"),
  /** Site credentials for automated sign-in; 0600 JSON. Env (`AUTOBROWSE_CRED_*`) is read first. */
  credentialsFile: z.string().min(1).default("~/.config/autobrowse/credentials.json"),
  /** Inbox that receives email one-time codes when a credential does not name one. */
  codesInbox: z.string().email().optional(),
  /** A Twilio number we own, for SMS one-time codes (E.164). All three or none. */
  twilioAccountSid: z.string().min(1).optional(),
  twilioAuthToken: z.string().min(1).optional(),
  twilioNumber: z
    .string()
    .regex(/^\+\d{8,15}$/)
    .optional(),
  /** Restate admin API; set to self-register this worker on start (Docker/k8s). */
  restateAdminUrl: z.string().url().optional(),
  /** How Restate reaches this worker, for self-registration: http://worker:9081 in compose. */
  restateEndpointUrl: z.string().url().optional(),
});

export type Settings = z.infer<typeof schema>;

export const ENV_KEYS = {
  restateIngressUrl: "RESTATE_INGRESS_URL",
  restateAuthToken: "RESTATE_AUTH_TOKEN",
  cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
  cloudflareAccountId: "CLOUDFLARE_ACCOUNT_ID",
  googleServiceAccount: "GOOGLE_SERVICE_ACCOUNT",
  googleAdminUser: "GOOGLE_ADMIN_USER",
  rosterSsmParam: "ROSTER_SSM_PARAM",
  awsRegion: "AWS_REGION",
  notifyTo: "NOTIFY_TO",
  notifyFrom: "NOTIFY_FROM",
  dmarcRua: "DMARC_RUA",
  githubToken: "GITHUB_TOKEN",
  wrenRepo: "WREN_REPO",
  browser: "BROWSER",
  browserbaseApiKey: "BROWSERBASE_API_KEY",
  browserbaseProjectId: "BROWSERBASE_PROJECT_ID",
  profilesDir: "PROFILES_DIR",
  browserChannel: "BROWSER_CHANNEL",
  artifactsDir: "ARTIFACTS_DIR",
  recordingsDir: "RECORDINGS_DIR",
  logLevel: "LOG_LEVEL",
  restatePort: "RESTATE_PORT",
  uiPort: "UI_PORT",
  uiToken: "UI_TOKEN",
  uiHost: "UI_HOST",
  webhookUrl: "WEBHOOK_URL",
  webhookToken: "WEBHOOK_TOKEN",
  llmProvider: "LLM_PROVIDER",
  llmModel: "LLM_MODEL",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  openaiBaseUrl: "OPENAI_BASE_URL",
  memory: "MEMORY",
  backboardApiKey: "BACKBOARD_API_KEY",
  backboardAssistant: "BACKBOARD_ASSISTANT",
  guards: "GUARDS",
  credentialsFile: "CREDENTIALS_FILE",
  codesInbox: "CODES_INBOX",
  twilioAccountSid: "TWILIO_ACCOUNT_SID",
  twilioAuthToken: "TWILIO_AUTH_TOKEN",
  twilioNumber: "TWILIO_NUMBER",
  restateAdminUrl: "RESTATE_ADMIN_URL",
  restateEndpointUrl: "RESTATE_ENDPOINT_URL",
} as const satisfies Record<keyof Settings, string>;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const raw: Record<string, string> = {};
  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const value = env[key];
    if (value !== undefined && value !== "") raw[field] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `${ENV_KEYS[i.path[0] as keyof Settings]}: ${i.message}`,
    );
    throw new Error(`invalid settings:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Load `.env` from the repo root (the nearest ancestor holding package.json). Values already in the env win. */
export function loadEnvFile(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) break;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
  const file = join(dir, ".env");
  if (!existsSync(file)) return dir;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
  return dir;
}
