/** A credential link: the Worker gets only signed ciphertext; the fragment's key opens it. */
import { createHmac, webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { LINK_SIGNATURE, linkLabel, linkTtl, mintCredentialLink } from "../src/auth/link.js";

function catcher() {
  const got: { url: string; headers: Headers; body: string }[] = [];
  const post = (async (url: string, init: RequestInit) => {
    got.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return Response.json({ id: "AAAAAAAAAAAAAAAAAAAAAA" });
  }) as typeof fetch;
  return { got, post };
}

it("posts signed ciphertext and returns a link whose fragment key decrypts it", async () => {
  const { got, post } = catcher();
  const secrets = {
    label: "example, API_KEY",
    fields: [
      { name: "example username", value: "someone@example.com" },
      { name: "example password", value: "pw-123" },
      { name: "API_KEY", value: "key-456" },
    ],
  };
  const link = await mintCredentialLink("https://phone.test/", "s3cret", secrets, {}, post);

  const sent = got[0] as { url: string; headers: Headers; body: string };
  expect(sent.url).toBe("https://phone.test/links");
  expect(sent.headers.get(LINK_SIGNATURE)).toBe(
    createHmac("sha256", "s3cret").update(sent.body).digest("hex"),
  );
  for (const f of secrets.fields) expect(sent.body).not.toContain(f.value);

  const [path, frag] = link.split("#") as [string, string];
  expect(path).toBe("https://phone.test/c/AAAAAAAAAAAAAAAAAAAAAA");
  const body = JSON.parse(sent.body) as { label: string; iv: string; data: string };
  expect(body).not.toHaveProperty("open");
  expect(body).not.toHaveProperty("ttl");
  expect(body.label).toBe("example, API_KEY");
  // As the reveal page does it, with WebCrypto.
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(frag, "base64url"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(body.iv, "base64") },
    key,
    Buffer.from(body.data, "base64"),
  );
  expect(JSON.parse(Buffer.from(plain).toString())).toEqual(secrets);
});

it("an open link asks for no sign-in and its own TTL", async () => {
  const { got, post } = catcher();
  await mintCredentialLink(
    "https://phone.test",
    "x",
    { label: "a", fields: [{ name: "K", value: "v" }] },
    { open: true, ttl: 86_400 },
    post,
  );
  expect(JSON.parse(got[0]?.body ?? "{}")).toMatchObject({ open: true, ttl: 86_400 });
});

it("a refused mint is an error, never a link", async () => {
  const post = (async () => new Response("bad signature", { status: 401 })) as typeof fetch;
  await expect(
    mintCredentialLink("https://phone.test", "x", { label: "a", fields: [] }, {}, post),
  ).rejects.toThrow(/401/);
});

it("reads a TTL and keeps a label to what the Worker takes", () => {
  expect(linkTtl("10m")).toBe(600);
  expect(linkTtl("24h")).toBe(86_400);
  expect(linkTtl("7d")).toBe(604_800);
  expect(() => linkTtl("30s")).toThrow();
  expect(() => linkTtl("8d")).toThrow();
  expect(() => linkTtl("soon")).toThrow();
  expect(linkLabel(["dynadot", "npm:alt", "a/b"])).toBe("dynadot, npm:alt, a-b");
});
