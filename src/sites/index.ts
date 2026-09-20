export {
  matchPath,
  type RouteRow,
  type SetupRow,
  type SiteFacade,
  type SiteFacadeDeps,
  type SiteRow,
  siteFacade,
} from "./facade.js";
export { linkedin } from "./linkedin.js";
export { accessTokens, runConsent } from "./oauth.js";
export * from "./types.js";
export { youtube } from "./youtube.js";

import { linkedin } from "./linkedin.js";
import type { SiteApi } from "./types.js";
import { youtube } from "./youtube.js";

/** Every site autobrowse serves under its official API's shape. */
export const SITES: readonly SiteApi[] = [linkedin, youtube];
