export {
  type CheckRow,
  checkSite,
  matchPath,
  type RouteRow,
  type SetupRow,
  type SiteFacade,
  type SiteFacadeDeps,
  type SiteRow,
  siteFacade,
} from "./facade.js";
export { gmail, gmailOAuth } from "./gmail.js";
export { instagram } from "./instagram.js";
export { langfuse } from "./langfuse.js";
export { linkedin } from "./linkedin.js";
export { meta, metaOAuth } from "./meta.js";
export { createRegistryUser, NPM_TOKEN, npm } from "./npm.js";
export { accessTokens, accountEnv, runConsent } from "./oauth.js";
export { outlook } from "./outlook.js";
export { SITES_SERVICE, type SitesService, sitesService } from "./service.js";
export { tiktok } from "./tiktok.js";
export * from "./types.js";
export { profileOf, type SiteParts, sitesFor } from "./wire.js";
export { x, xOAuth } from "./x.js";
export { youtube } from "./youtube.js";

import { gmail } from "./gmail.js";
import { instagram } from "./instagram.js";
import { langfuse } from "./langfuse.js";
import { linkedin } from "./linkedin.js";
import { meta } from "./meta.js";
import { npm } from "./npm.js";
import { outlook } from "./outlook.js";
import { tiktok } from "./tiktok.js";
import type { SiteApi } from "./types.js";
import { x } from "./x.js";
import { youtube } from "./youtube.js";

/** Every site autobrowse serves under its official API's shape. */
export const SITES: readonly SiteApi[] = [
  linkedin,
  youtube,
  instagram,
  tiktok,
  outlook,
  gmail,
  langfuse,
  meta,
  x,
  npm,
];
