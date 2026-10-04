/**
 * Entering an owner (designs/2026-09-30-owner-keys.md): accounts are the
 * owner's, tools are the operator's. `enterOwner` rewrites `process.env`
 * once at startup, so every later reader (settings, sites, flows, compiled
 * secrets) sees the operator's tools and the owner's accounts, never the
 * operator's accounts.
 */
import { join } from "node:path";
import { expandHome } from "../google-auth.js";
import { type AwsConfig, awsConfig, checkOwner, DEFAULT_OWNER, isDefaultOwner } from "../owner.js";
import {
  DEFAULT_OWNERS_DIR,
  ENV_KEYS,
  entered,
  loadEnvFile,
  loadSettings,
  markEntered,
  OWNER_PATHS,
  ownerDir,
  readDotenv,
  type Settings,
} from "./config.js";

type Key = keyof Settings;

/** Settings that are an owner's accounts or places: only the owner's env sets them. */
export const OWNER_SETTINGS = [
  "cloudflareApiToken",
  "cloudflareAccountId",
  "googleServiceAccount",
  "googleWorkspaceDomain",
  "googleAdminUser",
  "rosterSsmParam",
  "notifyFrom",
  "receiptsTo",
  "dmarcRua",
  "githubToken",
  "wrenRepo",
  "browserCdpUrl",
  "ownBrowser",
  "ownBrowserSites",
  "codesInbox",
  "accounts",
  "phoneNumber",
  "phoneMessagesDb",
  "backboardAssistant",
] as const satisfies readonly Key[];

/** Per process: the operator's value is the default, an owner may pick its own (two workers on one machine need two ports). */
export const PROCESS_SETTINGS = [
  "restatePort",
  "uiPort",
  "oauthPort",
  "logLevel",
] as const satisfies readonly Key[];

/** Tools the operator pays for and every owner uses. */
export const OPERATOR_TOOL_KEYS = new Set([
  "EXA_API_KEY",
  "NUM_EXA",
  "PERPLEXITY_API_KEY",
  "BRAVE_API_KEY",
  "JINA_API_KEY",
]);
/** `EXA_API_KEY_1..n`: Exa's key ring (`reach/key-ring.ts`). `EGRESS_`: the lines browsers leave from (`browser/egress`). */
const OPERATOR_TOOL_PREFIXES = ["LANGFUSE_", "EXA_API_KEY_", "EGRESS_"];

/** Flags about the process itself; never an owner's to set. */
const FLAGS = new Set(["AUTOBROWSE_OWNER", "AUTOBROWSE_OWNER_ROLE_ARN", "AUTOBROWSE_DEBUG"]);

/**
 * What the process itself runs by: where home is, what node loads, how it
 * reaches the network. An owner's file setting HOME would move its fixed
 * files; NODE_OPTIONS would run code.
 */
const PROCESS_NAMES = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PWD",
  "OLDPWD",
]);
const isProcessName = (name: string) =>
  PROCESS_NAMES.has(name) || /^(NODE_|DYLD_|LD_)/.test(name) || /_PROXY$/i.test(name);

/** Names an owner's secrets travel under (credentials, compiled secrets, per-account tokens, browser contexts). */
const OWNER_PREFIXES = ["AUTOBROWSE_", "BROWSERBASE_CONTEXT_", "GMAIL_"];
/** A name that holds an account or a secret, by its shape. */
const ACCOUNT_SHAPED =
  /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|_PASS|COOKIES?|DSN|CREDENTIALS?|_AUTH|_ID|_SID|_PROJECT|_ACCOUNT|_USER|_USERNAME|_EMAIL)$|[A-Z0-9]__[A-Z0-9]/i;
/** System names that look account-shaped but are not. */
const SYSTEM = new Set(["PWD", "OLDPWD", "USER", "LOGNAME"]);

const envOf = (keys: readonly Key[]) => new Set<string>(keys.map((k) => ENV_KEYS[k]));
const OWNER_ENV = envOf(OWNER_SETTINGS);
const PATH_ENV = envOf(Object.keys(OWNER_PATHS) as Key[]);
const PROCESS_ENV = envOf(PROCESS_SETTINGS);
/** Everything else in the settings is the operator's. */
const OPERATOR_ENV = new Set<string>(
  Object.values(ENV_KEYS).filter(
    (name) => !OWNER_ENV.has(name) && !PATH_ENV.has(name) && !PROCESS_ENV.has(name),
  ),
);

/** A tool key the operator pays for; every owner uses it and none sets it. */
export const isOperatorTool = (name: string) =>
  OPERATOR_TOOL_KEYS.has(name) || OPERATOR_TOOL_PREFIXES.some((p) => name.startsWith(p));

/** The operator's: an owner's env may not set it. */
const isOperators = (name: string) =>
  OPERATOR_ENV.has(name) || FLAGS.has(name) || name.startsWith("AWS_") || isOperatorTool(name);

/** What an owner's process keeps of the operator's env. */
function keeps(name: string, fromOperatorFile: ReadonlySet<string>): boolean {
  if (isOperators(name) || PROCESS_ENV.has(name)) return true;
  if (OWNER_ENV.has(name) || PATH_ENV.has(name)) return false;
  if (fromOperatorFile.has(name)) return false;
  if (OWNER_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (SYSTEM.has(name)) return true;
  return !ACCOUNT_SHAPED.test(name);
}

/**
 * For a non-default owner: drop the operator's accounts from `env`, then
 * add the owner's own `.env`. The owner's file may not set the operator's
 * settings, tools, AWS or a fixed path; that throws, naming the key (never
 * a value). The default owner's env is left as it is. Returns the owner.
 */
export function enterOwner(
  env: NodeJS.ProcessEnv,
  fromOperatorFile: Iterable<string> = [],
): string {
  const owner = checkOwner(env.AUTOBROWSE_OWNER || DEFAULT_OWNER);
  const live = env === process.env;
  // Once per process, whoever the owner: only the default owner may be entered again, as itself.
  const was = live ? entered() : null;
  if (was !== null && (was !== owner || !isDefaultOwner(owner)))
    throw new Error(`owner ${owner}: this process already entered ${was}; once per process`);
  if (isDefaultOwner(owner)) {
    if (live) markEntered(owner);
    return owner;
  }
  const operatorFile = new Set(fromOperatorFile);
  for (const name of Object.keys(env)) if (!keeps(name, operatorFile)) delete env[name];
  const ownersDir = expandHome(env[ENV_KEYS.ownersDir] || DEFAULT_OWNERS_DIR);
  const file = join(ownerDir(ownersDir, owner), ".env");
  const refused: string[] = [];
  for (const [name, value] of readDotenv(file)) {
    if (isOperators(name) || PATH_ENV.has(name) || isProcessName(name)) refused.push(name);
    else env[name] = value;
  }
  if (refused.length)
    throw new Error(
      `owner ${owner}: ${file} sets ${refused.join(", ")}; those are the operator's, the process's or fixed (designs/2026-09-30-owner-keys.md)`,
    );
  if (env === process.env) markEntered(owner);
  return owner;
}

/** Every entry point's first line: the operator's `.env`, the owner's view of it, the settings. */
export function boot(from?: string): { root: string; settings: Settings } {
  const { root, names } = loadEnvFile(from);
  enterOwner(process.env, names);
  return { root, settings: loadSettings() };
}

/** AWS client config for this process's owner (src/owner.ts): the only way autobrowse makes an AWS client. */
export const awsFor = (
  s: Pick<Settings, "owner" | "ownerRoleArn" | "awsRegion">,
  region: string = s.awsRegion,
): AwsConfig => awsConfig({ owner: s.owner, ownerRoleArn: s.ownerRoleArn, region });

/** `--owner x` or `--owner=x` anywhere before a bare `--`: read ahead of the parser, since settings load first. */
export function ownerFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return undefined;
    if (a === "--owner") return argv[i + 1];
    if (a.startsWith("--owner=")) return a.slice("--owner=".length);
  }
  return undefined;
}
