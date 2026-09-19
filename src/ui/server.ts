/**
 * API plus the built SPA from `ui/dist`, one port. Without a token the
 * server binds loopback only: a bare local worker must not be reachable
 * from the network by accident.
 */
import { existsSync } from "node:fs";
import { type ServerType, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type ApiDeps, api } from "./api.js";

export interface UiServerOptions extends ApiDeps {
  port: number;
  /**
   * Interface to bind. Unset: loopback without a token, all interfaces with
   * one. A container sets it to 0.0.0.0 and lets the host's port mapping
   * (or a token) do the restricting.
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
  const hostname = opts.host ?? (opts.token ? "0.0.0.0" : "127.0.0.1");
  return serve({ fetch: app.fetch, port: opts.port, hostname });
}
