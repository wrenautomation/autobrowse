/**
 * How Restate reaches this worker. Two shapes, one decision made from settings:
 *
 * - `listen`: an HTTP/2 listener on `restatePort`. Compose (Restate next
 *   door) and a public endpoint (then `restateIdentityKey` is required so only
 *   the one environment can call in).
 * - `tunnel`: no inbound port at all. The worker dials Restate Cloud's tunnel
 *   for its environment and Restate reaches it back down that connection. The
 *   box then needs no public address, no TLS, no security group hole.
 *
 * Both end with the worker registering itself (`registerDeployment`) so nobody
 * runs `restate deployments register` by hand.
 */
import type { Settings } from "./config.js";

export type EndpointPlan =
  | { mode: "listen"; port: number; identityKeys: string[]; register: string | null }
  | {
      mode: "tunnel";
      tunnelName: string;
      environmentId: string;
      region: string;
      signingPublicKey: string;
    };

type Keys = Pick<
  Settings,
  | "restatePort"
  | "restateEndpointUrl"
  | "restateAdminUrl"
  | "restateTunnelName"
  | "restateEnvironmentId"
  | "restateCloudRegion"
  | "restateIdentityKey"
  | "restateAuthToken"
>;

/** Pure: settings → which shape, or a clear error when the tunnel is half-configured. */
export function planEndpoint(s: Keys): EndpointPlan {
  const tunnel = [s.restateTunnelName, s.restateEnvironmentId, s.restateCloudRegion];
  const set = tunnel.filter(Boolean).length;
  if (set === 0) {
    return {
      mode: "listen",
      port: s.restatePort,
      identityKeys: s.restateIdentityKey ? [s.restateIdentityKey] : [],
      register: s.restateAdminUrl && s.restateEndpointUrl ? s.restateEndpointUrl : null,
    };
  }
  if (set < tunnel.length || !s.restateIdentityKey || !s.restateAuthToken) {
    throw new Error(
      "restate tunnel needs RESTATE_TUNNEL_NAME, RESTATE_ENVIRONMENT_ID, RESTATE_CLOUD_REGION, RESTATE_IDENTITY_KEY and RESTATE_AUTH_TOKEN together",
    );
  }
  return {
    mode: "tunnel",
    tunnelName: s.restateTunnelName as string,
    environmentId: s.restateEnvironmentId as string,
    region: s.restateCloudRegion as string,
    signingPublicKey: s.restateIdentityKey,
  };
}

/** The admin URL a tunnel registers against: Restate Cloud's, derived from the env id. */
export function cloudAdminUrl(environmentId: string, region: string): string {
  return `https://${environmentId.replace(/^env_/, "")}.env.${region}.restate.cloud:9070`;
}
