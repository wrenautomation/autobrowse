import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { youtubeThumbnail } from "../src/browser/flows/youtube-thumbnail.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { youtube } from "../src/sites/youtube.js";
import { fakePage } from "./auth-fakes.js";

/** Studio's page: the channel link's href, and whether Save has greyed out. */
function studio(o: { channel?: string; savedAfter?: number } = {}) {
  const made = fakePage({
    text: [""],
    present: () => true,
    url: "https://studio.youtube.com/video/V1/edit",
  });
  let checks = 0;
  made.fp.page = {
    locator: () => ({
      first: () => ({
        getAttribute: async () => `/channel/${o.channel ?? "UC1"}/videos`,
      }),
    }),
    getByRole: () => ({ isDisabled: async () => ++checks >= (o.savedAfter ?? 1) }),
  } as unknown as FlowPage["page"];
  made.fp.wait = async () => {};
  // The shared fake drops act options; keep which acts were irreversible.
  const irreversible: string[] = [];
  const act = made.fp.act.bind(made.fp);
  made.fp.act = async (op, hints, opts) => {
    if (opts?.irreversible) irreversible.push(`${op.kind} ${hints.name ?? hints.css}`);
    return act(op, hints, opts);
  };
  return { ...made, irreversible };
}

const line = (a: { op: { kind: string }; hints: { name?: unknown; css?: unknown } }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.css}`;

describe("google/youtube-thumbnail", () => {
  it("is the Studio thumbnail route's browser leg, with the channel and a downloaded file", () => {
    const route = youtube.routes.find((r) => r.path === "/studio/thumbnail");
    expect(route?.browser?.flow).toBe("google/youtube-thumbnail");
    expect(route?.browser?.uploads).toBe("file");
    expect(
      route?.browser?.input?.({ videoId: "V1", file: "/tmp/t.png" }, (n) =>
        n === "YOUTUBE_CHANNEL_ID" ? "UC1" : undefined,
      ),
    ).toEqual({ videoId: "V1", file: "/tmp/t.png", channel: "UC1" });
    expect(route?.irreversible).toBe(true);
    expect(BROWSER_FLOWS["google/youtube-thumbnail"]).toBe(youtubeThumbnail);
  });

  it("stages the image and saves; Save is the one irreversible act", async () => {
    const { fp, acts, irreversible } = studio();
    const out = await youtubeThumbnail.run(fp, {
      videoId: "V1",
      file: "/tmp/t.png",
      channel: "UC1",
    });
    expect(acts.map(line)).toEqual([
      "upload ytcp-thumbnail-uploader input#file-loader",
      "click Save",
    ]);
    expect(irreversible).toEqual(["click Save"]);
    expect(out).toEqual({ videoId: "V1", saved: true });
  });

  it("dry stages then undoes, never saving", async () => {
    const { fp, acts, irreversible } = studio();
    const out = await youtubeThumbnail.run(fp, {
      videoId: "V1",
      file: "/tmp/t.png",
      channel: "UC1",
      dry: true,
    });
    expect(acts.map(line)).toEqual([
      "upload ytcp-thumbnail-uploader input#file-loader",
      "click Undo changes",
    ]);
    expect(irreversible).toEqual([]);
    expect(out).toEqual({ videoId: "V1", saved: false, dry: true });
  });

  it("refuses another channel's Studio, or no channel named", async () => {
    const other = studio({ channel: "UC2" });
    await expect(
      youtubeThumbnail.run(other.fp, { videoId: "V1", file: "/tmp/t.png", channel: "UC1" }),
    ).rejects.toThrow(/channel UC2, not UC1/);
    const none = studio();
    await expect(
      youtubeThumbnail.run(none.fp, { videoId: "V1", file: "/tmp/t.png" }),
    ).rejects.toThrow(/no channel was named/);
    expect(other.acts).toEqual([]);
  });
});
