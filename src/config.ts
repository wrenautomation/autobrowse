/**
 * Settings from the environment. Every value that is a credential stays in
 * this object and in request headers; nothing here is ever logged whole.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  /** Restate Cloud ingress: provision's own objects and wren's loops share the env. */
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
  profilesDir: z.string().min(1).default("~/.config/provision/profiles"),
  logLevel: z.string().default("info"),
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
  logLevel: "LOG_LEVEL",
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
