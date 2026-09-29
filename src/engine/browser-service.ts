/**
 * The browser legs as one Restate service, for an orchestrator that owns
 * the API steps (wren): `browser/dkimGenerate`,
 * `browser/dkimStart`, `browser/workspaceLogo`, and
 * `browser/flow` for any compiled flow by name. Each call is one journaled
 * effect; a person needed or a broken flow is a terminal error with the
 * artifacts in its message, the same codes the run objects use. The
 * runner's per-site lock keeps two calls off one profile.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { withCall } from "../browser/attempt.js";
import { type BrowserFlow, FlowFailed, type FlowRunner } from "../browser/flow.js";
import { calcomApiKey } from "../browser/flows/calcom-api-key.js";
import { facebookOauthConsent } from "../browser/flows/facebook-oauth-consent.js";
import { googleDkimGenerate, googleDkimStart } from "../browser/flows/google-dkim.js";
import { googleProfilePhoto } from "../browser/flows/google-profile-photo.js";
import { googleWorkspaceLogo } from "../browser/flows/google-workspace-logo.js";
import { instagramCreatePost } from "../browser/flows/instagram-create-post.js";
import { instagramOauthConsent } from "../browser/flows/instagram-oauth-consent.js";
import { linkedinCreatePost } from "../browser/flows/linkedin-create-post.js";
import { linkedinOauthConsent } from "../browser/flows/linkedin-oauth-consent.js";
import {
  linkedinCompany,
  linkedinCompanyJobs,
  linkedinCompanyPeople,
  linkedinConnect,
  linkedinMessage,
  linkedinProfile,
  linkedinSearchPeople,
} from "../browser/flows/linkedin-reach.js";
import { npmGranularToken } from "../browser/flows/npm-granular-token.js";
import { npmTrustedPublisher } from "../browser/flows/npm-trusted-publisher.js";
import { googleOauthConsent } from "../browser/flows/oauth-consent.js";
import { outlookOauthConsent } from "../browser/flows/outlook-oauth-consent.js";
import { resetMailProbe } from "../browser/flows/reset-mail-probe.js";
import { tiktokOauthConsent } from "../browser/flows/tiktok-oauth-consent.js";
import { xOauthConsent } from "../browser/flows/x-oauth-consent.js";
import { youtubeCommunityPost } from "../browser/flows/youtube-community-post.js";
import { NeedsHuman } from "../browser/session.js";

export const BROWSER_SERVICE = "browser";
export const BROWSER_CODE = { needsHuman: 460, failed: 461 } as const;

const RETRY = {
  maxRetryAttempts: 300,
  initialRetryInterval: 1_000,
  retryIntervalFactor: 2,
  maxRetryInterval: 300_000,
};

const domain = z.object({ domain: z.string().min(3) });
const file = z.object({ file: z.string().min(1) });
const named = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]+(\/[a-z][a-z0-9-]+)?$/),
  input: z.unknown(),
});

/** What `flow({name, input})` can run; the fixed handlers are sugar over these. */
export type FlowCatalog = Record<string, BrowserFlow<never, unknown>>;

/** The hand-written legs by `site/name`; more join through `catalog`. */
export const BROWSER_FLOWS: FlowCatalog = Object.fromEntries(
  [
    googleDkimGenerate,
    googleDkimStart,
    googleWorkspaceLogo,
    googleProfilePhoto,
    googleOauthConsent,
    linkedinOauthConsent,
    instagramOauthConsent,
    instagramCreatePost,
    linkedinCreatePost,
    linkedinSearchPeople,
    linkedinProfile,
    linkedinCompany,
    linkedinCompanyJobs,
    linkedinCompanyPeople,
    linkedinConnect,
    linkedinMessage,
    resetMailProbe,
    npmGranularToken,
    npmTrustedPublisher,
    calcomApiKey,
    facebookOauthConsent,
    tiktokOauthConsent,
    xOauthConsent,
    outlookOauthConsent,
    youtubeCommunityPost,
  ].map((f) => [`${f.site}/${f.name}`, f as BrowserFlow<never, unknown>]),
);

export interface BrowserServiceDeps {
  runner: FlowRunner;
  /** Extra flows callable through `flow({name, input})`, on top of BROWSER_FLOWS. */
  catalog?: FlowCatalog;
}

/** Terminal for what a retry would not fix; everything else (network, browser) retries under RETRY. */
export async function runLeg<I, O>(
  runner: FlowRunner,
  flow: BrowserFlow<I, O>,
  input: I,
): Promise<O> {
  try {
    return await runner.run(flow, input);
  } catch (err) {
    if (err instanceof NeedsHuman)
      throw new restate.TerminalError(
        JSON.stringify({ reason: err.message, artifacts: err.artifacts }),
        { errorCode: BROWSER_CODE.needsHuman },
      );
    if (err instanceof FlowFailed)
      throw new restate.TerminalError(
        JSON.stringify({ reason: err.message, artifacts: err.artifacts }),
        { errorCode: BROWSER_CODE.failed },
      );
    throw err;
  }
}

export function browserService(deps: BrowserServiceDeps) {
  const leg =
    <I, O>(flow: BrowserFlow<I, O>) =>
    (ctx: restate.Context, input: I): Promise<O> =>
      ctx.run(
        `browser ${flow.site}/${flow.name}`,
        () =>
          withCall(`${ctx.request().id} ${flow.site}/${flow.name}`, () =>
            runLeg(deps.runner, flow, input),
          ),
        RETRY,
      );
  return restate.service({
    name: BROWSER_SERVICE,
    handlers: {
      dkimGenerate: (ctx: restate.Context, raw: unknown) =>
        leg(googleDkimGenerate)(ctx, domain.parse(raw)),
      dkimStart: (ctx: restate.Context, raw: unknown) =>
        leg(googleDkimStart)(ctx, domain.parse(raw)),
      workspaceLogo: (ctx: restate.Context, raw: unknown) =>
        leg(googleWorkspaceLogo)(ctx, file.parse(raw)),
      /** Any flow in the catalog by name; the input is the flow's own. */
      flow: async (ctx: restate.Context, raw: unknown) => {
        const { name, input } = named.parse(raw);
        const flow = deps.catalog?.[name] ?? BROWSER_FLOWS[name];
        if (!flow)
          throw new restate.TerminalError(`no browser flow named ${name}`, { errorCode: 404 });
        return leg(flow as BrowserFlow<unknown, unknown>)(ctx, input);
      },
    },
  });
}
export type BrowserService = ReturnType<typeof browserService>;
