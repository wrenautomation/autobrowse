/**
 * `GET /proof/shot`: a comment's screenshot with its post's title (`browser/flows/proof-shot.ts`),
 * for wren's comment proofs (designs/2026-10-14-comment-proof.md). On `web` and `reddit-public`
 * it runs signed out; on `reddit` and `linkedin` as the chosen account, which sees what only its
 * author does. No official API has it: a browser leg, called on the desk.
 */
import { z } from "zod";
import { route } from "./types.js";

export const proofShotRoute = () =>
  route({
    method: "GET",
    path: "/proof/shot",
    summary:
      "A comment's screenshot with its post's title (`url` the permalink, `ref` the comment's id (Reddit `t1_…`) or `text` its words): `found`, `url` landed, `title`, `text`, `jpeg` (base64), `width`, `height`. Not found, the top of the page. A browser leg: call it on the desk",
    request: z
      .object({
        url: z.string().url(),
        ref: z
          .string()
          .regex(/^[A-Za-z0-9_:(),.-]{2,200}$/)
          .optional(),
        text: z.string().min(1).max(4_000).optional(),
      })
      .refine((q) => q.ref || q.text, { message: "give ref or text" }),
    browser: { flow: "web/proof-shot" },
  });
