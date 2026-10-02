/**
 * Discord under its REST API (v10), as Wren's bot: the server's channels and
 * the webhooks wren and the lander post through. The bot token is minted in
 * the browser (`setup discord bot-token`) and the bot joins a server by one
 * consent (`setup discord invite`); after that every change is a call here.
 * A webhook URL is a secret (it authorises posting): a new one goes straight
 * to the sink under the name the caller gives, never into the answer.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, route, type SiteApi } from "./types.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_BOT_TOKEN = "DISCORD_BOT_TOKEN";
/** The bot's application id: the invite link names it. */
export const DISCORD_APP_ID = "DISCORD_APP_ID";

/**
 * What the bot may do in a server: view and send, manage channels, roles and
 * webhooks. Not Administrator: a leaked token then cannot ban or delete the server.
 */
export const BOT_PERMISSIONS = (
  (1n << 10n) | // view channels
  (1n << 11n) | // send messages
  (1n << 4n) | // manage channels
  (1n << 28n) | // manage roles
  (1n << 29n)
) // manage webhooks
  .toString();

/** The consent page that adds the bot to a server the signed-in user manages. */
export const inviteUrl = (appId: string, guildId?: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${BOT_PERMISSIONS}${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ""}`;

/** Text 0, voice 2, category 4, announcement 5, forum 15. */
export const CHANNEL_TYPES = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  forum: 15,
} as const;

async function call<T>(
  leg: ApiLeg,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${DISCORD_API}${path}`;
  const res = await leg.http.json<T & { message?: string }>(url, {
    method,
    headers: { authorization: `Bot ${leg.token}` },
    ...(body === undefined ? {} : { body }),
  });
  if (!res.ok) throw new HttpError(method, url, res.status, res.body?.message ?? "");
  return res.body as T;
}

const id = z.string().regex(/^\d{5,25}$/, "a Discord id (digits)");
const channelType = z
  .union([z.enum(["text", "voice", "category", "announcement", "forum"]), z.number().int()])
  .default("text")
  .transform((t) => (typeof t === "number" ? t : CHANNEL_TYPES[t]));
const channelBody = z.object({
  name: z.string().min(1).max(100),
  type: channelType,
  topic: z.string().max(1024).optional(),
  parent_id: id.optional(),
  position: z.number().int().optional(),
});

interface Webhook {
  id: string;
  name: string;
  channel_id: string;
  guild_id?: string;
  token?: string;
  url?: string;
}
/** A webhook without its secret half. */
const bare = (w: Webhook) => ({ id: w.id, name: w.name, channel_id: w.channel_id });

export const discord: SiteApi = {
  site: "discord",
  origin: DISCORD_API,
  probe: { path: "/users/@me" },
  auth: { token: DISCORD_BOT_TOKEN },
  routes: [
    route({
      method: "GET",
      path: "/users/@me",
      request: z.object({}),
      api: (_i, leg) => call(leg, "GET", "/users/@me"),
      summary: "The bot itself: the cheapest proof the token is live",
    }),
    route({
      method: "GET",
      path: "/users/@me/guilds",
      request: z.object({}),
      api: (_i, leg) => call(leg, "GET", "/users/@me/guilds"),
      summary: "The servers the bot is in (id, name); empty until `setup discord invite`",
    }),
    route({
      method: "GET",
      path: "/guilds/{guild}",
      request: z.object({ guild: id }),
      api: ({ guild }, leg) => call(leg, "GET", `/guilds/${guild}?with_counts=true`),
      summary: "One server: name, boost tier, member counts, features",
    }),
    route({
      method: "GET",
      path: "/guilds/{guild}/channels",
      request: z.object({ guild: id }),
      api: ({ guild }, leg) => call(leg, "GET", `/guilds/${guild}/channels`),
      summary: "Every channel and category in a server (id, name, type, parent_id, position)",
    }),
    route({
      method: "POST",
      path: "/guilds/{guild}/channels",
      request: channelBody.extend({ guild: id }),
      api: ({ guild, ...body }, leg) => call(leg, "POST", `/guilds/${guild}/channels`, body),
      summary:
        "Make a channel or category: name, type (text | category | voice | announcement | forum), topic, parent_id (the category)",
    }),
    route({
      method: "PATCH",
      path: "/channels/{channel}",
      request: channelBody
        .omit({ type: true })
        .partial()
        .extend({ channel: id, parent_id: id.nullable().optional() }),
      api: ({ channel, ...body }, leg) => call(leg, "PATCH", `/channels/${channel}`, body),
      summary: "Rename a channel, set its topic, move it under a category or reorder it",
    }),
    route({
      method: "DELETE",
      path: "/channels/{channel}",
      request: z.object({ channel: id }),
      api: ({ channel }, leg) => call(leg, "DELETE", `/channels/${channel}`),
      irreversible: true,
      summary: "Delete a channel and its messages (irreversible)",
    }),
    route({
      method: "GET",
      path: "/guilds/{guild}/webhooks",
      request: z.object({ guild: id }),
      api: async ({ guild }, leg) =>
        (await call<Webhook[]>(leg, "GET", `/guilds/${guild}/webhooks`)).map(bare),
      summary: "The server's webhooks (id, name, channel): never their tokens",
    }),
    route({
      method: "POST",
      path: "/channels/{channel}/webhooks",
      request: z.object({
        channel: id,
        name: z.string().min(1).max(80),
        /** Env name the webhook URL is kept as; it is never returned. */
        keep: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      }),
      api: async ({ channel, name, keep }, leg) => {
        if (!leg.keep) throw new Error("discord: no sink to keep the webhook URL in");
        const w = await call<Webhook>(leg, "POST", `/channels/${channel}/webhooks`, { name });
        if (!w.url) throw new Error("discord: the new webhook came back without its URL");
        await leg.keep(keep, w.url);
        return { ...bare(w), kept: keep };
      },
      summary:
        "Make a webhook on a channel and keep its URL as `keep` (an env name) in the sink; the URL is never returned",
    }),
  ],
  setup: [
    {
      name: "bot-token",
      makes: [DISCORD_APP_ID, DISCORD_BOT_TOKEN],
      how: { flow: "discord/bot-token", input: { name: "Wren" } },
      summary:
        "Make a Discord application with a bot (discord.com/developers), reset its token once and keep it as DISCORD_BOT_TOKEN",
    },
    {
      name: "invite",
      makes: [],
      needs: [DISCORD_APP_ID],
      how: { flow: "discord/invite", input: { appId: { env: DISCORD_APP_ID } } },
      summary:
        "Add the bot to a server you manage (manage channels, roles, webhooks; not admin): one consent as the signed-in user",
    },
  ],
};
