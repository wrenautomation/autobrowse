/** A credential link: the Worker gets only signed ciphertext; the fragment's key opens it. */
import { createHmac, webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { LINK_SIGNATURE, mintCredentialLink } from "../src/auth/link.js";

it("posts signed ciphertext and returns a link whose fragment key decrypts it", async () => {
  let sent: { url: string; headers: Headers; body: string } | null = null;
  const post = (async (url: string, init: RequestInit) => {
    sent = { url, headers: new Headers(init.headers), body: String(init.body) };
    return Response.json({ id: "AAAAAAAAAAAAAAAAAAAAAA" });
  }) as typeof fetch;
  const login = { site: "example", username: "someone@example.com", password: "pw-123" };
  const link = await mintCredentialLink("https://phone.test/", "s3cret", login, post);

  const got = sent as unknown as { url: string; headers: Headers; body: string };
  expect(got.url).toBe("https://phone.test/links");
  expect(got.headers.get(LINK_SIGNATURE)).toBe(
    createHmac("sha256", "s3cret").update(got.body).digest("hex"),
  );
  expect(got.body).not.toContain("pw-123");
  expect(got.body).not.toContain("someone@");

  const [path, frag] = link.split("#") as [string, string];
  expect(path).toBe("https://phone.test/c/AAAAAAAAAAAAAAAAAAAAAA");
  const { iv, data } = JSON.parse(got.body) as { iv: string; data: string };
  // As the reveal page does it, with WebCrypto.
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(frag, "base64url"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    key,
    Buffer.from(data, "base64"),
  );
  expect(JSON.parse(Buffer.from(plain).toString())).toEqual(login);
});

it("a refused mint is an error, never a link", async () => {
  const post = (async () => new Response("bad signature", { status: 401 })) as typeof fetch;
  await expect(
    mintCredentialLink(
      "https://phone.test",
      "x",
      { site: "a", username: "u", password: "p" },
      post,
    ),
  ).rejects.toThrow(/401/);
});
