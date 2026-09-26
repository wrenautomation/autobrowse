/**
 * Mint a Cal.com API key on Settings → Developer → API keys, one that never
 * expires (so nothing renews it). Mapped in explore mode on 2026-09-25:
 *   button "New"                      opens dialog "Create an API key"
 *   textbox "Name this key"
 *   button "Never expires"            a toggle; while off, a combobox
 *                                     "Expiration date" shows (30 days)
 *   button "Create"                   dialog "API key created successfully":
 *                                     textbox "API key" holds it, shown once
 */
import type { SecretSink } from "../../deps/sink.js";
import { defineFlow } from "../flow.js";

export const CALCOM_API_KEY = "CALCOM_API_KEY";

export interface CalcomKeyInput {
  name: string;
  /** Where the key is kept; it is never printed or returned. */
  sink?: SecretSink;
}

/** `cal_live_…` (`cal_` on older accounts). */
const KEY = /^cal_[A-Za-z0-9_]{20,}$/;

export const calcomApiKey = defineFlow<CalcomKeyInput, { kept: string }>({
  site: "calcom",
  name: "api-key",
  async run(fp, input) {
    await fp.open("https://app.cal.com/settings/developer/api-keys");
    await fp.act({ kind: "click" }, { role: "button", name: "New" }, { goal: "start a key" });
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "Name this key" },
      { goal: "name the key" },
    );
    const expires = fp.page.getByRole("combobox", { name: "Expiration date" });
    if (await expires.isVisible().catch(() => false))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Never expires" },
        { goal: "a key that never lapses" },
      );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create" },
      { goal: "mint the key", irreversible: true },
    );
    // Shown once, as the value of a read-only textbox in "API key created successfully".
    const box = fp.page.getByRole("textbox", { name: "API key" });
    let key: string | undefined;
    for (let i = 0; i < 10 && !key; i++) {
      await fp.wait(1_000);
      key = (await box.inputValue({ timeout: 1_000 }).catch(() => "")).match(KEY)?.[0];
    }
    if (!key) return fp.human("the dialog did not show a key");
    await input.sink?.put(CALCOM_API_KEY, key);
    return { kept: CALCOM_API_KEY };
  },
});
