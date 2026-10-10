/**
 * wren's connector apps (HubSpot, QuickBooks, Jobber): the OAuth clients a
 * business consents to so wren reads its CRM. No API of their own here; each
 * setup step reads one app's client id and secret off its developer console
 * (`connectors keys <app>`), and `connectors prod` hands them to wren.
 */
import { CONNECTOR_KEYS } from "../browser/flows/connector-keys.js";
import type { SetupStep, SiteApi } from "./types.js";

/** The console account each app lives under: `creds` names, the profiles explore made them in. */
export const CONNECTOR_PROFILES = {
  hubspot: "hubspot",
  quickbooks: "intuit@wren",
  "quickbooks-dev": "intuit@wren",
  jobber: "jobber@wren",
} as const;

/** wren's apps, made 2026-10-09; ids only, never a secret. */
const INTUIT_KEYS =
  "https://developer.intuit.com/appdetail/keys?appId=djQuMTo6OGQzYmJlYTI3Yg:6fda6bf2-6601-4e98-a11d-4f2f8e12b224&id=9341458464704922";
export const CONNECTOR_URLS = {
  hubspot:
    "https://app-na3.hubspot.com/developer-projects/343773398/project/wren-connector/component/wren_connector_app",
  quickbooks: INTUIT_KEYS,
  "quickbooks-dev": INTUIT_KEYS,
  jobber: "https://developer.getjobber.com/apps/MTY1MDkw",
} as const;

const step = (app: keyof typeof CONNECTOR_KEYS, flow: string, summary: string): SetupStep => ({
  name: `${app}-keys`,
  makes: CONNECTOR_KEYS[app],
  how: {
    flow,
    input: { url: CONNECTOR_URLS[app], ...(app === "quickbooks-dev" ? { dev: true } : {}) },
  },
  summary,
});

export const connectors: SiteApi = {
  site: "connectors",
  origin: "https://app.wrenautomation.com",
  auth: { open: true },
  routes: [],
  setup: [
    step(
      "hubspot",
      "hubspot/connector-keys",
      "Read the HubSpot project app's client id and secret (Auth tab)",
    ),
    step(
      "quickbooks",
      "intuit/connector-keys",
      "Read the Intuit app's production client id and secret",
    ),
    step(
      "quickbooks-dev",
      "intuit/connector-keys",
      "Read the Intuit app's development (sandbox) keys",
    ),
    step("jobber", "jobber/connector-keys", "Read the Jobber app's client id and secret"),
  ],
};
