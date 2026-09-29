import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActOptions, FlowPage, Op } from "../src/browser/flow.js";
import { LOOM, loomDelete, loomRename, loomUpload, shareUrl } from "../src/browser/flows/loom.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";

const ID = "0123456789abcdef0123456789abcdef";
const UPLOAD = "button:Upload a video";
const BROWSE = "button:browse files";
const RENAME = 'button[aria-label^="Rename video"]';
const TITLE_BOX = "main input[type=text]:focus";
const MORE = "[data-testid=toggleActions]";

type Act = { op: Op; hints: Hints; opts: ActOptions };
const key = (h: Hints) => h.css ?? `${h.role}:${h.name}`;
const line = (a: Act) => {
  const target = key(a.hints);
  if (a.op.kind === "fill") return `fill ${target}=${a.op.value}`;
  if (a.op.kind === "press") return `press ${target} ${a.op.key}`;
  if (a.op.kind === "upload") return `upload ${target} ${a.op.files.join(",")}`;
  return `${a.op.kind} ${target}`;
};

/**
 * A fake Loom tab. `page.evaluate` runs the flow's own page script against a
 * stubbed `document`, so the share-link and title reads are tested too.
 */
function loomPage(o: {
  /** Hint keys on the page right now. */
  present?: Set<string>;
  /** The dialog's share link after this many polls (never when absent). */
  linkAfter?: number;
  href?: string;
  dialogText?: string;
  /** The title the page shows; Enter on the box saves unless `sticks` is false. */
  title?: string;
  sticks?: boolean;
  /** Where the page goes once the delete is confirmed. */
  afterDelete?: string;
}) {
  const present = o.present ?? new Set<string>();
  let url = "about:blank";
  let polls = 0;
  let title = o.title ?? "";
  let typed = "";
  const acts: Act[] = [];
  const opens: string[] = [];
  const closed: string[] = [];
  const switched: unknown[] = [];
  const attr = (n: string, v: string) => ({
    textContent: "",
    getAttribute: (x: string) => (x === n ? v : null),
    querySelectorAll: () => [],
  });
  vi.stubGlobal("document", {
    querySelectorAll: (sel: string) => {
      if (sel.includes("/share/")) {
        polls++;
        return o.linkAfter !== undefined && polls >= o.linkAfter
          ? [attr("href", o.href ?? `/share/${ID}`)]
          : [];
      }
      if (sel.startsWith("button[aria-label"))
        return [attr("aria-label", `Rename video: ${title}`)];
      if (sel === "[role=dialog]")
        return [{ textContent: o.dialogText ?? "Uploading 1 file", getAttribute: () => null }];
      return [];
    },
  });
  const page = { name: "main", evaluate: async (fn: () => unknown) => fn() };
  const popup = {
    name: "popup",
    close: async () => {
      closed.push("popup");
    },
  };
  const fp: FlowPage = {
    page: page as unknown as FlowPage["page"],
    passkeys: {} as FlowPage["passkeys"],
    captcha: async () => ({ solved: false }) as never,
    async open(u) {
      opens.push(u);
      url = u;
    },
    url: () => url,
    text: async () => "",
    html: async () => "",
    has: async (h) => present.has(key(h)),
    read: async () => "",
    wait: async () => {},
    answer: async () => {},
    waitForUrl: async (p) => (p instanceof RegExp ? p.test(url) : p(url)),
    nextPage: async () => null,
    scroll: async () => {},
    pages: () => [page, popup] as unknown as ReturnType<FlowPage["pages"]>,
    switchTo(p) {
      switched.push(p);
    },
    async act(op, hints, opts) {
      acts.push({ op, hints, opts });
      const k = key(hints);
      if (k === RENAME) present.add(TITLE_BOX);
      if (op.kind === "fill") typed = op.value;
      if (op.kind === "press" && op.key === "Enter" && o.sticks !== false) title = typed;
      if (k === "button:Permanently delete" && o.afterDelete) url = o.afterDelete;
    },
    async signIn() {
      return "no-login";
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, acts, opens, closed, switched, page, polls: () => polls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loom/upload", () => {
  it("uploads, reads the id off the dialog's /share/ link, closes the other tab, titles it", async () => {
    const p = loomPage({
      present: new Set([UPLOAD, BROWSE, TITLE_BOX]),
      linkAfter: 3,
      href: `https://www.loom.com/share/${ID}?sid=abc`,
    });
    const out = await loomUpload.run(p.fp, { file: "/tmp/v.mp4", title: "Demo" });
    expect(out).toEqual({ id: ID, url: `${LOOM}/share/${ID}`, title: "Demo" });
    expect(p.opens).toEqual([`${LOOM}/home`, shareUrl(ID)]);
    expect(p.closed).toEqual(["popup"]);
    expect(p.switched).toEqual([p.page]);
    expect(p.acts.map(line)).toEqual([
      `click ${UPLOAD}`,
      "upload [role=dialog] input[type=file] /tmp/v.mp4",
      "click button:/^Upload \\d+ files?$/",
      `fill ${TITLE_BOX}=Demo`,
      `press ${TITLE_BOX} Enter`,
    ]);
  });

  it("no title: no rename, title null", async () => {
    const p = loomPage({ present: new Set([UPLOAD, BROWSE]), linkAfter: 1 });
    const out = await loomUpload.run(p.fp, { file: "/tmp/v.mp4" });
    expect(out).toEqual({ id: ID, url: shareUrl(ID), title: null });
    expect(p.opens).toEqual([`${LOOM}/home`]);
  });

  it('no "Upload a video" is a person, before any act', async () => {
    const p = loomPage({});
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toBeInstanceOf(NeedsHuman);
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toThrow(
      /no "Upload a video"/,
    );
    expect(p.acts).toEqual([]);
  });

  it("the dialog that never opens is a person", async () => {
    const p = loomPage({ present: new Set([UPLOAD]) });
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toThrow(
      /upload dialog did not open/,
    );
    expect(p.acts).toHaveLength(1);
  });

  it("a failed upload is a person, with Loom's words", async () => {
    const p = loomPage({
      present: new Set([UPLOAD, BROWSE]),
      dialogText: "Upload failed: file too large",
    });
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toThrow(
      /did not take the upload: Upload failed/,
    );
    expect(p.closed).toEqual([]);
  });

  it("an upload that never completes is a person", async () => {
    const p = loomPage({ present: new Set([UPLOAD, BROWSE]) });
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toThrow(/never completed/);
    // Polled every 3 s for 20 min.
    expect(p.polls()).toBe(400);
  });

  it("a link that is not a 32-hex share id is no id", async () => {
    const p = loomPage({
      present: new Set([UPLOAD, BROWSE]),
      linkAfter: 1,
      href: "/share/not-an-id",
    });
    await expect(loomUpload.run(p.fp, { file: "/tmp/v.mp4" })).rejects.toThrow(/never completed/);
  });
});

describe("loom/rename", () => {
  it("a fresh upload's focused title box: typed straight in, no rename click", async () => {
    const p = loomPage({ present: new Set([TITLE_BOX, RENAME]), title: "" });
    const out = await loomRename.run(p.fp, { id: ID, title: "New" });
    expect(out).toEqual({ id: ID, url: shareUrl(ID), title: "New" });
    expect(p.acts.map(line)).toEqual([`fill ${TITLE_BOX}=New`, `press ${TITLE_BOX} Enter`]);
  });

  it("an existing video: clicks the rename button first", async () => {
    const p = loomPage({ present: new Set([RENAME]), title: "Old" });
    const out = await loomRename.run(p.fp, { id: ID, title: "New" });
    expect(out.title).toBe("New");
    expect(p.opens).toEqual([shareUrl(ID)]);
    expect(p.acts.map(line)).toEqual([
      `click ${RENAME}`,
      `fill ${TITLE_BOX}=New`,
      `press ${TITLE_BOX} Enter`,
    ]);
  });

  it("a title that does not stick is a person, naming both titles", async () => {
    const p = loomPage({ present: new Set([RENAME]), title: "Old", sticks: false });
    await expect(loomRename.run(p.fp, { id: ID, title: "New" })).rejects.toThrow(
      new NeedsHuman('Loom kept the title "Old", not "New"'),
    );
  });

  it("no title on the page is a person, with no act", async () => {
    const p = loomPage({});
    await expect(loomRename.run(p.fp, { id: ID, title: "New" })).rejects.toThrow(
      /no title to rename/,
    );
    expect(p.acts).toEqual([]);
  });
});

describe("loom/delete", () => {
  it("more actions, Delete, Permanently delete (irreversible), then off the video", async () => {
    const p = loomPage({ present: new Set([MORE]), afterDelete: `${LOOM}/home` });
    expect(await loomDelete.run(p.fp, { id: ID })).toEqual({ id: ID, deleted: true });
    expect(p.opens).toEqual([shareUrl(ID)]);
    expect(p.acts.map(line)).toEqual([
      `click ${MORE}`,
      "click menuitem:Delete",
      "click button:Permanently delete",
    ]);
    expect(p.acts.map((a) => a.opts.irreversible ?? false)).toEqual([false, false, true]);
  });

  it("no video is a person, with no act", async () => {
    const p = loomPage({});
    await expect(loomDelete.run(p.fp, { id: ID })).rejects.toThrow(
      new NeedsHuman(`no video ${ID} to delete (on ${shareUrl(ID)})`),
    );
    expect(p.acts).toEqual([]);
  });

  it("still on the video after the confirm is a person", async () => {
    const p = loomPage({ present: new Set([MORE]) });
    await expect(loomDelete.run(p.fp, { id: ID })).rejects.toThrow(/still on the video/);
  });
});
