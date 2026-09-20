/**
 * The deps a rendered workflow may ask for. Its own module so `proof`
 * (which runs one) and `compiled` (which lists them) both import it
 * without importing each other.
 */
import type { FlowRunner } from "../browser/flow.js";
import { envSecrets, type SecretSource } from "../deps/secrets.js";
import { localShell, type Shell } from "../deps/shell.js";

/** Everything a rendered workflow may ask for; the renderer declares only what a flow uses. */
export interface CompiledDeps {
  browser: FlowRunner;
  /** Values the recorder redacted, by key; `AUTOBROWSE_<KEY>` in the environment unless given. */
  secrets: SecretSource;
  /** Terminal legs of a recording; the worker's own shell unless given. */
  shell: Shell;
}

export function compiledDeps(
  browser: FlowRunner,
  o: { secrets?: SecretSource; shell?: Shell } = {},
): CompiledDeps {
  return { browser, secrets: o.secrets ?? envSecrets(), shell: o.shell ?? localShell() };
}
