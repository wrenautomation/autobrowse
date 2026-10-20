/**
 * The `./google` piece: service-account tokens, the Gmail wire (`GmailClient`) and the one-user
 * helpers over it (`gmailClient`). No network: every call goes through an injected fetch and
 * every bearer comes from an injected token factory. Keys are generated here; data is synthetic.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  delegatedScopes,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  GmailApiError,
  GmailClient,
  gmailClient,
  gmailPushTopic,
  loadServiceAccountKey,
  POSTMASTER_SCOPE,
  POSTMASTER_TRAFFIC_SCOPE,
  postmasterToken,
  SCOPES,
  SEND_AND_READ_SCOPES,
  ServiceAccountKeyError,
  serviceAccountToken,
  TokenRefreshError,
  type TokenSupplier,
} from "../src/google/index.js";

const SENDER = "a@example.com";

describe("delegatedScopes", () => {
  it("asks the delegated account for gmail.modify where a consent would ask readonly", () => {
    expect(delegatedScopes([SCOPES.gmailRead, SCOPES.gmailSend])).toEqual([
      SCOPES.gmailModify,
      SCOPES.gmailSend,
    ]);
  });
});

describe("loadServiceAccountKey", () => {
  const KEY = {
    type: "service_account",
    client_email: "sender@proj.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
  };

  it("reads a key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-key-"));
    const path = join(dir, "key.json");
    writeFileSync(path, JSON.stringify(KEY));
    const key = loadServiceAccountKey(path);
    expect(key.clientEmail).toBe(KEY.client_email);
    expect(key.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });

  it("accepts the key's JSON inline, for hosts without a key file", () => {
    const key = loadServiceAccountKey(JSON.stringify(KEY));
    expect(key.clientEmail).toBe(KEY.client_email);
    expect(key.privateKey).toBe(KEY.private_key);
  });

  it("names the env var, not the value, when inline JSON is bad", () => {
    const err = (() => {
      try {
        loadServiceAccountKey('{"type": "service_account", "private_key": "hunter2"');
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ServiceAccountKeyError);
    expect(err?.message).toContain("GOOGLE_SERVICE_ACCOUNT");
    expect(err?.message).not.toContain("hunter2");
  });

  it("names the env var the caller passes", () => {
    expect(() => loadServiceAccountKey("/nope/key.json", "MY_KEY")).toThrow(/set MY_KEY/);
  });

  it("names the missing file", () => {
    expect(() => loadServiceAccountKey("/nope/key.json")).toThrow(/not found at \/nope\/key.json/);
  });
});

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
type Handler = (req: Seen) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function build(
  handler: Handler,
  tokenFactory?: (sender: string) => TokenSupplier,
): { client: GmailClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchOf = async (input: string, init: RequestInit = {}) => {
    const req: Seen = {
      url: new URL(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})),
      body: typeof init.body === "string" ? init.body : null,
    };
    seen.push(req);
    return handler(req);
  };
  const client = new GmailClient({
    fetch: fetchOf,
    scopes: SEND_AND_READ_SCOPES,
    tokenFactory: tokenFactory ?? ((sender) => async () => `token-for-${sender}`),
  });
  return { client, seen };
}
describe("GmailClient", () => {
  it("one token supplier per sender", async () => {
    const minted: string[] = [];
    const { client } = build(
      () => jsonResponse(200, { id: "g1", threadId: "t1" }),
      (sender) => {
        minted.push(sender);
        return async () => `token-for-${sender}`;
      },
    );
    await client.sendRaw(SENDER, Buffer.from("x"));
    await client.sendRaw(SENDER, Buffer.from("y"));
    await client.sendRaw("b@example.com", Buffer.from("z"));
    expect(minted).toEqual([SENDER, "b@example.com"]);
  });

  it("sends raw bytes as base64url in a thread, with the bearer in a header only", async () => {
    const { client, seen } = build(() => jsonResponse(200, { id: "g1", threadId: "t1" }));
    await client.sendRaw(SENDER, Buffer.from("hello"), "t0");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url.pathname).toBe("/gmail/v1/users/me/messages/send");
    expect(seen[0]?.url.search).toBe("");
    expect(seen[0]?.headers.authorization).toBe(`Bearer token-for-${SENDER}`);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      raw: Buffer.from("hello").toString("base64url"),
      threadId: "t0",
    });
  });

  it("a non-2xx is a GmailApiError that never carries the bearer", async () => {
    const { client } = build(() => jsonResponse(403, { error: { message: "Delegation denied" } }));
    const err = await client.sendRaw(SENDER, Buffer.from("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(403);
    expect((err as Error).message).toContain("Delegation denied");
    expect((err as Error).message).not.toContain("token-for-");
  });

  it("a fetch failure passes through untouched", async () => {
    const boom = new TypeError("fetch failed");
    const { client } = build(() => {
      throw boom;
    });
    await expect(client.getRaw(SENDER, "m1")).rejects.toBe(boom);
  });

  it("list messages pages through the cursor", async () => {
    const { client, seen } = build((req) =>
      req.url.searchParams.has("pageToken")
        ? jsonResponse(200, { messages: [{ id: "c" }] })
        : jsonResponse(200, { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "page-2" }),
    );
    let [ids, token] = await client.listMessages(SENDER, "after:1757289600", { maxResults: 2 });
    expect([ids, token]).toEqual([["a", "b"], "page-2"]);
    expect(seen[0]?.url.searchParams.get("q")).toBe("after:1757289600");
    expect(seen[0]?.url.searchParams.get("maxResults")).toBe("2");
    [ids, token] = await client.listMessages(SENDER, "after:1757289600", { pageToken: token });
    expect([ids, token]).toEqual([["c"], null]);
    expect(seen[0]?.url.searchParams.has("includeSpamTrash")).toBe(false);
  });

  it("search all pages by 100 until no token is left", async () => {
    const { client, seen } = build((req) =>
      req.url.searchParams.get("pageToken") === "p2"
        ? jsonResponse(200, { messages: [{ id: "c" }] })
        : jsonResponse(200, { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" }),
    );
    expect(await client.searchAll(SENDER, "from:x")).toEqual(["a", "b", "c"]);
    expect(seen.map((s) => s.url.searchParams.get("maxResults"))).toEqual(["100", "100"]);
    expect(seen.map((s) => s.url.searchParams.get("pageToken"))).toEqual([null, "p2"]);
    expect(seen.every((s) => !s.url.searchParams.has("includeSpamTrash"))).toBe(true);
  });

  it("list messages can be told to read spam and trash", async () => {
    const { client, seen } = build(() => jsonResponse(200, { messages: [{ id: "a" }] }));
    await client.listMessages(SENDER, "after:1", { includeSpamTrash: true });
    expect(seen[0]?.url.searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("get metadata asks for exactly the headers it names", async () => {
    const payload = { id: "g9", payload: { headers: [{ name: "Subject", value: "hi" }] } };
    const { client, seen } = build(() => jsonResponse(200, payload));
    expect(await client.getMetadata(SENDER, "g9", ["Subject", "From"])).toEqual(payload);
    expect(seen[0]?.url.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From"]);
  });

  it("get raw decodes gmail's unpadded base64url", async () => {
    const body = Buffer.from("From: a@b.com\r\nSubject: hi\r\n\r\nbody\r\n");
    const { client, seen } = build(() => jsonResponse(200, { raw: body.toString("base64url") }));
    expect((await client.getRaw(SENDER, "g9")).equals(body)).toBe(true);
    expect(seen[0]?.url.searchParams.get("format")).toBe("raw");
  });

  it("find by message id returns the handles, or null when the mailbox has nothing", async () => {
    const { client, seen } = build((req) =>
      req.url.pathname.endsWith("/messages")
        ? jsonResponse(200, { messages: [{ id: "g9" }] })
        : jsonResponse(200, { id: "g9", threadId: "t9", internalDate: "1757289600000" }),
    );
    expect(await client.findByMessageId(SENDER, "<m1@example.com>")).toEqual({
      id: "g9",
      threadId: "t9",
      internalDate: "1757289600000",
    });
    expect(seen[0]?.url.searchParams.get("q")).toBe("rfc822msgid:m1@example.com");
    const none = build(() => jsonResponse(200, {}));
    expect(await none.client.findByMessageId(SENDER, "<m1@example.com>")).toBeNull();
  });

  it("send-as reads and patches the entry for an address", async () => {
    const { client, seen } = build((req) =>
      jsonResponse(200, req.method === "GET" ? { signature: "old" } : { signature: "new" }),
    );
    expect(await client.sendAs(SENDER, SENDER)).toEqual({ signature: "old" });
    await client.patchSendAs(SENDER, SENDER, { signature: "new" });
    expect(seen.map((s) => s.method)).toEqual(["GET", "PATCH"]);
    expect(seen[1]?.url.pathname).toBe(
      `/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(SENDER)}`,
    );
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ signature: "new" });
  });

  it("watch asks for inbox changes on the service account's project topic", async () => {
    const topic = gmailPushTopic("sender@acme-proj.iam.gserviceaccount.com");
    expect(topic).toBe("projects/acme-proj/topics/gmail-push");
    const { client, seen } = build(() =>
      jsonResponse(200, { historyId: "9", expiration: "1760000000000" }),
    );
    expect(await client.watch(SENDER, topic)).toBe(1_760_000_000_000);
    expect(seen[0]?.url.pathname).toBe("/gmail/v1/users/me/watch");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      topicName: topic,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
  });

  it("asks for modify, not readonly, to read", () => {
    expect(SEND_AND_READ_SCOPES).toEqual([GMAIL_SEND_SCOPE, GMAIL_MODIFY_SCOPE]);
  });

  it("needs a key, a keyPath or a token factory", async () => {
    const client = new GmailClient({ fetch: async () => jsonResponse(200, {}) });
    await expect(client.ensureToken(SENDER)).rejects.toBeInstanceOf(ServiceAccountKeyError);
  });

  it("a bad key names the caller's env var", async () => {
    const client = new GmailClient({
      keyPath: '{"type": "service_account"',
      keyEnv: "APP_GOOGLE_KEY",
      fetch: async () => jsonResponse(200, {}),
    });
    await expect(client.ensureToken(SENDER)).rejects.toThrow(/^APP_GOOGLE_KEY holds JSON/);
  });
});

describe("service-account tokens", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    clientEmail: "sender@project.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenUri: "https://oauth2.googleapis.com/token",
  };

  it("mints a signed jwt-bearer assertion acting as the subject and caches it", async () => {
    const calls: string[] = [];
    let clock = new Date("2026-09-08T13:00:00Z");
    const supplier = serviceAccountToken(key, {
      scopes: SEND_AND_READ_SCOPES,
      subject: SENDER,
      now: () => clock,
      fetch: async (input, init = {}) => {
        calls.push(input);
        const form = new URLSearchParams(init.body as string);
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const [h, p, s] = (form.get("assertion") ?? "").split(".");
        expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({
          alg: "RS256",
          typ: "JWT",
        });
        const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as Record<
          string,
          unknown
        >;
        expect(claims.sub).toBe(SENDER);
        expect(claims.iss).toBe(key.clientEmail);
        expect(claims.scope).toBe(`${GMAIL_SEND_SCOPE} ${GMAIL_MODIFY_SCOPE}`);
        expect(claims.aud).toBe(key.tokenUri);
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${h}.${p}`);
        expect(verifier.verify(publicKey, s ?? "", "base64url")).toBe(true);
        return jsonResponse(200, { access_token: "ya29.abc", expires_in: 3600 });
      },
    });
    expect(await supplier()).toBe("ya29.abc");
    expect(await supplier()).toBe("ya29.abc");
    expect(calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 3600_000);
    await supplier();
    expect(calls).toHaveLength(2);
  });

  it("a refusal from google is a TokenRefreshError without the assertion in it", async () => {
    const supplier = serviceAccountToken(key, {
      scopes: [GMAIL_SEND_SCOPE],
      subject: SENDER,
      fetch: async () =>
        jsonResponse(401, {
          error: "unauthorized_client",
          error_description: "Client is unauthorized",
        }),
    });
    const err = await supplier().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as Error).message).toContain("unauthorized_client: Client is unauthorized");
    expect((err as Error).message).not.toContain("eyJ");
  });

  it("a key that cannot sign is a ServiceAccountKeyError", async () => {
    const supplier = serviceAccountToken(
      { ...key, privateKey: "not a key" },
      { scopes: [GMAIL_SEND_SCOPE], fetch: async () => jsonResponse(200, {}) },
    );
    await expect(supplier()).rejects.toBeInstanceOf(ServiceAccountKeyError);
  });

  it("postmaster: the narrow scope first, the broad one when it is refused", async () => {
    const asked: string[] = [];
    const fetch = async (_url: string, init: RequestInit = {}) => {
      const form = new URLSearchParams(init.body as string);
      const [, p] = (form.get("assertion") ?? "").split(".");
      const scope = (JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as { scope: string })
        .scope;
      asked.push(scope);
      return scope === POSTMASTER_TRAFFIC_SCOPE
        ? jsonResponse(400, { error: "invalid_scope" })
        : jsonResponse(200, { access_token: "t", expires_in: 3600 });
    };
    const supplier = await postmasterToken(key, SENDER, { fetch });
    expect(await supplier()).toBe("t");
    expect(asked).toEqual([POSTMASTER_TRAFFIC_SCOPE, POSTMASTER_SCOPE]);
  });
});

describe("gmailClient: one user's mail over the wire", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const text = (body: string, headers: Record<string, string> = {}, at = "1000") => ({
    internalDate: at,
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: b64(body) },
    },
  });

  function client(handler: Handler) {
    const seen: Seen[] = [];
    const minted: string[] = [];
    const gmail = gmailClient({
      tokenFor: (user, scopes) => {
        minted.push(`${user} ${scopes.join(",")}`);
        return async () => "tok";
      },
      scopes: { settings: "S", send: "W", read: "R" },
      fetch: async (input, init = {}) => {
        const req: Seen = {
          url: new URL(input),
          method: init.method ?? "GET",
          headers: Object.fromEntries(
            Object.entries((init.headers as Record<string, string>) ?? {}),
          ),
          body: typeof init.body === "string" ? init.body : null,
        };
        seen.push(req);
        return handler(req);
      },
    });
    return { gmail, seen, minted };
  }

  it("sets a signature once: the second time it is kept", async () => {
    let signature = "";
    const { gmail, seen, minted } = client((req) => {
      if (req.method === "PATCH")
        signature = (JSON.parse(req.body ?? "{}") as { signature: string }).signature;
      return jsonResponse(200, { signature });
    });
    expect(await gmail.setSignature(SENDER, "<b>hi</b>")).toBe("set");
    expect(await gmail.setSignature(SENDER, "<b>hi</b>")).toBe("kept");
    expect(seen.map((s) => s.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(minted.every((m) => m === `${SENDER} S`)).toBe(true);
  });

  it("sends a message as the sender with the send scope", async () => {
    const { gmail, seen, minted } = client(() => jsonResponse(200, { id: "g1", threadId: "t1" }));
    await gmail.send({ from: SENDER, to: "b@example.com", subject: "Hi", text: "Body" });
    expect(minted).toEqual([`${SENDER} W`]);
    const raw = Buffer.from(
      (JSON.parse(seen[0]?.body ?? "{}") as { raw: string }).raw,
      "base64url",
    );
    expect(raw.toString("utf8")).toContain("Subject: Hi");
  });

  it("a refused send is a GmailApiError", async () => {
    const { gmail } = client(() => jsonResponse(403, { error: { message: "no" } }));
    await expect(
      gmail.send({ from: SENDER, to: "b@example.com", subject: "Hi", text: "Body" }),
    ).rejects.toBeInstanceOf(GmailApiError);
  });

  it("recent reads spam too, newest first, and drops a message whose read failed", async () => {
    const { gmail, seen } = client((req) => {
      if (req.url.pathname.endsWith("/messages"))
        return jsonResponse(200, { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
      if (req.url.pathname.endsWith("m3")) return jsonResponse(404, { error: { message: "gone" } });
      return jsonResponse(
        200,
        text(
          req.url.pathname.endsWith("m1") ? "code 111" : "code 222",
          { From: "x@y.z" },
          req.url.pathname.endsWith("m1") ? "1000" : "2000",
        ),
      );
    });
    const got = await gmail.recent(SENDER, new Date(5_000_000));
    expect(got.map((m) => m.text)).toEqual(["code 222", "code 111"]);
    expect(got[0]?.from).toBe("x@y.z");
    const list = seen[0]?.url.searchParams;
    expect(list?.get("q")).toBe("after:5000");
    expect(list?.get("maxResults")).toBe("10");
    expect(list?.get("includeSpamTrash")).toBe("true");
    expect(seen[1]?.url.searchParams.get("format")).toBe("full");
  });

  it("search asks for From and Subject only, spam included, text empty", async () => {
    const { gmail, seen } = client((req) =>
      req.url.pathname.endsWith("/messages")
        ? jsonResponse(200, { messages: [{ id: "m1" }] })
        : jsonResponse(200, text("", { From: "x@y.z", Subject: "Hello" })),
    );
    const got = await gmail.search(SENDER, "from:x@y.z", 3);
    expect(got).toMatchObject([{ from: "x@y.z", subject: "Hello", text: "" }]);
    expect(seen[0]?.url.searchParams.get("maxResults")).toBe("3");
    expect(seen[0]?.url.searchParams.get("includeSpamTrash")).toBe("true");
    expect(seen[1]?.url.searchParams.get("format")).toBe("metadata");
    expect(seen[1]?.url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject"]);
  });

  it("whole returns raw messages, no spam, newest first", async () => {
    const rawOf = (subject: string) => `From: a@b.example\r\nSubject: ${subject}\r\n\r\nbody`;
    const { gmail, seen } = client((req) =>
      req.url.pathname.endsWith("/messages")
        ? jsonResponse(200, { messages: [{ id: "m1" }, { id: "m2" }] })
        : jsonResponse(200, {
            raw: b64(rawOf(req.url.pathname.endsWith("m1") ? "old" : "new")),
            internalDate: req.url.pathname.endsWith("m1") ? "1000" : "2000",
          }),
    );
    const got = await gmail.whole(SENDER, "label:x");
    expect(got.map((m) => m.subject)).toEqual(["new", "old"]);
    expect(got[0]?.raw.toString("utf8")).toContain("body");
    expect(seen[0]?.url.searchParams.get("maxResults")).toBe("5");
    expect(seen[0]?.url.searchParams.has("includeSpamTrash")).toBe(false);
    expect(seen[1]?.url.searchParams.get("format")).toBe("raw");
  });
});
