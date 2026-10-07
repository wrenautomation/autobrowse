/**
 * A post through the composer, which is what LinkedIn leaves once the API
 * is out of reach: `/oauth/v2/authorization` always lands on `/uas/login`
 * and asks for a LinkedIn password, even with a live session and even
 * when the account signs in with Google (probed 2026-09-22). Until that
 * password exists, `POST /rest/posts` answers here.
 *
 * Mapped 2026-09-22 in headless explore: `/sharing/compose` is the
 * composer — an author control, then visibility, then comments, then a
 * `role=textbox` body, a file input behind Media, and Post. Every class
 * on the page is a build hash, so the author control is found by shape:
 * the first `div[role=button][aria-expanded]` (author, audience, comments,
 * in that order). Choosing the author is idempotent, so the flow picks
 * rather than reads. Post is the irreversible act; the route says so, and
 * a run that is not approved stops before it.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

export interface CreatePostInput {
  text: string;
  /** Who the post is by: a Page's name as the composer lists it, else the member. */
  author?: string;
  visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  /** A local image or video to attach. */
  file?: string;
}

const COMPOSE = "https://www.linkedin.com/sharing/compose";
const SETTLE_MS = 1_500;
/** The composer renders after a beat; each control is awaited, not assumed. */
const RENDER_MS = 15_000;

const body: Hints = { css: "div[role=textbox]" };
/** Author, then audience, then comments: the composer's three dropdowns, in page order. */
const authorButton: Hints = { css: "div[role=button][aria-expanded]" };
const post: Hints = { role: "button", name: "/^post$/i" };

/** What the visibility button must read for each API value. */
const AUDIENCE: Record<string, RegExp> = {
  PUBLIC: /anyone/i,
  CONNECTIONS: /connections/i,
  LOGGED_IN: /anyone/i,
};

export const linkedinCreatePost = defineFlow<CreatePostInput, { url: string | null }>({
  site: "linkedin",
  name: "create-post",
  async run(fp, input) {
    await fp.open(COMPOSE);
    if (!(await fp.has(body, RENDER_MS)))
      return fp.human(`the composer did not open (${fp.url()})`);
    if (input.author) {
      await fp.act({ kind: "click" }, authorButton, { goal: "open the author list" });
      const pick: Hints = { role: "radio", name: input.author };
      if (!(await fp.has(pick, RENDER_MS)))
        return fp.human(`"${input.author}" is not an author this account can post as`);
      await fp.act({ kind: "click" }, pick, { goal: `post as ${input.author}` });
      await fp.wait(SETTLE_MS);
      const done = { role: "button", name: "/^(done|save)$/i" } as const;
      if (await fp.has(done, 3_000))
        await fp.act({ kind: "click" }, done, { goal: "keep the author" });
    }
    const want = AUDIENCE[input.visibility ?? "PUBLIC"];
    const audience: Hints = { role: "button", name: "/^post to/i" };
    if (want && (await fp.has(audience, 3_000)) && !want.test(await fp.read(audience)))
      return fp.human(`the composer posts to a different audience than ${input.visibility}`);
    if (input.file)
      await fp.act(
        { kind: "upload", files: [input.file] },
        { css: "input[type=file]" },
        { goal: "attach the media" },
      );
    await fp.act({ kind: "fill", value: input.text }, body, { goal: "type the post" });
    await fp.wait(SETTLE_MS);
    // The editor holds one paragraph per line (mapped 2026-10-07): what Post would publish.
    const typed = await composed(fp);
    if (typed !== null && typed !== input.text.replace(/\n+$/, ""))
      return fp.human(
        `the composer holds other text than the post (${typed.length} vs ${input.text.length} chars)`,
      );
    if (!(await fp.has(post, RENDER_MS))) return fp.human("no Post button in the composer");
    await fp.act({ kind: "click" }, post, { goal: "publish the post", irreversible: true });
    // LinkedIn closes the composer and drops a "Post successful" toast with
    // a link to what it published; the feed is where it lands otherwise.
    for (let i = 0; i < 15; i++) {
      await fp.wait(SETTLE_MS);
      const text = await fp.text();
      if (/something went wrong|couldn.t post|try again/i.test(text))
        return fp.human(`LinkedIn did not take the post: ${text.slice(0, 200)}`);
      if (/post successful|your post was|posted/i.test(text) || !(await fp.has(body, 500)))
        return { url: await newestPost(fp) };
    }
    return fp.human(`the composer never confirmed the post (on ${fp.url()})`);
  },
});

/** The composer's text, one line per paragraph; null when the editor has no paragraphs (a fake page). */
async function composed(fp: { page: FlowPage["page"] }): Promise<string | null> {
  try {
    return await fp.page
      .locator("div[role=textbox]")
      .first()
      .evaluate(
        (box) => {
          type Kid = { tagName: string; textContent: string | null };
          const kids = Array.from((box as unknown as { children: ArrayLike<Kid> }).children);
          return kids.length && kids.every((k) => k.tagName === "P")
            ? kids.map((k) => k.textContent ?? "").join("\n")
            : null;
        },
        undefined,
        { timeout: 5_000 },
      );
  } catch {
    return null;
  }
}

/** The newest activity URN on the page, as the permalink of what was just published. */
async function newestPost(fp: { html(): Promise<string> }): Promise<string | null> {
  const urn = /urn:li:(?:ugcPost|activity|share):(\d+)/.exec(await fp.html())?.[0];
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}
