/**
 * The operator's settings that are not secrets, in `settings.json`
 * (`~/.config/autobrowse/settings.json`; `SETTINGS_FILE` moves it), by the
 * setting's field name:
 *
 *   { "browser": "local", "logLevel": "info", "browserKeepMax": 2 }
 *
 * Secrets stay in the env file and the store. At boot each value fills its
 * env name where the process env sets nothing, before the env file loads:
 * process env, then this file, then the env file, then the default. An
 * owner's process drops the owner's own settings as before (`enterOwner`).
 * A secret-shaped or unknown name, or a value its check refuses, stops the
 * boot and names the field. Each `editSetting` notes the value before and
 * after in `settings-changes.jsonl` beside the file.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { expandHome } from "../google/auth.js";
import { checkSetting, ENV_KEYS, type Settings } from "./config.js";

type Field = keyof Settings;
export type SettingsValues = Partial<Record<Field, string>>;

const fileSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** An env name that holds a secret, by its shape: it belongs in the env file and the store. */
export const isSecretName = (name: string) =>
  /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|_PASS|DSN|HEADERS|_AUTH)$/.test(name);

const SETTING_NAMES = new Set<string>(Object.values(ENV_KEYS));

/** An env name `settings.json` holds, not the env file: a setting and no secret. */
export const isSettingName = (name: string) => SETTING_NAMES.has(name) && !isSecretName(name);

/** The field for a field or env name that `settings.json` may hold: a setting, not a secret. */
export function settingField(name: string): Field {
  const field = (Object.keys(ENV_KEYS) as Field[]).find((f) => f === name || ENV_KEYS[f] === name);
  if (!field) throw new Error(`${name}: no such setting`);
  if (isSecretName(ENV_KEYS[field]))
    throw new Error(
      `${name}: a secret; it goes in the env store (\`autobrowse env set ${ENV_KEYS[field]}\`)`,
    );
  return field;
}

export const settingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  expandHome(env.SETTINGS_FILE || "~/.config/autobrowse/settings.json");

/** The file's settings as strings, as the env gives them; none when it is missing. */
export function readSettings(path: string): SettingsValues {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: not JSON: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues[0]?.message}`);
  const out: SettingsValues = {};
  for (const [name, v] of Object.entries(parsed.data)) {
    const field = settingField(name);
    const value = String(v);
    const bad = checkSetting(field, value);
    if (bad) throw new Error(`${path}: ${field}: ${bad}`);
    out[field] = value;
  }
  return out;
}

/** Fill `env` from the file where it sets nothing; the env names filled. */
export function applySettings(env: NodeJS.ProcessEnv, path = settingsPath(env)): string[] {
  const filled: string[] = [];
  for (const [field, value] of Object.entries(readSettings(path)) as [Field, string][]) {
    const name = ENV_KEYS[field];
    if (env[name] !== undefined) continue;
    env[name] = value;
    filled.push(name);
  }
  return filled;
}

/** Set (`value`) or drop (`null`) one setting; the value before and after, noted beside the file. */
export function editSetting(
  path: string,
  name: string,
  value: string | null,
): { field: Field; before: string | null; after: string | null } {
  const field = settingField(name);
  if (value !== null) {
    const bad = checkSetting(field, value);
    if (bad) throw new Error(`${field}: ${bad}`);
  }
  const all = readSettings(path);
  const before = all[field] ?? null;
  if (value === null) delete all[field];
  else all[field] = value;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(tmp, path);
  appendFileSync(
    join(dirname(path), "settings-changes.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), field, before, after: value })}\n`,
  );
  return { field, before, after: value };
}
