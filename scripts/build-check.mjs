// The built package as a consumer sees it: every subpath in `exports` imports and names what it should.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expect = {
  ".": ["defineFlow", "flowRunner"],
  "./sites": ["SITES", "siteFacade", "sitesFor", "runConsent", "accessTokens"],
  "./auth": ["SITE_LOGINS", "signInContext", "signInToGoogle"],
  "./do": ["doer", "doerFor", "TOOLS", "filePicks"],
  "./agent": ["digest", "exploreWithAgent", "agentSessions"],
  "./flows": ["consentFlow", "googleOauthConsent"],
  "./llm": ["makeLlm", "fakeLlm"],
};
let bad = 0;
for (const [sub, names] of Object.entries(expect)) {
  const entry = pkg.exports[sub]?.import;
  if (!entry) {
    console.error(`${sub}: not in exports`);
    bad++;
    continue;
  }
  const mod = await import(pathToFileURL(new URL(`../${entry}`, import.meta.url).pathname).href);
  for (const n of names)
    if (!(n in mod)) {
      console.error(`${sub}: no export ${n}`);
      bad++;
    }
}
console.log(
  bad ? `build check: ${bad} problem(s)` : `build check: ${Object.keys(expect).length} entries ok`,
);
process.exit(bad ? 1 : 0);
