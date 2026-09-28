/**
 * API plus the built SPA from `ui/dist`, one port. Loopback unless
 * `UI_HOST` says otherwise: a worker must not be reachable from the
 * network by accident.
 */
import { existsSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type ApiDeps, api } from "./api.js";

export interface UiServerOptions extends ApiDeps {
  port: number;
  /**
   * Interface to bind. Unset: loopback. A container sets it to 0.0.0.0 and
   * lets the host's port mapping (and the token) do the restricting.
   */
  host?: string;
  /** Directory of the built SPA; skipped when missing (API only). */
  distDir: string;
}

export function uiApp(opts: UiServerOptions): Hono {
  const app = new Hono();
  app.route("/", api(opts));
  if (existsSync(opts.distDir)) {
    app.use("/*", serveStatic({ root: opts.distDir }));
    // Client-side routes: anything else is the SPA shell.
    app.get("*", serveStatic({ root: opts.distDir, path: "index.html" }));
  }
  return app;
}

export function startUiServer(opts: UiServerOptions): ServerType {
  const app = uiApp(opts);
  // Loopback unless told: a token over plain HTTP on café Wi-Fi is readable by anyone on it.
  const hostname = opts.host ?? "127.0.0.1";
  return serve({ fetch: app.fetch, port: opts.port, hostname });
}
