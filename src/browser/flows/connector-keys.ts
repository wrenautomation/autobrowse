/**
 * Read wren's connector apps' OAuth client id and secret off each developer
 * console into the sink, never printing them. The apps themselves were made
 * once in explore mode on 2026-10-09 (recordings hubspot-connector-app,
 * intuit-connector-app, intuit-connector-prod, jobber-connector-app); HubSpot's
 * is a CLI project (`assets/connectors/hubspot`, `autobrowse connectors
 * hubspot-upload`). Mapped then:
 *   HubSpot   developer-projects/<hub>/project/<p>/component/<app>/auth:
 *             button "Show", then `[role=tabpanel] p` nth 1 (id), nth 3 (secret)
 *   Intuit    appdetail/keys?appId=…&envTab=production (or development),
 *             switch "Show credentials", `span[class*=KeySegment__StyledFieldText]`
 *             nth 0 (id), nth 1 (secret)
 *   Jobber    developer.getjobber.com/apps/<id>: read-only inputs after the
 *             labels "Client ID" and "Client secret"
 */
import type { SecretSink } from "../../deps/sink.js";
import { defineFlow, type FlowPage } from "../flow.js";

// The in-page function below runs in the browser; this module compiles without the DOM lib.
interface Field {
  textContent: string | null;
  htmlFor?: string;
  value?: string;
  parentElement: { querySelector(sel: string): Field | null } | null;
}
declare const document: {
  querySelectorAll(sel: string): Iterable<Field>;
  getElementById(id: string): Field | null;
};

export const CONNECTOR_KEYS = {
  hubspot: ["CONNECTOR_HUBSPOT_ID", "CONNECTOR_HUBSPOT_SECRET"],
  quickbooks: ["CONNECTOR_QUICKBOOKS_ID", "CONNECTOR_QUICKBOOKS_SECRET"],
  "quickbooks-dev": ["CONNECTOR_QUICKBOOKS_DEV_ID", "CONNECTOR_QUICKBOOKS_DEV_SECRET"],
  jobber: ["CONNECTOR_JOBBER_ID", "CONNECTOR_JOBBER_SECRET"],
} as const;
export type ConnectorApp = keyof typeof CONNECTOR_KEYS;

export interface ConnectorKeysInput {
  /** The app's page on its developer console (`site status connectors` shows wren's). */
  url: string;
  sink?: SecretSink;
}

/** Text of the nth match, retried while the page renders. */
async function textAt(fp: FlowPage, css: string, nth: number): Promise<string> {
  const el = fp.page.locator(css).nth(nth);
  for (let i = 0; i < 10; i++) {
    const t = (await el.textContent({ timeout: 1_000 }).catch(() => ""))?.trim() ?? "";
    if (t && !/^[•*\s]+$/.test(t)) return t;
    await fp.wait(1_000);
  }
  return "";
}

/** One token, no spaces: every console's id and secret (UUIDs, `AB…` ids, hex). */
const KEYISH = /^[A-Za-z0-9_.:-]{16,}$/;

async function keep(
  fp: FlowPage,
  sink: SecretSink | undefined,
  names: readonly [string, string],
  id: string,
  secret: string,
) {
  // A label or a mask read by mistake must never overwrite a good key.
  if (!KEYISH.test(id) || !KEYISH.test(secret) || id === secret)
    return fp.human(`${names[0]}: the page showed no id or secret`);
  await sink?.put(names[0], id);
  await sink?.put(names[1], secret);
  return { kept: [...names] };
}

export const hubspotConnectorKeys = defineFlow<ConnectorKeysInput, { kept: string[] }>({
  secret: true,
  site: "hubspot",
  name: "connector-keys",
  // Made with Google: the session lives in the Google account's profile.
  profile: "provider",
  async run(fp, input) {
    await fp.open(input.url);
    await fp.act({ kind: "click" }, { role: "tab", name: "Auth" }, { goal: "open the Auth tab" });
    await fp.act({ kind: "click" }, { role: "button", text: "Show" }, { goal: "show the secret" });
    const id = await textAt(fp, "[role=tabpanel] p", 1);
    const secret = await textAt(fp, "[role=tabpanel] p", 3);
    return keep(fp, input.sink, CONNECTOR_KEYS.hubspot, id, secret);
  },
});

export const quickbooksConnectorKeys = defineFlow<
  ConnectorKeysInput & { dev?: boolean },
  { kept: string[] }
>({
  secret: true,
  site: "intuit",
  name: "connector-keys",
  async run(fp, input) {
    // The key set is a query param; the tab click lost the race with sign-in (2026-10-09).
    await fp.open(`${input.url}&envTab=${input.dev ? "development" : "production"}`);
    await fp.has({ role: "switch", name: "Show credentials" }, 15_000);
    await fp.act(
      { kind: "click" },
      { role: "switch", name: "Show credentials" },
      { goal: "show the keys" },
    );
    const span = "span[class*=KeySegment__StyledFieldText]";
    const id = await textAt(fp, span, 0);
    const secret = await textAt(fp, span, 1);
    return keep(
      fp,
      input.sink,
      CONNECTOR_KEYS[input.dev ? "quickbooks-dev" : "quickbooks"],
      id,
      secret,
    );
  },
});

export const jobberConnectorKeys = defineFlow<ConnectorKeysInput, { kept: string[] }>({
  secret: true,
  site: "jobber",
  name: "connector-keys",
  async run(fp, input) {
    await fp.open(input.url);
    // The value inputs carry floating labels and generated ids: read the one after each label.
    const after = (label: string) =>
      fp.page
        .evaluate((l) => {
          const lab = [...document.querySelectorAll("label")].find(
            (x) => x.textContent?.trim().toLowerCase() === l,
          );
          const box =
            (lab?.htmlFor ? document.getElementById(lab.htmlFor) : null) ??
            lab?.parentElement?.querySelector("input,textarea");
          return box?.value ?? "";
        }, label.toLowerCase())
        .catch(() => "");
    let id = "";
    let secret = "";
    for (let i = 0; i < 10 && !(id && secret); i++) {
      await fp.wait(1_000);
      id = await after("Client ID");
      secret = await after("Client secret");
    }
    return keep(fp, input.sink, CONNECTOR_KEYS.jobber, id, secret);
  },
});
