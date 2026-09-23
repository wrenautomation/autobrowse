import { describe, expect, it } from "vitest";
import { registerDeployment } from "../src/app/register.js";
import { type HttpClient, HttpError } from "../src/clients/http.js";

const ok = { status: 201, ok: true, body: { id: "dp_1", services: [{ name: "Flow" }] } };

function client(replies: Array<object | Error>): HttpClient & { calls: number } {
  const c = {
    calls: 0,
    async json() {
      const r = replies[c.calls++];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return c as unknown as HttpClient & { calls: number };
}

const base = {
  adminUrl: "http://restate:9070/",
  endpointUrl: "http://w:9081",
  sleep: async () => {},
};

describe("registerDeployment", () => {
  it("waits out a Restate that is still booting", async () => {
    const http = client([
      new HttpError("POST", "http://restate:9070/deployments", 0, "timeout"),
      { status: 500, ok: false, body: null },
      ok,
    ]);
    expect(await registerDeployment({ ...base, http })).toEqual({ id: "dp_1", services: ["Flow"] });
    expect(http.calls).toBe(3);
  });

  it("gives up on a 4xx at once", async () => {
    const http = client([{ status: 400, ok: false, body: null }, ok]);
    await expect(registerDeployment({ ...base, http })).rejects.toThrow("register HTTP 400");
    expect(http.calls).toBe(1);
  });

  it("gives up after the last attempt", async () => {
    const http = client([
      { status: 503, ok: false, body: null },
      { status: 503, ok: false, body: null },
    ]);
    await expect(registerDeployment({ ...base, http, attempts: 2 })).rejects.toThrow("HTTP 503");
    expect(http.calls).toBe(2);
  });
});
