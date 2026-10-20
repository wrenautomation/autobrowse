/**
 * `@wrenautomation/autobrowse/google`: Google over a service account, with no browser. A pure
 * library: token minting (domain-wide delegation) and the Gmail wire take a `fetch`, a key and
 * a token supplier, add no retry or time limit, and never put a bearer in a URL or an error.
 */
export {
  authedJson,
  delegatedScopes,
  expandHome,
  type FetchLike,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  loadServiceAccountKey,
  POSTMASTER_SCOPE,
  POSTMASTER_TRAFFIC_SCOPE,
  parseServiceAccountKey,
  postmasterToken,
  SCOPES,
  type ServiceAccountKey,
  ServiceAccountKeyError,
  serviceAccountToken,
  signAssertion,
  type TokenOptions,
  TokenRefreshError,
  type TokenSupplier,
} from "./auth.js";
export {
  GMAIL_API,
  GmailApiError,
  GmailClient,
  type GmailClientOptions,
  type GmailMessage,
  type GmailUserClient,
  gmailClient,
  gmailPushTopic,
  type Json,
  messageText,
  mimeMessage,
  rawHeader,
  SEND_AND_READ_SCOPES,
  type WholeMessage,
} from "./gmail.js";
