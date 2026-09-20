import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { cloudAdminUrl, planEndpoint } from "../src/app/endpoint.js";

const base = { RESTATE_INGRESS_URL: "http://127.0.0.1:8080" };

describe("planEndpoint", () => {
  it("listens by default, registering only when both compose URLs are set", () => {
    expect(planEndpoint(loadSettings(base))).toEqual({
      mode: "listen",
      port: 9081,
      identityKeys: [],
      register: null,
    });
    const compose = planEndpoint(
      loadSettings({
        ...base,
        RESTATE_ADMIN_URL: "http://restate:9070",
        RESTATE_ENDPOINT_URL: "http://worker:9081",
        RESTATE_IDENTITY_KEY: "publickeyv1_ABC123",
      }),
    );
    expect(compose).toMatchObject({
      mode: "listen",
      register: "http://worker:9081",
      identityKeys: ["publickeyv1_ABC123"],
    });
  });
  it("tunnels when the cloud identity is complete", () => {
    const plan = planEndpoint(
      loadSettings({
        ...base,
        RESTATE_AUTH_TOKEN: "key_x",
        RESTATE_TUNNEL_NAME: "autobrowse-v1",
        RESTATE_ENVIRONMENT_ID: "env_abc123",
        RESTATE_CLOUD_REGION: "us",
        RESTATE_IDENTITY_KEY: "publickeyv1_ABC123",
      }),
    );
    expect(plan).toEqual({
      mode: "tunnel",
      tunnelName: "autobrowse-v1",
      environmentId: "env_abc123",
      region: "us",
      signingPublicKey: "publickeyv1_ABC123",
    });
  });
  it("refuses a half-configured tunnel rather than silently listening", () => {
    expect(() =>
      planEndpoint(loadSettings({ ...base, RESTATE_TUNNEL_NAME: "autobrowse-v1" })),
    ).toThrow(/together/);
    expect(() =>
      planEndpoint(
        loadSettings({
          ...base,
          RESTATE_TUNNEL_NAME: "autobrowse-v1",
          RESTATE_ENVIRONMENT_ID: "env_abc123",
          RESTATE_CLOUD_REGION: "us",
          RESTATE_IDENTITY_KEY: "publickeyv1_ABC123",
        }),
      ),
    ).toThrow(/RESTATE_AUTH_TOKEN/);
  });
  it("derives the cloud admin URL from the env id", () => {
    expect(cloudAdminUrl("env_abc123", "us")).toBe("https://abc123.env.us.restate.cloud:9070");
  });
});
