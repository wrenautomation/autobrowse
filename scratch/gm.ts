import { loadEnvFile, loadSettings } from "../src/app/config.js";
import { loadServiceAccountKey, serviceAccountToken } from "../src/google-auth.js";
loadEnvFile();
const s = loadSettings();
const key = loadServiceAccountKey(s.googleServiceAccount as string);
const token = await serviceAccountToken(key, {
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  subject: "william@wrenautomation.com",
})();
const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { authorization: `Bearer ${token}` },
});
console.log("gmail delegation:", r.status);
