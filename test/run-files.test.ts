import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localCopies, shipPlanFiles } from "../src/browser/run-files.js";

describe("run files", () => {
  it("ships only the local files a plan names, keyed by content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    const file = join(dir, "pfp.png");
    await writeFile(file, "png-bytes");
    const puts: string[] = [];
    const store = {
      put: async (key: string) => {
        puts.push(key);
        return `s3://b/${key}`;
      },
    };
    const r = await shipPlanFiles(
      { photo: file, name: "Wren", missing: "/nope/x.png", list: [file] },
      store,
    );
    const plan = r.plan as Record<string, unknown>;
    expect(plan.photo).toMatch(/^s3:\/\/b\/inputs\/[0-9a-f]{24}\.png$/);
    expect(plan.name).toBe("Wren");
    expect(plan.missing).toBe("/nope/x.png");
    expect((plan.list as string[])[0]).toBe(plan.photo);
    expect(new Set(puts).size).toBe(1);
  });

  it("brings refs back as temp files and removes them after", async () => {
    const body = () => new Response("gif-bytes").body as ReadableStream<Uint8Array>;
    const local = await localCopies(["s3://b/inputs/abc.gif", "/kept/as/is.png"], {
      s3: async () => body(),
    });
    expect(local.paths[1]).toBe("/kept/as/is.png");
    expect(local.paths[0]).toMatch(/file-0\.gif$/);
    expect(await readFile(local.paths[0] as string, "utf8")).toBe("gif-bytes");
    await local.done();
    await expect(readFile(local.paths[0] as string)).rejects.toThrow();
  });
});
