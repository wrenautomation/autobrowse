import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { imageInfo, imageProblem } from "../image.js";
import {
  type BrandPageInput,
  type BrandPageOutput,
  type EditorState,
  planSchema,
  RULES,
  sameUrl,
  workflow,
} from "./index.js";

/** A PNG header of this size: all the checks read. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const dir = mkdtempSync(join(tmpdir(), "li-brand-"));
const file = (name: string, buf: Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
};
const logo = file("logo.png", png(1000, 1000));
const banner = file("banner.png", png(1584, 396));

const plan = (dryRun: boolean, extra: Record<string, string> = {}) =>
  planSchema.parse({
    dryRun,
    logoFile: logo,
    bannerFile: banner,
    website: "https://wrenautomation.com",
    ...extra,
  });

const live: EditorState = { logo: "L1", banner: "B1", website: "" };

/** A browser whose Page shows `state`; `failOn` throws when that item is set. */
const deps = (runs: BrandPageInput[], state = live, failOn?: string) => ({
  browser: {
    run: async (_flow: unknown, input: BrandPageInput): Promise<BrandPageOutput> => {
      runs.push(input);
      if (!input.change) return { state, outcome: "read" };
      if (input.change.item === failOn) throw new Error(`${failOn} broke`);
      return { state, outcome: "saved" };
    },
  } as never,
});
const yes = () => ({ approved: true, note: null, at: new Date().toISOString() });
const items = (runs: BrandPageInput[]) => runs.map((r) => r.change?.item ?? "read");

describe("linkedin-page-branding", () => {
  it("dry run reads the editor and changes nothing", async () => {
    const runs: BrandPageInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(runs), plan(true));
    expect(out.status).toBe("planned");
    expect(items(runs)).toEqual(["read"]);
    expect(out.results.check?.detail).toContain("to set: logo, banner, website");
  });

  it("waits at the send gate, then sets each item in its own run", async () => {
    const runs: BrandPageInput[] = [];
    const { fx } = memoryEffects();
    expect((await runFlow(fx, workflow, deps(runs), plan(false))).status).toBe("waiting");
    const saved = await runFlow(fx, workflow, deps(runs), plan(false), (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("banner.png");
      return yes();
    });
    expect(saved.status).toBe("done");
    expect(items(runs)).toEqual(["read", "logo", "banner", "website"]);
    expect(saved.results.brand?.detail).toBe(
      "logo saved, read back; banner saved, read back; website saved, read back",
    );
  });

  it("leaves out a website that is already live, and asks nothing when that is all", async () => {
    const runs: BrandPageInput[] = [];
    const state = { ...live, website: "https://www.wrenautomation.com/" };
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs, state),
      planSchema.parse({ dryRun: false, website: "https://wrenautomation.com" }),
    );
    expect(out.status).toBe("done");
    expect(out.results.brand?.detail).toBe("already set");
    expect(items(runs)).toEqual(["read"]);
  });

  it("keeps what saved when a later item fails, and redoes only the rest", async () => {
    const runs: BrandPageInput[] = [];
    const { fx } = memoryEffects();
    const failed = await runFlow(fx, workflow, deps(runs, live, "banner"), plan(false), yes);
    expect(failed.status).toBe("failed");
    expect(failed.memo.saved?.logo).toMatch(/^[0-9a-f]{64}$/);
    expect(failed.memo.saved?.banner).toBeUndefined();
  });

  it("stops before the browser on a file LinkedIn would refuse", async () => {
    const runs: BrandPageInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      plan(true, { logoFile: banner, bannerFile: join(dir, "missing.png") }),
    );
    expect(out.status).toBe("failed");
    expect(out.results.check?.detail).toContain("logo: 1584x396 is 4.00:1");
    expect(out.results.check?.detail).toContain("banner: no file at");
    expect(runs).toEqual([]);
  });

  it("skips the change when nothing is given", async () => {
    const runs: BrandPageInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      planSchema.parse({ dryRun: false }),
    );
    expect(out.status).toBe("done");
    expect(items(runs)).toEqual(["read"]);
  });
});

describe("image checks", () => {
  it("reads PNG, GIF and JPEG sizes from the header", () => {
    expect(imageInfo(png(300, 200))).toEqual({ type: "png", width: 300, height: 200 });
    const gif = Buffer.from("GIF89a\x2c\x01\xc8\x00", "latin1");
    expect(imageInfo(gif)).toEqual({ type: "gif", width: 300, height: 200 });
    // SOI, an APP0 of 2 bytes, then SOF0: precision, height 200, width 300.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c,
      0x03, 0x00, 0x00,
    ]);
    expect(imageInfo(jpeg)).toEqual({ type: "jpeg", width: 300, height: 200 });
    expect(imageInfo(Buffer.from("not an image at all"))).toBeNull();
  });

  it("names what LinkedIn would refuse", () => {
    expect(imageProblem(logo, RULES.logo)).toBeNull();
    expect(imageProblem(banner, RULES.banner)).toBeNull();
    expect(imageProblem(file("small.png", png(100, 100)), RULES.logo)).toBe(
      "logo: 100x100, under 300x300",
    );
    expect(imageProblem(file("x.txt", Buffer.from("hello world, hello")), RULES.logo)).toContain(
      "is not a PNG",
    );
    expect(imageProblem("s3://bucket/logo.png", RULES.logo)).toBeNull();
  });

  it("treats URLs that differ only in scheme, www, case or a slash as the same", () => {
    expect(sameUrl("https://wrenautomation.com", "http://WWW.wrenautomation.com/")).toBe(true);
    expect(sameUrl("https://wrenautomation.com", "https://wren.com")).toBe(false);
  });
});
