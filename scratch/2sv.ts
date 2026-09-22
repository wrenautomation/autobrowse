/** What Google thinks william@'s second factors are. */
import { loadEnvFile, loadSettings } from "../src/app/config.js";
import { loadServiceAccountKey, serviceAccountToken } from "../src/google-auth.js";

loadEnvFile();
const s = loadSettings();
const key = loadServiceAccountKey(s.googleServiceAccount as string);
const admin = s.googleAdminUser as string;
for (const scope of [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.security",
]) {
  try {
    const token = await serviceAccountToken(key, { scopes: [scope], subject: admin })();
    const r = await fetch(
      "https://admin.googleapis.com/admin/directory/v1/users/william%40wrenautomation.com?projection=full",
      { headers: { authorization: `Bearer ${token}` } },
    );
    const b = (await r.json()) as Record<string, unknown> & { error?: { message?: string } };
    console.log(
      scope.split("/").pop(),
      r.status,
      b.error?.message ??
        JSON.stringify({
          isEnrolledIn2Sv: b.isEnrolledIn2Sv,
          isEnforcedIn2Sv: b.isEnforcedIn2Sv,
          isAdmin: b.isAdmin,
        }),
    );
  } catch (err) {
    console.log(scope.split("/").pop(), "mint failed:", (err as Error).message.slice(0, 160));
  }
}
