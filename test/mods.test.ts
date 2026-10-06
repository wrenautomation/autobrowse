import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { memoryFixes } from "../src/browser/fixes.js";
import { memoryScreens } from "../src/browser/screens.js";
import {
  checkMod,
  installMod,
  modsPort,
  removeMod,
  searchMods,
  sha256,
} from "../src/mods/install.js";
import {
  type DataLogin,
  dataLoginSchema,
  loginProblems,
  registerDataLogins,
} from "../src/mods/login.js";
import { modScreens, modWorkflowRoots, withModFixes, withModScreens } from "../src/mods/mod.js";
import { packMod, scrubFrom } from "../src/mods/pack.js";
import { listWalks, loadWalk, saveWalk, type WalkSpec } from "../src/walks/spec.js";

// Synthetic only: a fake owner with a planted fake secret in a temp dir.
const SECRET = "hunter-two-xyz";
const USER = "owner@scratch.test";

async function owner() {
  const dir = mkdtempSync(join(tmpdir(), "autobrowse-mods-"));
  const creds = fileCredentials(join(dir, "credentials.json"));
  await creds.put("scratch", { username: USER, password: SECRET });
  return { dir, walks: join(dir, "walks"), mods: join(dir, "mods"), scrub: await scrubFrom(creds) };
}

const walk = (o: Partial<WalkSpec> = {}): WalkSpec => ({
  version: 1,
  site: "scratch",
  name: "join-list",
  goal: `join the list as ${USER}`,
  built: "2026-10-04T12:00:00.000Z",
  from: [{ run: "20261004-120000-aaaa", outcome: "achieved", endedAt: "2026-10-04T12:05:00.000Z" }],
  start: `https://scratch.test/signup?ref=${USER}#top`,
  fields: [{ key: "who", label: "Name", example: "Pat Example" }],
  secrets: [{ key: "scratch.password", label: "Password" }],
  irreversible: true,
  screens: [
    {
      name: "sign-up",
      looks: "heading sign up on scratch.test/signup",
      url: "scratch.test/signup",
      landmarks: ["heading sign up", "field name", `text signed in as ${USER}`],
      ops: [
        {
          kind: "fill",
          goal: "fill Name",
          hints: { role: "textbox", name: "Name" },
          value: { from: "plan", field: "who" },
        },
        {
          kind: "fill",
          goal: "fill Password",
          hints: { role: "textbox", name: "Password" },
          value: { from: "secret", key: "scratch.password" },
        },
        {
          kind: "fill",
          goal: "fill Backup",
          hints: { role: "textbox", name: "Backup" },
          value: { from: "literal", text: SECRET },
        },
        {
          kind: "click",
          goal: "click Join",
          hints: { role: "button", name: "Join" },
          irreversible: true,
        },
      ],
      seen: 1,
    },
    {
      name: "done",
      looks: "heading thanks",
      url: "scratch.test/done",
      landmarks: ["heading thanks", "text see you"],
      ops: [],
      goal: true,
      seen: 1,
    },
  ],
  ...o,
});

const pack = (o: Awaited<ReturnType<typeof owner>>, out = join(o.dir, "out")) =>
  packMod({
    site: "scratch",
    walksDir: o.walks,
    walks: ["join-list"],
    scrub: o.scrub,
    out,
    version: "0.3.0",
  });

describe("mods pack", () => {
  it("scrubs the planted secret, the address, query strings, run ids and examples", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const all = ["mod.json", "package.json", "walks/scratch/join-list.json"]
      .map((f) => readFileSync(join(p.dir, f), "utf8"))
      .join("\n");
    for (const gone of [SECRET, USER, "?ref", "#top", "20261004-120000-aaaa", "Pat Example"])
      expect(all).not.toContain(gone);
    const w = JSON.parse(readFileSync(join(p.dir, "walks/scratch/join-list.json"), "utf8"));
    expect(w.start).toBe("https://scratch.test/signup");
    expect(w.screens[0].ops[2].value).toEqual({ from: "plan", field: "typed1" });
    expect(p.mod).toMatchObject({
      domains: ["scratch.test"],
      credentials: ["scratch:main"],
      gates: ["send"],
      irreversible: true,
    });
    expect(JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8")).keywords).toContain(
      "autobrowse-mod",
    );
    // What it packed passes the installer's own checks.
    expect(checkMod(p.dir, { version: "0.3.0" }).name).toBe("autobrowse-mod-scratch");
  });

  it("refuses when a stored value survives the scrub, and writes nothing", async () => {
    const o = await owner();
    // A screen name is not prose: the scrubber leaves it, the final check catches it.
    const w = walk();
    saveWalk(o.walks, {
      ...w,
      screens: [
        ...w.screens,
        { ...(w.screens[1] as WalkSpec["screens"][number]), name: SECRET, goal: false },
      ],
    });
    const out = join(o.dir, "out");
    expect(() => pack(o, out)).toThrow(/pack refused/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("mods add", () => {
  it("refuses a walk that opens a host outside its domains", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const m = JSON.parse(readFileSync(join(p.dir, "mod.json"), "utf8"));
    writeFileSync(join(p.dir, "mod.json"), JSON.stringify({ ...m, domains: ["other.test"] }));
    expect(() => checkMod(p.dir, { version: "0.3.0" })).toThrow(/outside domains/);
  });

  it("refuses a file whose hash does not match", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const f = join(p.dir, "walks/scratch/join-list.json");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace("scratch.test/done", "scratch.test/elsewhere"),
    );
    expect(() => checkMod(p.dir, { version: "0.3.0" })).toThrow(/sha256/);
  });

  it("refuses an irreversible walk whose mod names no send or purchase gate", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const m = JSON.parse(readFileSync(join(p.dir, "mod.json"), "utf8"));
    writeFileSync(join(p.dir, "mod.json"), JSON.stringify({ ...m, gates: [] }));
    expect(() => checkMod(p.dir, { version: "0.3.0" })).toThrow(/neither send nor purchase/);
  });

  it("refuses a mod for a newer autobrowse", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    expect(() => checkMod(p.dir, { version: "0.2.9" })).toThrow(/needs autobrowse >=0.3.0/);
  });

  it("refuses a walk that types another site's password outside that site's domains", async () => {
    const o = await owner();
    const w = walk();
    const signUp = w.screens[0] as WalkSpec["screens"][number];
    saveWalk(o.walks, {
      ...w,
      secrets: [{ key: "google.password", label: "Password" }],
      screens: [
        {
          ...signUp,
          ops: [
            {
              kind: "fill",
              goal: "fill Password",
              hints: { role: "textbox", name: "Password" },
              value: { from: "secret", key: "google.password" },
            },
          ],
        },
        w.screens[1] as WalkSpec["screens"][number],
      ],
    });
    const p = pack(o);
    expect(p.mod.credentials).toEqual(["google:main"]);
    expect(() => checkMod(p.dir, { version: "0.3.0" })).toThrow(/types a google secret on/);
  });
});

describe("installed mods", () => {
  it("load after the owner's own: the owner's walk wins, the mod's fills in", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const mod = checkMod(p.dir, { version: "0.3.0" });
    await installMod(p.dir, mod, o.mods, p.dir);
    expect(loadWalk(o.walks, "scratch", "join-list")?.from).toHaveLength(1);
    expect(listWalks(o.walks)).toHaveLength(1);
    expect(listWalks(o.walks)[0]?.mod).toBeUndefined();

    rmSync(join(o.walks, "scratch", "join-list.json"));
    expect(loadWalk(o.walks, "scratch", "join-list")?.from).toEqual([]);
    expect(listWalks(o.walks)[0]?.mod).toBe("autobrowse-mod-scratch");

    expect(removeMod(o.mods, "autobrowse-mod-scratch")).toBe(true);
    expect(loadWalk(o.walks, "scratch", "join-list")).toBeNull();
    expect(() => removeMod(o.mods, "../walks")).toThrow(/not a mod name/);
  });

  it("a mod's screen that works is copied into the owner's own, marked with the mod", async () => {
    const o = await owner();
    const p = packMod({
      site: "scratch",
      walksDir: o.walks,
      walks: [],
      screens: [
        {
          site: "scratch",
          url: "scratch.test/join",
          landmarks: ["heading join", "button go"],
          click: { role: "button", name: "Go" },
          reason: "the join page",
          found: "2026-10-01T00:00:00.000Z",
          used: 3,
        },
      ],
      scrub: o.scrub,
      out: join(o.dir, "out"),
      version: "0.3.0",
    });
    await installMod(p.dir, checkMod(p.dir, { version: "0.3.0" }), o.mods, p.dir);
    const own = memoryScreens();
    const screens = withModScreens(own, modScreens(o.mods));
    const look = { url: "scratch.test/join", landmarks: ["heading join", "button go", "text x"] };
    const row = screens.find("scratch", null, look);
    expect(row?.from).toBe("autobrowse-mod-scratch");
    expect(own.list()).toHaveLength(0);
    if (row) screens.used(row);
    expect(own.list()).toMatchObject([
      { url: "scratch.test/join", from: "autobrowse-mod-scratch" },
    ]);
    expect(screens.find("scratch", null, look)?.from).toBe("autobrowse-mod-scratch");
    expect(screens.find("scratch", null, look)).toBe(own.list()[0]);
  });

  it("a mod's fix that works is copied into the owner's own; the owner's fix wins", () => {
    const failed = { role: "button", name: "Old" };
    const own = memoryFixes();
    const fixes = withModFixes(own, [
      {
        flow: "scratch/join",
        goal: "click Join",
        failed,
        hints: { role: "button", name: "Join" },
        reason: "renamed",
        url: "https://scratch.test/join",
        found: "2026-10-01T00:00:00.000Z",
        used: 0,
        from: "autobrowse-mod-scratch",
      },
    ]);
    expect(fixes.find("scratch/join", "click Join", failed)?.hints.name).toBe("Join");
    fixes.used("scratch/join", "click Join", failed);
    expect(own.list()).toMatchObject([{ flow: "scratch/join", from: "autobrowse-mod-scratch" }]);
  });
});

const login = (o: Partial<DataLogin> = {}): DataLogin =>
  dataLoginSchema.parse({
    site: "scratch",
    home: "https://app.scratch.test/home",
    signedIn: { url: "app\\.scratch\\.test/home" },
    form: {
      start: `https://scratch.test/login?as=${USER}`,
      username: { role: "textbox", name: "Email" },
      password: { role: "textbox", name: "Password" },
      submit: { role: "button", name: "/^sign in$/i" },
      code: [
        {
          kind: "totp",
          field: { role: "textbox", name: "Code" },
          submit: { role: "button", name: "Verify" },
        },
      ],
    },
    ...o,
  });

describe("logins as data", () => {
  it("pack --login scrubs it and lists its credential; add accepts it", async () => {
    const o = await owner();
    const p = packMod({
      site: "scratch",
      walksDir: o.walks,
      walks: [],
      login: login({ ask: `Your scratch account (${USER})` }),
      scrub: o.scrub,
      out: join(o.dir, "out"),
      version: "0.3.0",
    });
    const body = readFileSync(join(p.dir, "logins/scratch.json"), "utf8");
    expect(body).not.toContain(USER);
    expect(JSON.parse(body).form.start).toBe("https://scratch.test/login");
    expect(p.mod).toMatchObject({
      credentials: ["scratch:main"],
      domains: ["app.scratch.test", "scratch.test"],
    });
    expect(checkMod(p.dir, { version: "0.3.0" }).files[0]?.kind).toBe("login");
  });

  it("refuses a login that replaces a built-in, or sends the password to a host without the site's name", () => {
    const mod = {
      sites: ["scratch", "google"],
      domains: ["scratch.test", "elsewhere.test", "google.com"],
    };
    expect(loginProblems(login(), mod)).toEqual([]);
    expect(
      loginProblems(login({ site: "google", home: "https://accounts.google.com/" }), mod),
    ).toEqual(["google has a built-in login; a mod can't replace it"]);
    expect(loginProblems(login({ origins: ["elsewhere.test"] }), mod)).toEqual([
      "origin elsewhere.test does not carry the name scratch",
    ]);
    expect(loginProblems(login({ home: "https://other.test/" }), mod)).toEqual([
      "home other.test is outside domains",
      "home other.test does not carry the name scratch",
    ]);
  });

  it("a mod's origin on a shared host (user.herokuapp.com) does not carry the suffix owner's name", () => {
    const mod = { sites: ["herokuapp"], domains: ["herokuapp.com", "scratch.test"] };
    expect(
      loginProblems(
        login({
          site: "herokuapp",
          home: "https://herokuapp.com/",
          origins: ["evil.herokuapp.com"],
        }),
        mod,
      ),
    ).toEqual(["origin evil.herokuapp.com does not carry the name herokuapp"]);
  });

  it("an installed mod's login joins SITE_LOGINS after every built-in; a built-in of the same name wins", async () => {
    const o = await owner();
    const p = packMod({
      site: "scratch",
      walksDir: o.walks,
      walks: [],
      login: login(),
      scrub: o.scrub,
      out: join(o.dir, "out"),
      version: "0.3.0",
    });
    await installMod(p.dir, checkMod(p.dir, { version: "0.3.0" }), o.mods, p.dir);
    // The owner's own login for a built-in site is skipped: the built-in wins.
    mkdirSync(join(o.dir, "logins"));
    writeFileSync(
      join(o.dir, "logins", "google.json"),
      JSON.stringify(login({ site: "google", home: "https://google.com/" })),
    );
    const google = SITE_LOGINS.find((l) => l.site === "google");
    registerDataLogins(join(o.dir, "logins"), o.mods);
    expect(SITE_LOGINS.find((l) => l.site === "google")).toBe(google);
    expect(SITE_LOGINS.at(-1)).toMatchObject({
      site: "scratch",
      home: "https://app.scratch.test/home",
    });
  });
});

describe("code mods", () => {
  /** A hand-made mod with one workflow file: a code kind. */
  function codeMod(dir: string) {
    const body = 'export const workflow = { name: "scratch-code", steps: [] };\n';
    mkdirSync(join(dir, "workflows", "scratch-code"), { recursive: true });
    writeFileSync(join(dir, "workflows", "scratch-code", "index.ts"), body);
    writeFileSync(
      join(dir, "mod.json"),
      JSON.stringify({
        name: "autobrowse-mod-code",
        version: "0.1.0",
        autobrowse: ">=0.3.0",
        description: "a workflow",
        sites: ["scratch"],
        domains: ["scratch.test"],
        gates: [],
        credentials: [],
        irreversible: false,
        files: [
          { kind: "workflow", path: "workflows/scratch-code/index.ts", sha256: sha256(body) },
        ],
      }),
    );
  }

  it("are refused without --trust, and an installed mod's code never loads untrusted", async () => {
    const o = await owner();
    const src = join(o.dir, "code");
    codeMod(src);
    expect(() => checkMod(src, { version: "0.3.0" })).toThrow(/--trust/);
    const mod = checkMod(src, { version: "0.3.0", trust: true });
    await expect(installMod(src, mod, o.mods, src)).rejects.toThrow(/--trust/);
    expect(existsSync(join(o.mods, "autobrowse-mod-code"))).toBe(false);
    // Copied in by hand, without the trusted mark: its workflows are not read.
    const dest = join(o.mods, "autobrowse-mod-code");
    codeMod(dest);
    writeFileSync(join(dest, "installed.json"), JSON.stringify({ source: src, at: "2026-10-04" }));
    expect(modWorkflowRoots(o.mods)).toEqual([]);
    writeFileSync(
      join(dest, "installed.json"),
      JSON.stringify({ source: src, at: "2026-10-04", trusted: true }),
    );
    expect(modWorkflowRoots(o.mods)).toEqual([join(dest, "workflows")]);
  });

  it("the Mods page adds data only: check shows the asks, add, list says what it did, remove", async () => {
    const o = await owner();
    saveWalk(o.walks, walk());
    const p = pack(o);
    const kept = [{ from: "autobrowse-mod-scratch" }, {}];
    const port = modsPort(o.mods, { screens: () => kept, fixes: () => [] });
    const seen = await port.check(p.dir);
    expect(seen).toMatchObject({ name: "autobrowse-mod-scratch", source: p.dir });
    expect(seen.permissions.join("\n")).toMatch(/data only/);
    expect(port.list()).toEqual([]);
    await port.add(seen.source);
    expect(port.list()).toMatchObject([
      { trusted: false, walks: ["walk-join-list"], kept: { screens: 1, fixes: 0 } },
    ]);
    const code = join(o.dir, "code");
    codeMod(code);
    await expect(port.check(code)).rejects.toThrow(/--trust/);
    await expect(port.add(code)).rejects.toThrow(/--trust/);
    expect(port.remove("autobrowse-mod-scratch")).toBe(true);
    expect(port.list()).toEqual([]);
  });
});

describe("mods search", () => {
  it("reads each hit's autobrowseMod field; a hit without one counts as code", async () => {
    const pages: Record<string, unknown> = {
      "/-/v1/search": {
        objects: [
          { package: { name: "autobrowse-mod-scratch", version: "0.1.0" } },
          { package: { name: "@x/autobrowse-mod-odd", version: "1.0.0" } },
        ],
      },
      "/autobrowse-mod-scratch/0.1.0": {
        description: "scratch",
        autobrowseMod: {
          sites: ["scratch"],
          domains: ["scratch.test"],
          gates: ["send"],
          code: false,
        },
      },
      "/@x%2fautobrowse-mod-odd/1.0.0": { description: "odd" },
    };
    const get = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/-/v1/search")
        expect(u.searchParams.get("text")).toBe("keywords:autobrowse-mod scratch");
      const body = pages[u.pathname];
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
    }) as typeof fetch;
    expect(await searchMods("scratch", get)).toEqual([
      {
        name: "autobrowse-mod-scratch",
        version: "0.1.0",
        description: "scratch",
        sites: ["scratch"],
        domains: ["scratch.test"],
        gates: ["send"],
        code: false,
      },
      {
        name: "@x/autobrowse-mod-odd",
        version: "1.0.0",
        description: "odd",
        sites: [],
        domains: [],
        gates: [],
        code: true,
      },
    ]);
  });
});
