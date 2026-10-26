/** `autobrowse settings`: the settings that are not secrets, in `settings.json` (`settings-file.ts`). */
import type { Command } from "commander";
import { columns, dim, warn } from "../style.js";
import { ENV_KEYS, type Settings } from "./config.js";
import { editSetting, isSecretName, readSettings, settingsPath } from "./settings-file.js";

type Field = keyof Settings;

const fieldOf = (name: string): Field => {
  const field = (Object.keys(ENV_KEYS) as Field[]).find((f) => f === name || ENV_KEYS[f] === name);
  if (!field) throw new Error(`${name}: no such setting`);
  return field;
};

const shown = (v: unknown) =>
  v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);

export function registerSettingsCommands(
  program: Command,
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = settingsPath(env);
  const applies = () =>
    console.log(dim("new processes read it; the desk on its next deploy or restart"));
  const cmd = program
    .command("settings [name]")
    .description(
      "Settings that are not secrets and where each comes from: settings.json, the env, or the default; secrets stay in `env`",
    )
    .option("--all", "every setting, defaults too")
    .action((name: string | undefined, o: { all?: boolean }) => {
      const file = readSettings(path);
      const rows: string[][] = [];
      for (const f of name ? [fieldOf(name)] : (Object.keys(ENV_KEYS) as Field[])) {
        const envName = ENV_KEYS[f];
        const set = env[envName];
        const source =
          file[f] !== undefined && set === file[f]
            ? "settings.json"
            : set !== undefined
              ? "env"
              : "default";
        if (!name && !o.all && source === "default") continue;
        const value = isSecretName(envName)
          ? warn(set === undefined ? "(secret, unset)" : "(secret, set)")
          : shown(settings[f]);
        rows.push([f, dim(envName), value, dim(source)]);
      }
      for (const line of columns(rows)) console.log(line);
      if (!name) console.log(dim(path));
    });
  cmd
    .command("set <name> <value>")
    .description(
      "One setting into settings.json, checked as the boot checks it; a field or env name",
    )
    .action((name: string, value: string) => {
      const { field, before, after } = editSetting(path, name, value);
      console.log(`${path}: ${field} ${before ?? "(unset)"} -> ${after}`);
      if (env[ENV_KEYS[field]] !== undefined && env[ENV_KEYS[field]] !== before)
        console.log(warn(`${ENV_KEYS[field]} is set in the env; it wins over the file`));
      applies();
    });
  cmd
    .command("unset <name>")
    .description("Back to the default (or the env's value)")
    .action((name: string) => {
      const { field, before } = editSetting(path, name, null);
      console.log(`${path}: ${field} ${before ?? "(unset)"} -> (unset)`);
      applies();
    });
}
