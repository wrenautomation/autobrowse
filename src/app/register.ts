/**
 * Tell Restate where this worker is. In compose/k8s the worker knows its
 * own address and Restate's admin URL, so nobody runs `restate deployments
 * register` by hand. Idempotent: re-registering the same endpoint with the
 * same services is a no-op for Restate; `force` covers a redeploy at the
 * same address.
 */
import type { HttpClient } from "../clients/http.js";

export async function registerDeployment(opts: {
  adminUrl: string;
  endpointUrl: string;
  http: HttpClient;
  authToken?: string | null;
}): Promise<{ id: string; services: string[] }> {
  const r = await opts.http.json<{ id: string; services: Array<{ name: string }> }>(
    `${opts.adminUrl.replace(/\/$/, "")}/deployments`,
    {
      method: "POST",
      headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {},
      body: { uri: opts.endpointUrl, force: true },
    },
  );
  if (!r.ok || !r.body) throw new Error(`restate admin: register HTTP ${r.status}`);
  return { id: r.body.id, services: r.body.services.map((s) => s.name) };
}
