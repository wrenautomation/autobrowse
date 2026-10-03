/**
 * Discord under its REST API (v10), as Wren's bot: the server's channels and
 * the webhooks wren and the lander post through. The bot token is minted in
 * the browser (`setup discord bot-token`) and the bot joins a server by one
 * consent (`setup discord invite`); after that every change is a call here.
 * A webhook URL is a secret (it authorises posting): a new one goes straight
 * to the sink under the name the caller gives, never into the answer.
 */
import { extname } from "node:path";
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { type ApiLeg, route, type SiteApi } from "./types.js";
import { bytesOf } from "./youtube.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_BOT_TOKEN = "DISCORD_BOT_TOKEN";
/** The bot's application id: the invite link names it. */
export const DISCORD_APP_ID = "DISCORD_APP_ID";

/**
 * What the bot may do in a server: view and send, manage the server (name,
 * icon), channels, roles and webhooks. Not Administrator: a leaked token then
 * cannot ban or delete the server.
 */
export const BOT_PERMISSIONS = (
  (1n << 10n) | // view channels
  (1n << 11n) | // send messages
  (1n << 5n) | // manage server (name, icon)
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
/** The URL that posts through a webhook, from its id and token. */
const webhookUrl = (w: Webhook) => w.url ?? `https://discord.com/api/webhooks/${w.id}/${w.token}`;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Discord takes an avatar or icon as a data URI. */
export async function imageData(source: string, fetcher?: typeof fetch): Promise<string> {
  const ext = extname(source.replace(/[?#].*$/, "")).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) throw new Error(`discord: ${ext || "no extension"} is not png, jpg, gif or webp`);
  const bytes = await bytesOf(source, fetcher);
  if (bytes.byteLength > 10 * 1024 ** 2) throw new Error("discord: image over 10 MB");
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * A server laid out by sales channel: one category per group, one text
 * channel per lane, each lane's pings through its own webhook, so one
 * channel's data never lands in another's. The env names are the ones wren
 * reads (`WREN_DISCORD_<LANE>_WEBHOOK_URL`) and the lander's intake form.
 */
export const WREN_LAYOUT: Layout = [
  {
    category: "Outbound",
    channels: [
      {
        name: "email",
        topic: "Cold email: replies, bounces, pauses",
        webhook: "WREN_DISCORD_EMAIL_WEBHOOK_URL",
      },
      {
        name: "sms",
        topic: "Cold SMS: replies, opt-outs, health",
        webhook: "WREN_DISCORD_SMS_WEBHOOK_URL",
      },
      {
        name: "reach",
        topic: "Reddit and LinkedIn DMs",
        webhook: "WREN_DISCORD_REACH_WEBHOOK_URL",
      },
    ],
  },
  {
    category: "Inbound",
    channels: [
      { name: "intake", topic: "Lander form submissions", webhook: "LANDER_DISCORD_WEBHOOK" },
      {
        name: "meetings",
        topic: "Calls booked, moved or cancelled on cal.com",
        webhook: "LANDER_DISCORD_MEETINGS_WEBHOOK",
      },
      {
        name: "search",
        topic: "Search Console and answer engines",
        webhook: "WREN_DISCORD_SEARCH_WEBHOOK_URL",
      },
    ],
  },
  {
    category: "Marketing",
    channels: [
      { name: "ads", topic: "Meta ads: spend and pauses", webhook: "WREN_DISCORD_ADS_WEBHOOK_URL" },
      {
        name: "content",
        topic: "Organic posts: schedule and metrics",
        webhook: "WREN_DISCORD_CONTENT_WEBHOOK_URL",
      },
    ],
  },
  {
    category: "Clients",
    channels: [
      {
        name: "clients",
        topic: "Delivery and reactivation",
        webhook: "WREN_DISCORD_CLIENTS_WEBHOOK_URL",
      },
    ],
  },
  {
    category: "Ops",
    channels: [
      {
        name: "ops",
        topic: "Morning digest and system pings",
        webhook: "WREN_DISCORD_WEBHOOK_URL",
      },
    ],
  },
];

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const layoutSchema = z
  .array(
    z.object({
      category: z.string().min(1).max(100),
      channels: z
        .array(
          z.object({
            name: z.string().regex(/^[a-z0-9_-]{1,100}$/, "a lowercase channel name"),
            topic: z.string().max(1024).optional(),
            /** Env name the channel's webhook URL is kept as. */
            webhook: envName.optional(),
          }),
        )
        .min(1),
    }),
  )
  .min(1);
export type Layout = z.infer<typeof layoutSchema>;

interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
}
const WEBHOOK_NAME = "Wren";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Makes the server match `layout`, idempotently: a missing category or channel
 * is made, a channel elsewhere is moved under its category, a topic is set,
 * a missing webhook is made and every lane's URL is kept. Channels the layout
 * does not name are left alone: it never deletes.
 */
export async function applyLayout(leg: ApiLeg, guild: string, layout: Layout) {
  if (!leg.keep) throw new Error("discord: no sink to keep the webhook URLs in");
  const channels = await call<Channel[]>(leg, "GET", `/guilds/${guild}/channels`);
  const done: { category: string; channel: string; did: string[]; kept?: string }[] = [];
  for (const group of layout) {
    let cat = channels.find(
      (c) => c.type === CHANNEL_TYPES.category && same(c.name, group.category),
    );
    if (!cat) {
      cat = await call<Channel>(leg, "POST", `/guilds/${guild}/channels`, {
        name: group.category,
        type: CHANNEL_TYPES.category,
      });
      channels.push(cat);
    }
    for (const want of group.channels) {
      const did: string[] = [];
      let ch =
        channels.find(
          (c) => c.type === CHANNEL_TYPES.text && c.parent_id === cat.id && c.name === want.name,
        ) ?? channels.find((c) => c.type === CHANNEL_TYPES.text && c.name === want.name);
      if (!ch) {
        ch = await call<Channel>(leg, "POST", `/guilds/${guild}/channels`, {
          name: want.name,
          type: CHANNEL_TYPES.text,
          parent_id: cat.id,
          ...(want.topic ? { topic: want.topic } : {}),
        });
        channels.push(ch);
        did.push("made");
      } else {
        const patch: Record<string, unknown> = {};
        if (ch.parent_id !== cat.id) patch.parent_id = cat.id;
        if (want.topic && (ch.topic ?? "") !== want.topic) patch.topic = want.topic;
        if (Object.keys(patch).length > 0) {
          ch = await call<Channel>(leg, "PATCH", `/channels/${ch.id}`, patch);
          if ("parent_id" in patch) did.push("moved");
          if ("topic" in patch) did.push("topic");
        }
      }
      let kept: string | undefined;
      if (want.webhook) {
        const hooks = await call<Webhook[]>(leg, "GET", `/channels/${ch.id}/webhooks`);
        let hook = hooks.find((w) => w.name === WEBHOOK_NAME && w.token);
        if (!hook) {
          hook = await call<Webhook>(leg, "POST", `/channels/${ch.id}/webhooks`, {
            name: WEBHOOK_NAME,
          });
          did.push("webhook");
        }
        await leg.keep(want.webhook, webhookUrl(hook));
        kept = want.webhook;
      }
      done.push({ category: cat.name, channel: ch.name, did, ...(kept ? { kept } : {}) });
    }
  }
  const named = new Set(done.map((d) => d.channel));
  const untouched = channels
    .filter((c) => c.type === CHANNEL_TYPES.text && !named.has(c.name))
    .map((c) => c.name);
  return { channels: done, untouched };
}

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
      method: "PATCH",
      path: "/users/@me",
      request: z.object({
        username: z.string().min(2).max(32).optional(),
        /** A local path or URL to a png, jpg, gif or webp. */
        avatar: z.string().min(1).optional(),
      }),
      api: async ({ username, avatar }, leg) => {
        const u = await call<{ id: string; username: string; avatar: string | null }>(
          leg,
          "PATCH",
          "/users/@me",
          {
            ...(username ? { username } : {}),
            ...(avatar ? { avatar: await imageData(avatar) } : {}),
          },
        );
        return { id: u.id, username: u.username, avatar: u.avatar };
      },
      summary: "The bot's name and picture (avatar = a local path or URL to a png/jpg/gif/webp)",
    }),
    route({
      method: "PATCH",
      path: "/guilds/{guild}",
      request: z.object({
        guild: id,
        name: z.string().min(2).max(100).optional(),
        description: z.string().max(120).optional(),
        /** A local path or URL to a png, jpg, gif or webp (gif only on a boosted server). */
        icon: z.string().min(1).optional(),
        /** Who gets a push by default: every post, or only posts that @mention them. */
        notifications: z.enum(["all", "mentions"]).optional(),
      }),
      api: async ({ guild, icon, notifications, ...rest }, leg) => {
        const g = await call<{
          id: string;
          name: string;
          icon: string | null;
          default_message_notifications: number;
        }>(leg, "PATCH", `/guilds/${guild}`, {
          ...rest,
          ...(icon ? { icon: await imageData(icon) } : {}),
          ...(notifications
            ? { default_message_notifications: notifications === "all" ? 0 : 1 }
            : {}),
        });
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          notifications: g.default_message_notifications === 1 ? "mentions" : "all",
        };
      },
      summary:
        "The server's name, description, icon (a local path or URL) and default notifications (all | mentions)",
    }),
    route({
      method: "PUT",
      path: "/guilds/{guild}/layout",
      request: z.object({ guild: id, layout: layoutSchema.default(WREN_LAYOUT) }),
      api: ({ guild, layout }, leg) => applyLayout(leg, guild, layout),
      summary:
        "Lay the server out by sales channel (no official path: autobrowse's own): a category per group, a channel per lane, each lane's webhook URL kept under its env name; idempotent, never deletes. Default layout = Wren's lanes",
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
        "Add the bot to a server you manage (manage server, channels, roles, webhooks; not admin): one consent as the signed-in user",
    },
  ],
};
