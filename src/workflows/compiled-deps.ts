/**
 * The deps a rendered workflow may ask for. Its own module so `proof`
 * (which runs one) and `compiled` (which lists them) both import it
 * without importing each other.
 */
import { envSecrets, type SecretAudit, type SecretSource, trackingSecrets } from "credkeep";
import { boundRunner } from "../auth/guard.js";
import { SECRET_ENV_PREFIX } from "../auth/keep.js";
import { siteAllowsHost } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import type { FlowRunner } from "../browser/flow.js";
import { localShell, type Shell } from "../deps/shell.js";
import { envFileSink, type SecretSink } from "../deps/sink.js";
import { macDesktop } from "../desktop/mac.js";
import { type Desktop, noDesktop } from "../desktop/types.js";

/** Everything a rendered workflow may ask for; the renderer declares only what a flow uses. */
export interface CompiledDeps {
  browser: FlowRunner;
  /** Values the recorder redacted, by key; `AUTOBROWSE_<KEY>` in the environment unless given. */
  secrets: SecretSource;
  /** Terminal legs of a recording; the worker's own shell unless given. */
  shell: Shell;
  /** Desktop legs (apps, menus, root commands); this Mac, or a host that says it has none. */
  desktop: Desktop;
  /** Where a `keep` op puts a secret the site minted; the local .env unless given. */
  sink: SecretSink;
}

/**
 * The deps with the browser bound: a secret a step fetched through
 * `secrets` is typed only on the flow's own site (its login origins, or a
 * host carrying its word), and every such fill is audited under the flow's
 * name. The binding is here, not in the renderer, so every compiled
 * workflow gets it whatever it was rendered from.
 */
export function compiledDeps(
  browser: FlowRunner,
  o: {
    secrets?: SecretSource;
    shell?: Shell;
    desktop?: Desktop;
    sink?: SecretSink;
    audit?: SecretAudit;
  } = {},
): CompiledDeps {
  const secrets = trackingSecrets(o.secrets ?? envSecrets(process.env, SECRET_ENV_PREFIX));
  return {
    browser: boundRunner(browser, {
      secrets,
      allow: (site, host) => siteAllowsHost(SITE_LOGINS, site, host),
      audit: o.audit,
    }),
    secrets,
    shell: o.shell ?? localShell(),
    sink: o.sink ?? envFileSink(".env"),
    desktop: o.desktop ?? (process.platform === "darwin" ? macDesktop() : noDesktop()),
  };
}
