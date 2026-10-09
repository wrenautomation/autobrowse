/**
 * In a Google Cloud project: enable an API, configure the OAuth consent screen (external, testing), create a Web OAuth client with a loopback redirect and keep its id and secret, add the account as a test user.
 * Compiled from the recording "google-cloud-oauth-client". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  type SecretSink,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  project: z.string().min(1).describe("Google Cloud project id"), // e.g. "wren-509223"
  api: z.string().min(1).describe("API to enable (service name)"), // e.g. "youtube.googleapis.com"
  appName: z.string().min(1).describe("App name on the consent screen"), // e.g. "Wren Automation"
  email: z.string().min(1).describe("The account's email (support contact and test user)"), // e.g. "jinwilliam.jin@gmail.com"
  clientName: z.string().min(1).describe("OAuth client name"), // e.g. "autobrowse"
  redirectUri: z.string().min(1).describe("Authorized redirect URI"), // e.g. "http://127.0.0.1:9400/oauth/callback"
  idEnv: z.string().default("GOOGLE_OAUTH_CLIENT_ID").describe("Env name the client id is kept as"),
  secretEnv: z
    .string()
    .default("GOOGLE_OAUTH_CLIENT_SECRET")
    .describe("Env name the client secret is kept as"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  sink: SecretSink;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface EnableApiInput {
  api: string;
  project: string;
}

const enableApiFlow = defineFlow<EnableApiInput, void>({
  site: "google",
  name: "enable-api",
  async run(fp, input) {
    await fp.open(
      `https://console.cloud.google.com/apis/library/${encodeURIComponent(input.api)}?project=${encodeURIComponent(input.project)}`,
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "enable this API" },
      { goal: "click enable this API" },
    ); // page.getByRole("button", { name: "enable this API", exact: true })
  },
});

const enableApi: Step<"enable-api"> = {
  name: "enable-api",
  async run({ fx, deps, plan }) {
    await fx.run("browser enable-api", () =>
      deps.browser.run(enableApiFlow, { api: plan.api, project: plan.project }),
    );
    // TODO proof: the API page says Enabled
    return done("Enable the API in the project");
  },
};

export interface ConsentAndClientInput {
  project: string;
  appName: string;
  email: string;
  clientName: string;
  redirectUri: string;
  idEnv: string;
  secretEnv: string;
  sink: SecretSink;
}

const consentAndClientFlow = defineFlow<ConsentAndClientInput, void>({
  site: "google",
  name: "consent-and-client",
  async run(fp, input) {
    await fp.open(
      `https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(input.project)}`,
    );
    await fp.act(
      { kind: "click" },
      { role: "link", name: "Get started" },
      { goal: "click Get started" },
    ); // page.getByRole("link", { name: "Get started", exact: true })
    await fp.act(
      { kind: "fill", value: input.appName },
      { role: "textbox", name: "App name" },
      { goal: "fill App name" },
    ); // page.getByRole("textbox", { name: "App name", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: "User support email" },
      { goal: "click User support email" },
    ); // page.getByRole("combobox", { name: "User support email", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "option" },
      { goal: "pick the account itself as the support email" },
    ); // page.getByRole("option")
    await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "click Next" }); // page.getByRole("button", { name: "Next", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "radio", name: "External" },
      { goal: "click External" },
    ); // page.getByRole("radio", { name: "External", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "click Next" }); // page.getByRole("button", { name: "Next", exact: true })
    await fp.act(
      { kind: "fill", value: input.email },
      { role: "textbox", name: "Text field for emails" },
      { goal: "fill Text field for emails" },
    ); // page.getByRole("textbox", { name: "Text field for emails", exact: true })
    await fp.act(
      { kind: "press", key: "Enter" },
      { role: "textbox", name: "Text field for emails" },
      { goal: "press Enter in Text field for emails" },
    ); // page.getByRole("textbox", { name: "Text field for emails", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "click Next" }); // page.getByRole("button", { name: "Next", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "checkbox", name: "I agree to the Google API Services: User Data Policy" },
      { goal: "click I agree to the Google API Services: User Data Policy" },
    ); // page.getByRole("checkbox", { name: "I agree to the Google API Services: User Data Policy", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Continue" },
      { goal: "click Continue" },
    ); // page.getByRole("button", { name: "Continue", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create" },
      { goal: "click Create", irreversible: true },
    ); // page.getByRole("button", { name: "Create", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "link", name: "Create OAuth client" },
      { goal: "click Create OAuth client", irreversible: true },
    ); // page.getByRole("link", { name: "Create OAuth client", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: "Application type" },
      { goal: "click Application type" },
    ); // page.getByRole("combobox", { name: "Application type", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "option", name: "Web application" },
      { goal: "click Web application" },
    ); // page.getByRole("option", { name: "Web application", exact: true })
    await fp.act(
      { kind: "fill", value: input.clientName },
      { role: "textbox", name: "Name" },
      { goal: "fill Name" },
    ); // page.getByRole("textbox", { name: "Name", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add URI", nth: 1 },
      { goal: "click Add URI" },
    ); // page.getByRole("button", { name: "Add URI", exact: true })
    await fp.act(
      { kind: "fill", value: input.redirectUri },
      { role: "textbox", name: "URIs 1" },
      { goal: "fill URIs 1" },
    ); // page.getByRole("textbox", { name: "URIs 1", exact: true })
    await fp.act(
      { kind: "press", key: "Enter" },
      { role: "button", name: "Create" },
      { goal: "press Enter in Create" },
    ); // page.getByRole("button", { name: "Create", exact: true })
    await input.sink.put(input.idEnv, await fp.read({ css: "mat-dialog-container dd" })); // page.locator("mat-dialog-container dd")
    await input.sink.put(
      input.secretEnv,
      await fp.read({ css: "mat-dialog-container dd", nth: 1 }),
    ); // page.locator("mat-dialog-container dd")
    await fp.act({ kind: "click" }, { role: "button", name: "OK" }, { goal: "click OK" }); // page.getByRole("button", { name: "OK", exact: true })
  },
});

const consentAndClient: Step<"consent-and-client"> = {
  name: "consent-and-client",
  async run({ fx, deps, plan }) {
    await fx.run("browser consent-and-client", () =>
      deps.browser.run(consentAndClientFlow, {
        project: plan.project,
        appName: plan.appName,
        email: plan.email,
        clientName: plan.clientName,
        redirectUri: plan.redirectUri,
        idEnv: plan.idEnv,
        secretEnv: plan.secretEnv,
        sink: deps.sink,
      }),
    );
    // TODO proof: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are in the env store
    return done(
      "Configure the consent screen (external, testing) and create the Web OAuth client; id and secret kept",
    );
  },
};

export interface TestUserInput {
  project: string;
  email: string;
}

const testUserFlow = defineFlow<TestUserInput, void>({
  site: "google",
  name: "test-user",
  async run(fp, input) {
    await fp.open(
      `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(input.project)}`,
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add users" },
      { goal: "click Add users" },
    ); // page.getByRole("button", { name: "Add users", exact: true })
    await fp.act(
      { kind: "fill", value: input.email },
      { role: "textbox", name: "Text field for emails" },
      { goal: "fill Text field for emails" },
    ); // page.getByRole("textbox", { name: "Text field for emails", exact: true })
    await fp.act(
      { kind: "press", key: "Enter" },
      { role: "textbox", name: "Text field for emails" },
      { goal: "press Enter in Text field for emails" },
    ); // page.getByRole("textbox", { name: "Text field for emails", exact: true })
    await fp.act(
      { kind: "press", key: "Enter" },
      { role: "button", name: "Save" },
      { goal: "press Enter in Save" },
    ); // page.getByRole("button", { name: "Save", exact: true })
  },
});

const testUser: Step<"test-user"> = {
  name: "test-user",
  async run({ fx, deps, plan }) {
    await fx.run("browser test-user", () =>
      deps.browser.run(testUserFlow, { project: plan.project, email: plan.email }),
    );
    // TODO proof: the audience page counts 1 test user
    return done("Add the account as a test user so it can consent while the app is in testing");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "google-cloud-oauth-client",
  description:
    "In a Google Cloud project: enable an API, configure the OAuth consent screen (external, testing), create a Web OAuth client with a loopback redirect and keep its id and secret, add the account as a test user",
  plan: planSchema,
  steps: [enableApi, consentAndClient, testUser],
  emptyMemo: () => ({}),
});
