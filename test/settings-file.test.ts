import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import {
  applySettings,
  editSetting,
  isSecretName,
  readSettings,
} from "../src/app/settings-file.js";

const fresh = () => join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json");

describe("settings.json", () => {
  it("fills the env where it sets nothing; the env wins; the default stays for the rest", () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify({ logLevel: "debug", BROWSER_KEEP_MAX: 4, pace: "fast" }));
    const env: NodeJS.ProcessEnv = { PACE: "human" };
    expect(applySettings(env, path)).toEqual(["LOG_LEVEL", "BROWSER_KEEP_MAX"]);
    const s = loadSettings(env);
    expect(s.logLevel).toBe("debug");
    expect(s.browserKeepMax).toBe(4);
    expect(s.pace).toBe("human");
    expect(s.browserKeepMinutes).toBe(10);
  });

  it("refuses a secret, an unknown name and a value its check refuses", () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify({ uiToken: "x" }));
    expect(() => readSettings(path)).toThrow(/secret.*env set UI_TOKEN/);
    writeFileSync(path, JSON.stringify({ nope: 1 }));
    expect(() => readSettings(path)).toThrow(/nope: no such setting/);
    writeFileSync(path, JSON.stringify({ pace: "slow" }));
    expect(() => readSettings(path)).toThrow(/pace/);
    expect(() => editSetting(fresh(), "OPENAI_API_KEY", "k")).toThrow(/secret/);
    expect(() => editSetting(fresh(), "browserKeepMax", "0")).toThrow(/browserKeepMax/);
  });

  it("edits one setting, sorted, and notes before and after beside the file", () => {
    const path = fresh();
    expect(editSetting(path, "PACE", "fast")).toEqual({
      field: "pace",
      before: null,
      after: "fast",
    });
    editSetting(path, "logLevel", "warn");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["logLevel", "pace"]);
    expect(editSetting(path, "pace", null)).toEqual({ field: "pace", before: "fast", after: null });
    expect(readSettings(path)).toEqual({ logLevel: "warn" });
    const log = readFileSync(join(path, "..", "settings-changes.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(log.map((l) => JSON.parse(l).field)).toEqual(["pace", "logLevel", "pace"]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("knows a secret by its name", () => {
    for (const n of [
      "UI_TOKEN",
      "SENTRY_DSN",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "RESTATE_IDENTITY_KEY",
    ])
      expect(isSecretName(n)).toBe(true);
    for (const n of ["CLOUDFLARE_ACCOUNT_ID", "LOG_LEVEL", "SHOTS_BUCKET", "TRACES_TO"])
      expect(isSecretName(n)).toBe(false);
  });
});
