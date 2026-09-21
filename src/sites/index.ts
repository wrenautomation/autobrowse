export {
  matchPath,
  type RouteRow,
  type SetupRow,
  type SiteFacade,
  type SiteFacadeDeps,
  type SiteRow,
  siteFacade,
} from "./facade.js";
export { instagram } from "./instagram.js";
export { linkedin } from "./linkedin.js";
export { accessTokens, runConsent } from "./oauth.js";
export { SITES_SERVICE, type SitesService, sitesService } from "./service.js";
export { tiktok } from "./tiktok.js";
export * from "./types.js";
export { type SiteParts, sitesFor } from "./wire.js";
export { youtube } from "./youtube.js";

import { instagram } from "./instagram.js";
import { linkedin } from "./linkedin.js";
import { tiktok } from "./tiktok.js";
import type { SiteApi } from "./types.js";
import { youtube } from "./youtube.js";

/** Every site autobrowse serves under its official API's shape. */
export const SITES: readonly SiteApi[] = [linkedin, youtube, instagram, tiktok];
