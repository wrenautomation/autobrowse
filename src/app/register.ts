/**
 * Tell Restate where this worker is. In compose/k8s the worker knows its
 * own address and Restate's admin URL, so nobody runs `restate deployments
 * register` by hand. Idempotent: re-registering the same endpoint with the
 * same services is a no-op for Restate; `force` covers a redeploy at the
 * same address. That makes the POST safe to repeat, so a Restate that is
 * still booting (timeout, refused, 5xx) is waited out, not a crash.
 */
import { type HttpClient, HttpError } from "../clients/http.js";

export async function registerDeployment(opts: {
  adminUrl: string;
  endpointUrl: string;
  http: HttpClient;
  authToken?: string | null;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ id: string; services: string[] }> {
  const attempts = opts.attempts ?? 6;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      const r = await opts.http.json<{ id: string; services: Array<{ name: string }> }>(
        `${opts.adminUrl.replace(/\/$/, "")}/deployments`,
        {
          method: "POST",
          headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {},
          body: { uri: opts.endpointUrl, force: true },
        },
      );
      if (r.ok && r.body) return { id: r.body.id, services: r.body.services.map((s) => s.name) };
      if (r.status < 500 || attempt >= attempts)
        throw new Error(`restate admin: register HTTP ${r.status}`);
    } catch (err) {
      const transient = err instanceof HttpError && (err.status === 0 || err.status >= 500);
      if (!transient || attempt >= attempts) throw err;
    }
    // 2s, 4s, 8s, 16s, 30s: about a minute for Restate to come up.
    await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
  }
}
