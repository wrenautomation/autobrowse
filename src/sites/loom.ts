/**
 * Loom: a video's owner has no public API, so writes are browser legs on
 * the signed-in web app (flows in `browser/flows/loom.ts`) and reads use
 * the one open endpoint, oEmbed (`/v1/oembed?url=`: title, duration,
 * thumbnail, embed html). An upload is the post: Loom answers a share link,
 * public to anyone who has it and never indexed. Starter (free) keeps 25
 * videos a person, so the cap is low and old videos get deleted.
 */
import { z } from "zod";
import { HttpError } from "../clients/http.js";
import { route, type SiteApi } from "./types.js";

export const LOOM_ORIGIN = "https://www.loom.com";

const id = z.string().regex(/^[0-9a-f]{32}$/, "a Loom video id (32 hex characters)");
const title = z.string().min(1).max(200);

export const loom: SiteApi = {
  site: "loom",
  origin: LOOM_ORIGIN,
  // No bearer: oEmbed is open, and every write is a browser leg signed in as the account.
  auth: { open: true },
  caps: { uploads: 10, edits: 50 },
  pace: { gapMs: 5_000, jitterMs: 10_000 },
  routes: [
    route({
      method: "GET",
      path: "/videos/{id}",
      request: z.object({ id }),
      api: async ({ id }, leg) => {
        const url = `${LOOM_ORIGIN}/v1/oembed?url=${encodeURIComponent(`${LOOM_ORIGIN}/share/${id}`)}`;
        const res = await leg.http.json<Record<string, unknown>>(url);
        if (!res.ok) throw new HttpError("CALL", `${LOOM_ORIGIN}/v1/oembed`, res.status);
        return { id, url: `${LOOM_ORIGIN}/share/${id}`, ...res.body };
      },
      summary:
        "A video by id: title, duration, thumbnail_url, embed html (oEmbed; 404 once deleted)",
    }),
    route({
      method: "POST",
      path: "/videos",
      request: z.object({
        /** A local path, or a URL the leg downloads first. */
        file: z.string().min(1),
        title: title.optional(),
      }),
      meter: () => ({ uploads: 1 }),
      browser: { flow: "loom/upload", uploads: "file" },
      summary:
        "Upload a video file (mp4 mov webm wmv avi m4v, under 4 GB) and title it; answers {id, url, title}: the share link",
    }),
    route({
      method: "PATCH",
      path: "/videos/{id}",
      request: z.object({ id, title }),
      meter: () => ({ edits: 1 }),
      browser: { flow: "loom/rename" },
      summary: "Retitle a video",
    }),
    route({
      method: "DELETE",
      path: "/videos/{id}",
      request: z.object({ id }),
      irreversible: true,
      meter: () => ({ edits: 1 }),
      browser: { flow: "loom/delete" },
      summary: "Delete a video for good (its link stops working)",
    }),
  ],
  setup: [],
};
