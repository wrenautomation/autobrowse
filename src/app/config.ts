/**
 * Settings from the environment. Every value that is a credential stays in
 * this object and in request headers; nothing here is ever logged whole.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** An IANA zone Chrome knows (`America/New_York`, or an alias like `Asia/Kolkata`); a typo would leave the browser on UTC unsaid. */
const timeZone = z.string().refine(
  (tz) => {
    // Intl takes any case; Chrome reads TZ as a file name on Linux, so `america/new_york` fails there.
    if (!tz.split("/").every((part) => /^[A-Z]/.test(part))) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "not an IANA time zone (America/New_York)" },
);

const schema = z.object({
  /** Restate ingress: Restate Cloud in prod (wren's loops share the env), a local restate-server otherwise. */
  restateIngressUrl: z.string().url().default("http://localhost:8080"),
  restateAuthToken: z.string().min(1).optional(),
  /** Cloudflare: registrar of record and DNS for every fleet domain. */
  cloudflareApiToken: z.string().min(1).optional(),
  cloudflareAccountId: z.string().min(1).optional(),
  /** The Workspace service account (path or JSON) and the super admin it acts as. */
  googleServiceAccount: z.string().min(1).optional(),
  /** The Workspace domain that service account is delegated for; its inboxes read without a consent. */
  googleWorkspaceDomain: z.string().min(1).optional(),
  googleAdminUser: z.string().email().optional(),
  /** Where wren reads its roster. */
  rosterSsmParam: z.string().min(1).default("/wren/prod/senders_config"),
  awsRegion: z.string().min(1).default("us-east-1"),
  /** Who gets approval requests and completion notes, and the fleet inbox they come from. */
  notifyTo: z.string().email().optional(),
  notifyFrom: z.string().email().optional(),
  /** Where each charge's receipt is emailed; NOTIFY_TO when unset. */
  receiptsTo: z.string().email().optional(),
  /** DMARC aggregate reports go here. */
  dmarcRua: z.string().email().optional(),
  /** GitHub token that may dispatch wren's deploy workflow (roster reload). */
  githubToken: z.string().min(1).optional(),
  wrenRepo: z.string().min(1).default("wrenautomation/wren"),
  /** Browser tier: a local Chromium with a persistent profile, Browserbase, or a running browser/Electron app by its CDP endpoint. */
  browser: z.enum(["local", "browserbase", "cdp"]).default("local"),
  browserbaseApiKey: z.string().min(1).optional(),
  browserbaseProjectId: z.string().min(1).optional(),
  browserCdpUrl: z.string().url().optional(),
  /**
   * The person's own browser (`chrome`, the default; `opera-gx`, `brave`,
   * `edge`, or its data dir), attached for the sites in `ownBrowserSites` only.
   */
  ownBrowser: z.string().min(1).optional(),
  /** Comma list of sites that run in the own browser, e.g. `github`. */
  ownBrowserSites: z.string().optional(),
  /** A static ISP/residential proxy URL with its login (`browser/proxy`); never printed. */
  browserProxy: z.string().min(1).optional(),
  /** Comma list of sites whose local browser goes through `browserProxy`, e.g. `x,linkedin`. */
  browserProxySites: z.string().optional(),
  /** The zone a local browser says, where its IP is (`America/New_York` on us-east-1); the machine's when unset. */
  browserTimezone: timeZone.optional(),
  /** The zone a proxied browser says: the proxy's city. */
  browserProxyTimezone: timeZone.optional(),
  /** Persistent browser profiles (logins survive between runs). */
  profilesDir: z.string().min(1).default("~/.config/autobrowse/profiles"),
  /** Local browser: the installed Chrome (default, falls back) or Playwright's chromium (containers). */
  browserChannel: z.enum(["chrome", "chromium"]).default("chrome"),
  /** Headless by default; false on a laptop worker, since Cloudflare's bot check passes only with a window. */
  browserHeadless: z
    .string()
    .default("true")
    .transform((v) => !/^(false|0|no)$/i.test(v)),
  /**
   * The browser a worker run used stays open this long for the next run on
   * the same site: a check-in with you (a gate, a hand-off) keeps the page it
   * was on. 0 = close after every run.
   */
  browserKeepMinutes: z.coerce.number().min(0).default(10),
  /** At most this many browsers kept open at once (~300 MB each). */
  browserKeepMax: z.coerce.number().int().min(1).default(2),
  /** How the browser acts: `human` (paced like a person; sites watch for the other kind) or `fast` (demos, tests). */
  pace: z.enum(["human", "fast"]).default("human"),
  /** Draw the pointer on the page as a dot, to watch a headed run; it adds an element sites can see. */
  showPointer: z
    .string()
    .default("false")
    .transform((v) => /^(true|1|yes)$/i.test(v)),
  /** Screenshots and Playwright traces from flows that needed a person or failed. */
  artifactsDir: z.string().min(1).default("~/.config/autobrowse/artifacts"),
  /** Locator fixes the repairer found, tried first next run until the flow's source is changed (`repairs`). */
  fixesFile: z.string().min(1).default("~/.config/autobrowse/fixes.json"),
  /** Pages seen before on each site and what worked on them (`screens`): a walk's screen, a click past an interrupt. */
  screensFile: z.string().min(1).default("~/.config/autobrowse/screens.json"),
  /** Today's use of each site's daily caps, per account (LinkedIn reads). */
  capsFile: z.string().min(1).default("~/.config/autobrowse/caps.json"),
  /** Raw Playwright codegen output from `record --flow`; may hold typed secrets, never committed. */
  recordingsDir: z.string().min(1).default("recordings"),
  /** Bucket screenshots ship to (with their aria and failure JSON); unset = they stay local. */
  shotsBucket: z.string().min(1).optional(),
  /** An S3-compatible endpoint instead of S3 (Cloudflare R2). */
  shotsEndpoint: z.string().url().optional(),
  /** First key segment: which machine took the shot. The box sets `box`. */
  shotsMachine: z.string().min(1).optional(),
  /** A worker ships new shots this often, and before an idle stop; 0 = only then. */
  shotsEveryMinutes: z.coerce.number().min(0).default(60),
  logLevel: z.string().default("info"),
  /** Where the Restate endpoint listens; the UI is on `uiPort`. */
  restatePort: z.coerce.number().int().default(9081),
  uiPort: z.coerce.number().int().default(9080),
  /** Loopback port OAuth consents redirect to; the OAuth clients register http://127.0.0.1:<port>/oauth/callback. */
  oauthPort: z.coerce.number().int().default(9400),
  /** Bearer the UI and inbound hooks need for anything that changes a run. Unset = local only, no auth. */
  uiToken: z.string().min(1).optional(),
  /** Agent keys (hashes and scopes, never a key): who may see and call what (`access/keys`). */
  accessFile: z.string().min(1).default("~/.config/autobrowse/access.json"),
  /** Bind address for the UI; see `startUiServer`. */
  uiHost: z.string().min(1).optional(),
  /** Every run event, as JSON, to one URL (iMessage/Slack/dashboards). */
  webhookUrl: z.string().url().optional(),
  webhookToken: z.string().min(1).optional(),
  /** Model behind the compiler's polish and the locator repairer. No key = both off. */
  llmProvider: z.enum(["anthropic", "openai", "cohere", "claude-code"]).default("anthropic"),
  llmModel: z.string().min(1).optional(),
  anthropicApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  openaiBaseUrl: z.string().url().optional(),
  cohereApiKey: z.string().optional(),
  /**
   * The model that looks at captcha pictures. Unset: Anthropic when its key
   * is here (Claude sees), else the model above (which may be text only).
   */
  eyesProvider: z.enum(["anthropic", "openai", "cohere", "claude-code"]).optional(),
  eyesModel: z.string().min(1).optional(),
  /** Tokens (in + out) every model call may spend per UTC day, all processes together; 0 = no cap. */
  llmDailyTokens: z.coerce.number().int().min(0).default(3_000_000),
  /**
   * Flows to watch step by step: `all`, a site (`cloudflare`), or `site/flow`,
   * comma separated. Each step leaves a masked screenshot and its aria tree,
   * and the trace is kept even when the run works. Read with `autobrowse watched`.
   */
  watchFlows: z.string().optional(),
  /** Tries at a captcha before it is handed to you; 0 = hand it over at once. */
  captchaAttempts: z.coerce.number().int().min(0).default(3),
  /** Memory between runs (repairs that worked, hand-off notes). `none` keeps it in-process. */
  memory: z.enum(["backboard", "none"]).default("none"),
  backboardApiKey: z.string().min(1).optional(),
  backboardAssistant: z.string().min(1).default("autobrowse"),
  /** Where minted credentials go: the local env file, or SSM (prefix `secretsPrefix`). */
  secretSink: z.enum(["envfile", "ssm"]).default("envfile"),
  envFile: z.string().min(1).default(".env"),
  /** Which guards stay on: `all`, `none`, or a comma list (purchase, password, irreversible). */
  guards: z.string().default("all"),
  /** Sentry: failed runs, failed steps and crashes become issues. Off when unset. */
  /** OTLP/HTTP traces for every model call (Langfuse, Honeycomb, Grafana …); off when unset. */
  otlpEndpoint: z.string().url().optional(),
  otlpHeaders: z.string().optional(),
  otlpServiceName: z.string().min(1).default("autobrowse"),
  sentryDsn: z.string().url().optional(),
  sentryEnvironment: z.string().min(1).default("local"),
  /**
   * Stop the machine after this many idle minutes (no run, flow, site call, agent
   * session or UI request): a box that bills nothing between jobs. 0 = never.
   * Needs the instance role to stop itself (deploy/terraform box policy).
   */
  idleStopMinutes: z.coerce.number().min(0).default(0),
  /** This machine's EC2 instance id; read from IMDS when unset. */
  instanceId: z.string().min(1).optional(),
  /**
   * Spend policy on the payment gate. Sites the gate may say yes for by
   * itself (comma list); one purchase at or under AUTO_YES_UNDER on one of
   * them is a yes without asking while today's total stays under DAILY_CAP;
   * over HARD_CAP is refused before anyone is asked. Defaults: ask always,
   * no ceiling.
   */
  spendAllow: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  spendAutoYesUnder: z.coerce.number().min(0).default(0),
  spendDailyCap: z.coerce.number().min(0).default(0),
  spendHardCap: z.coerce.number().min(0).optional(),
  /** Run the evaluator every N hours and tell the person what deserves a workflow; 0 = off. */
  evaluateEveryHours: z.coerce.number().min(0).default(0),
  /** Let the evaluator's proposals be explored, saved and compiled with nobody clicking. */
  autoBuild: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** A compiled step that fails is finished by the agent and rewritten from what it did, then proven. */
  autoHeal: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Site credentials for automated sign-in; 0600 JSON. Env (`AUTOBROWSE_CRED_*`) is read first. */
  credentialsFile: z.string().min(1).default("~/.config/autobrowse/credentials.json"),
  /** William's cards, sealed with their own keychain key; backed up to SSM /wallet (no machine role reads it). */
  walletFile: z.string().min(1).default("~/.config/autobrowse/wallet.sealed"),
  /** Hosts a debit card may pay on (banking, government), comma separated; empty = debit never. */
  walletDebitHosts: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** How the credential file is sealed: keychain (macOS, default there), none (containers; credentials come from env). */
  credentialsCipher: z
    .enum(["keychain", "none"])
    .default(process.platform === "darwin" ? "keychain" : "none"),
  /** The shared credential store (SSM, the env store): the truth every read asks first and every write lands in; the file here is the offline copy. */
  credentialsShared: z.enum(["ssm", "off"]).default("ssm"),
  /** Inbox that receives email one-time codes when a credential does not name one. */
  codesInbox: z.string().email().optional(),
  /** The person's accounts and what each is for (`autobrowse accounts`); addresses only. */
  accountsFile: z.string().min(1).default("~/.config/autobrowse/accounts.json"),
  /** The same for a box with no file: `a@x.com=pays;b@y.com=default,signup`. */
  accounts: z.string().optional(),
  /**
   * A personal phone paired with this Mac (E.164): SMS codes are read from
   * Messages' database, notes go back over iMessage. Local, no vendor.
   */
  phoneNumber: z
    .string()
    .regex(/^\+\d{8,15}$/)
    .optional(),
  phoneMessagesDb: z.string().min(1).optional(),
  /**
   * Linq: iMessage from a number we own, no Mac needed. Notes and gates go
   * to `linqTo` (defaults to phoneNumber); SMS codes are read from the
   * same chats. The webhook secret verifies what Linq posts to /hooks/linq.
   */
  linqApiKey: z.string().min(1).optional(),
  linqNumber: z
    .string()
    .regex(/^\+\d{8,15}$/)
    .optional(),
  linqTo: z
    .string()
    .regex(/^\+\d{8,15}$/)
    .optional(),
  linqWebhookSecret: z.string().min(1).optional(),
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
  /**
   * Restate Cloud, no inbound port: the worker dials out to the env's tunnel and
   * registers the tunnel URL. All four or none; `restateAuthToken` is the key.
   * The identity key is also honoured by the plain listener (a public endpoint).
   */
  restateTunnelName: z.string().min(1).optional(),
  restateEnvironmentId: z
    .string()
    .regex(/^env_[a-z0-9]+$/)
    .optional(),
  restateCloudRegion: z.string().min(1).optional(),
  restateIdentityKey: z
    .string()
    .regex(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]+$/)
    .optional(),
});

export type Settings = z.infer<typeof schema>;

export const ENV_KEYS = {
  restateIngressUrl: "RESTATE_INGRESS_URL",
  restateAuthToken: "RESTATE_AUTH_TOKEN",
  cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
  cloudflareAccountId: "CLOUDFLARE_ACCOUNT_ID",
  googleServiceAccount: "GOOGLE_SERVICE_ACCOUNT",
  googleWorkspaceDomain: "GOOGLE_WORKSPACE_DOMAIN",
  googleAdminUser: "GOOGLE_ADMIN_USER",
  rosterSsmParam: "ROSTER_SSM_PARAM",
  awsRegion: "AWS_REGION",
  notifyTo: "NOTIFY_TO",
  notifyFrom: "NOTIFY_FROM",
  receiptsTo: "RECEIPTS_TO",
  dmarcRua: "DMARC_RUA",
  githubToken: "GITHUB_TOKEN",
  wrenRepo: "WREN_REPO",
  browser: "BROWSER",
  browserbaseApiKey: "BROWSERBASE_API_KEY",
  browserbaseProjectId: "BROWSERBASE_PROJECT_ID",
  browserCdpUrl: "BROWSER_CDP_URL",
  ownBrowser: "OWN_BROWSER",
  ownBrowserSites: "OWN_BROWSER_SITES",
  browserProxy: "BROWSER_PROXY",
  browserProxySites: "BROWSER_PROXY_SITES",
  browserTimezone: "BROWSER_TIMEZONE",
  browserProxyTimezone: "BROWSER_PROXY_TIMEZONE",
  profilesDir: "PROFILES_DIR",
  browserChannel: "BROWSER_CHANNEL",
  browserHeadless: "BROWSER_HEADLESS",
  browserKeepMinutes: "BROWSER_KEEP_MINUTES",
  browserKeepMax: "BROWSER_KEEP_MAX",
  pace: "PACE",
  showPointer: "SHOW_POINTER",
  artifactsDir: "ARTIFACTS_DIR",
  fixesFile: "FIXES_FILE",
  screensFile: "SCREENS_FILE",
  capsFile: "CAPS_FILE",
  recordingsDir: "RECORDINGS_DIR",
  shotsBucket: "SHOTS_BUCKET",
  shotsEndpoint: "SHOTS_ENDPOINT",
  shotsMachine: "SHOTS_MACHINE",
  shotsEveryMinutes: "SHOTS_EVERY_MINUTES",
  logLevel: "LOG_LEVEL",
  restatePort: "RESTATE_PORT",
  uiPort: "UI_PORT",
  oauthPort: "OAUTH_PORT",
  uiToken: "UI_TOKEN",
  accessFile: "ACCESS_FILE",
  uiHost: "UI_HOST",
  webhookUrl: "WEBHOOK_URL",
  webhookToken: "WEBHOOK_TOKEN",
  llmProvider: "LLM_PROVIDER",
  llmModel: "LLM_MODEL",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  openaiBaseUrl: "OPENAI_BASE_URL",
  cohereApiKey: "COHERE_API_KEY",
  eyesProvider: "EYES_PROVIDER",
  eyesModel: "EYES_MODEL",
  llmDailyTokens: "LLM_DAILY_TOKENS",
  captchaAttempts: "CAPTCHA_ATTEMPTS",
  watchFlows: "WATCH_FLOWS",
  memory: "MEMORY",
  backboardApiKey: "BACKBOARD_API_KEY",
  backboardAssistant: "BACKBOARD_ASSISTANT",
  secretSink: "SECRET_SINK",
  envFile: "ENV_FILE",
  guards: "GUARDS",
  otlpEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
  otlpHeaders: "OTEL_EXPORTER_OTLP_HEADERS",
  otlpServiceName: "OTEL_SERVICE_NAME",
  sentryDsn: "SENTRY_DSN",
  sentryEnvironment: "SENTRY_ENVIRONMENT",
  evaluateEveryHours: "EVALUATE_EVERY_HOURS",
  idleStopMinutes: "IDLE_STOP_MINUTES",
  instanceId: "AUTOBROWSE_INSTANCE_ID",
  spendAllow: "SPEND_ALLOW",
  spendAutoYesUnder: "SPEND_AUTO_YES_UNDER",
  spendDailyCap: "SPEND_DAILY_CAP",
  spendHardCap: "SPEND_HARD_CAP",
  autoBuild: "AUTO_BUILD",
  autoHeal: "AUTO_HEAL",
  credentialsFile: "CREDENTIALS_FILE",
  walletFile: "WALLET_FILE",
  walletDebitHosts: "WALLET_DEBIT_HOSTS",
  credentialsCipher: "CREDENTIALS_CIPHER",
  credentialsShared: "CREDENTIALS_SHARED",
  codesInbox: "CODES_INBOX",
  accountsFile: "ACCOUNTS_FILE",
  accounts: "AUTOBROWSE_ACCOUNTS",
  phoneNumber: "PHONE_NUMBER",
  phoneMessagesDb: "PHONE_MESSAGES_DB",
  linqApiKey: "LINQ_API_KEY",
  linqNumber: "LINQ_NUMBER",
  linqTo: "LINQ_TO",
  linqWebhookSecret: "LINQ_WEBHOOK_SECRET",
  twilioAccountSid: "TWILIO_ACCOUNT_SID",
  twilioAuthToken: "TWILIO_AUTH_TOKEN",
  twilioNumber: "TWILIO_NUMBER",
  restateAdminUrl: "RESTATE_ADMIN_URL",
  restateEndpointUrl: "RESTATE_ENDPOINT_URL",
  restateTunnelName: "RESTATE_TUNNEL_NAME",
  restateEnvironmentId: "RESTATE_ENVIRONMENT_ID",
  restateCloudRegion: "RESTATE_CLOUD_REGION",
  restateIdentityKey: "RESTATE_IDENTITY_KEY",
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
