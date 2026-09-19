/**
 * Warmup lives in Instantly (warmup only; sends go through wren). Adding a
 * Google inbox there is an OAuth consent the inbox's own Google session
 * must give, so the flow checks whether the inbox is listed and otherwise
 * hands the whole add to a person in the recorded profile.
 */
import { defineFlow } from "../flow.js";

const ACCOUNTS = "https://app.instantly.ai/app/accounts";

export const instantlyWarmup = defineFlow<{ email: string }, "enrolled" | "already">({
  site: "instantly",
  name: "warmup",
  async run(fp, { email }) {
    await fp.open(ACCOUNTS);
    const listed = await fp.page
      .getByText(email, { exact: true })
      .isVisible()
      .catch(() => false);
    if (listed) return "already";
    return fp.human(
      `add ${email} with warmup on: autobrowse record instantly, Add new → Google, consent as ${email}; then approve`,
    );
  },
});
