/**
 * Discord's developer portal, the two legs no API covers: minting the bot
 * (an application, then its token, shown once) and adding it to a server
 * (a consent as the signed-in user). Everything after is the bot's REST
 * calls (`src/sites/discord.ts`).
 *
 * UNVERIFIED until mapped live in explore: written from Discord's portal as
 * of 2026 (button "New Application", dialog with a name and a terms box,
 * the Bot page's "Reset Token" then "Yes, do it!").
 */
import type { SecretSink } from "../../deps/sink.js";
import { DISCORD_APP_ID, DISCORD_BOT_TOKEN, inviteUrl } from "../../sites/discord.js";
import { defineFlow, type FlowPage } from "../flow.js";

const PORTAL = "https://discord.com/developers/applications";
const APP_URL = /developers\/applications\/(\d{5,25})/;
/** `<base64 user id>.<timestamp>.<hmac>`. */
const BOT_TOKEN = /[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,45}/;
const HCAPTCHA = { css: 'iframe[src*="hcaptcha"]' } as const;

async function passCaptcha(fp: FlowPage, where: string): Promise<void> {
  if (!(await fp.has(HCAPTCHA, 2_000))) return;
  const got = await fp.captcha();
  if (!got.solved) fp.human(`discord: the captcha at ${where} is a person's (${got.reason})`);
}

export interface DiscordBotInput {
  /** The application's (and the bot's) name. */
  name: string;
  /** Where the app id and token are kept; the token is never printed or returned. */
  sink?: SecretSink;
}

export const discordBotToken = defineFlow<DiscordBotInput, { appId: string; kept: string }>({
  site: "discord",
  name: "bot-token",
  async run(fp, input) {
    await fp.open(PORTAL);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/new application/i" },
      {
        goal: "start an application",
      },
    );
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "/name/i" },
      {
        goal: "name the application",
      },
    );
    await fp.act({ kind: "click" }, { role: "checkbox" }, { goal: "agree to the developer terms" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^create$/i" },
      {
        goal: "create the application",
      },
    );
    await passCaptcha(fp, "create application");
    if (!(await fp.waitForUrl(APP_URL, 30_000)))
      return fp.human("the new application did not open");
    const appId = fp.url().match(APP_URL)?.[1] ?? "";
    await input.sink?.put(DISCORD_APP_ID, appId);

    await fp.open(`${PORTAL}/${appId}/bot`);
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/reset token/i" },
      {
        goal: "mint the bot token",
        irreversible: true,
      },
    );
    if (await fp.has({ role: "button", name: "/yes, do it/i" }, 5_000))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/yes, do it/i" },
        {
          goal: "confirm the reset",
        },
      );
    if (await fp.has({ role: "textbox", name: "/auth.*code|backup code/i" }, 3_000))
      return fp.human("Discord wants a 2FA code to reset the token");
    let token: string | undefined;
    for (let i = 0; i < 10 && !token; i++) {
      await fp.wait(1_000);
      token = (await fp.text()).match(BOT_TOKEN)?.[0];
    }
    if (!token) return fp.human("the Bot page did not show a token");
    await input.sink?.put(DISCORD_BOT_TOKEN, token);
    return { appId, kept: DISCORD_BOT_TOKEN };
  },
});

export interface DiscordInviteInput {
  appId: string;
  /** The server, by id (preselected) or by its name in the picker. */
  guild?: string;
}

export const discordInvite = defineFlow<DiscordInviteInput, { added: true }>({
  site: "discord",
  name: "invite",
  async run(fp, input) {
    const byId = input.guild && /^\d+$/.test(input.guild) ? input.guild : undefined;
    await fp.open(inviteUrl(input.appId, byId));
    if (input.guild && !byId) {
      await fp.act({ kind: "click" }, { role: "combobox" }, { goal: "open the server picker" });
      await fp.act(
        { kind: "click" },
        { role: "option", name: input.guild },
        {
          goal: "pick the server",
        },
      );
    }
    if (await fp.has({ role: "button", name: "/^continue$/i" }, 5_000))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/^continue$/i" },
        {
          goal: "go to the permissions",
        },
      );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^authori[sz]e$/i" },
      {
        goal: "add the bot to the server",
      },
    );
    await passCaptcha(fp, "authorize");
    const text = async () => (await fp.text()).toLowerCase();
    for (let i = 0; i < 15; i++) {
      if (/authori[sz]ed|added to|you may now close/.test(await text())) return { added: true };
      await fp.wait(1_000);
    }
    return fp.human("Discord did not confirm the bot joined");
  },
});
