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
import { discordBotToken, discordInvite } from "../browser/flows/discord.js";
import { facebookOauthConsent } from "../browser/flows/facebook-oauth-consent.js";
import { fingerprint } from "../browser/flows/fingerprint.js";
import { googleDkimGenerate, googleDkimStart } from "../browser/flows/google-dkim.js";
import { googleProfilePhoto } from "../browser/flows/google-profile-photo.js";
import { googleSearch } from "../browser/flows/google-search.js";
import { googleWorkspaceLogo } from "../browser/flows/google-workspace-logo.js";
import { instagramCreatePost } from "../browser/flows/instagram-create-post.js";
import { instagramOauthConsent } from "../browser/flows/instagram-oauth-consent.js";
import { linkedinActivity } from "../browser/flows/linkedin-activity.js";
import { linkedinAudience } from "../browser/flows/linkedin-audience.js";
import { linkedinCreatePost } from "../browser/flows/linkedin-create-post.js";
import { linkedinNotifications } from "../browser/flows/linkedin-notifications.js";
import { linkedinOauthConsent } from "../browser/flows/linkedin-oauth-consent.js";
import {
  linkedinCompany,
  linkedinCompanyJobs,
  linkedinCompanyPeople,
  linkedinConnect,
  linkedinConnections,
  linkedinInbox,
  linkedinMessage,
  linkedinProfile,
  linkedinRelationship,
  linkedinSearchPeople,
  linkedinWithdraw,
} from "../browser/flows/linkedin-reach.js";
import { loomDelete, loomRename, loomUpload } from "../browser/flows/loom.js";
import { npmCreateOrg } from "../browser/flows/npm-create-org.js";
import { npmGranularToken } from "../browser/flows/npm-granular-token.js";
import { npmTrustedPublisher } from "../browser/flows/npm-trusted-publisher.js";
import { googleOauthConsent } from "../browser/flows/oauth-consent.js";
import { outlookOauthConsent } from "../browser/flows/outlook-oauth-consent.js";
import { perplexityAsk } from "../browser/flows/perplexity-ask.js";
import { redditComment, redditMessage, redditRead, redditSubmit } from "../browser/flows/reddit.js";
import { resetMailProbe } from "../browser/flows/reset-mail-probe.js";
import { tiktokOauthConsent } from "../browser/flows/tiktok-oauth-consent.js";
import { xOauthConsent } from "../browser/flows/x-oauth-consent.js";
import { xPost, xPosts, xProfile, xSearch } from "../browser/flows/x-read.js";
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
  /** The profile to run in, when not the flow's own site: `x@wren` for an `x/…` flow. */
  profile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*(@[a-z0-9.-]+)?$/)
    .optional(),
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
    googleSearch,
    perplexityAsk,
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
    linkedinInbox,
    linkedinRelationship,
    linkedinConnections,
    linkedinNotifications,
    linkedinActivity,
    linkedinAudience,
    linkedinWithdraw,
    resetMailProbe,
    npmCreateOrg,
    npmGranularToken,
    npmTrustedPublisher,
    calcomApiKey,
    discordBotToken,
    discordInvite,
    facebookOauthConsent,
    tiktokOauthConsent,
    xOauthConsent,
    xPost,
    xPosts,
    xProfile,
    xSearch,
    redditRead,
    redditSubmit,
    redditComment,
    redditMessage,
    loomUpload,
    loomRename,
    loomDelete,
    outlookOauthConsent,
    youtubeCommunityPost,
    fingerprint,
  ].map((f) => [`${f.site}/${f.name}`, f as BrowserFlow<never, unknown>]),
);

export interface BrowserServiceDeps {
  runner: FlowRunner;
  /** Extra flows callable through `flow({name, input})`, on top of BROWSER_FLOWS. */
  catalog?: FlowCatalog;
  /** Walks by `<site>/walk-<name>` (src/walks), read from disk per call so a rebuilt walk runs at once. */
  walks?: (name: string) => BrowserFlow<never, unknown> | null;
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

export function browserService(deps: BrowserServiceDeps, name: string = BROWSER_SERVICE) {
  /** A walk file a hand edit broke is a bad request, not a retry. */
  const walkNamed = (name: string): BrowserFlow<never, unknown> | null => {
    try {
      return deps.walks?.(name) ?? null;
    } catch (err) {
      throw new restate.TerminalError(
        `walk ${name}: ${err instanceof Error ? err.message : String(err)}`,
        { errorCode: 400 },
      );
    }
  };
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
    name,
    handlers: {
      dkimGenerate: (ctx: restate.Context, raw: unknown) =>
        leg(googleDkimGenerate)(ctx, domain.parse(raw)),
      dkimStart: (ctx: restate.Context, raw: unknown) =>
        leg(googleDkimStart)(ctx, domain.parse(raw)),
      workspaceLogo: (ctx: restate.Context, raw: unknown) =>
        leg(googleWorkspaceLogo)(ctx, file.parse(raw)),
      /** Any flow in the catalog by name; the input is the flow's own. */
      flow: async (ctx: restate.Context, raw: unknown) => {
        const { name, input, profile } = named.parse(raw);
        const flow = deps.catalog?.[name] ?? BROWSER_FLOWS[name] ?? walkNamed(name);
        if (!flow)
          throw new restate.TerminalError(`no browser flow named ${name}`, { errorCode: 404 });
        const sited = profile ? { ...flow, site: profile } : flow;
        return leg(sited as BrowserFlow<unknown, unknown>)(ctx, input);
      },
    },
  });
}
export type BrowserService = ReturnType<typeof browserService>;
