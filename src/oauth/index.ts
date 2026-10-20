/**
 * `@wrenautomation/autobrowse/oauth`: the wire of every OAuth sign-in, without a browser. A pure
 * library: it takes a `fetch`, the app's client id and secret, codes and tokens, and returns token
 * JSON or an `OAuthError`. No env names, no files, no listener. Consent driving, the mint cache
 * and revoking live in autobrowse's `src/sites/oauth.ts`; what a token answer means to a product
 * (what to store, which Page to pick) stays with the caller.
 *
 * Two error parsers, on purpose: `tokenPost`/`oauthErrorOf` for mail and connected apps,
 * `platformJson`/`platformErrorOf` for the social platforms.
 */
export { type AppSpec, type AppTokens, appConnectUrl, appExchange, appRefresh } from "./apps.js";
export {
  claimsOf,
  type OAuthApp,
  type OAuthClient,
  OAuthError,
  oauthErrorOf,
  pkceChallenge,
  pkceVerifier,
  randomState,
  revokedCode,
  tokenPost,
} from "./core.js";
export {
  accessOf,
  appInTenant,
  CONSUMER_GOOGLE,
  CONSUMER_MICROSOFT,
  GMAIL_READ,
  GMAIL_SEND,
  GRAPH_READ,
  GRAPH_SEND,
  graphScopes,
  type MailAccess,
  type MailProvider,
  type MailTokens,
  mailConnectUrl,
  mailConsentUrl,
  mailExchange,
  mailRefresh,
  scopesFor,
} from "./mail.js";
export {
  exchangeCode,
  GBP_ACCOUNTS,
  GBP_API,
  GBP_INFO,
  GOOGLE_API,
  GRAPH,
  type Json,
  LINKEDIN_API,
  LINKEDIN_VERSION,
  metaPages,
  metaUserToken,
  platformErrorOf,
  platformJson,
  refreshGrant,
  SOCIAL_PROVIDER,
  type SocialExtra,
  type SocialPlatform,
  TIKTOK_API,
  whoAmI,
  X_API,
} from "./platform.js";
export {
  authorizeEndpoint,
  authorizeUrl,
  MICROSOFT_LOGIN,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type ProviderSpec,
  tenantOf,
  tokenEndpoint,
} from "./providers.js";
