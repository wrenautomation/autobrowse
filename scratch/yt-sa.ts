/** Can a delegated service account mint a YouTube token for william@? */
import { loadEnvFile, loadSettings } from "../src/app/config.js";
import { loadServiceAccountKey, serviceAccountToken } from "../src/google-auth.js";

loadEnvFile();
const s = loadSettings();
const key = loadServiceAccountKey(s.googleServiceAccount as string);
const supply = serviceAccountToken(key, {
  scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
  subject: "william@wrenautomation.com",
});
try {
  const token = await supply();
  const r = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await r.json()) as { items?: { id: string; snippet?: { title?: string } }[]; error?: { message?: string } };
  console.log("status", r.status, body.error?.message ?? JSON.stringify(body.items?.map((i) => [i.id, i.snippet?.title])));
} catch (err) {
  console.log("mint failed:", (err as Error).message.slice(0, 300));
}
