import { loadEnvFile, loadSettings } from "../src/app/config.js";
import { credentialsFor } from "../src/app/services.js";
loadEnvFile();
const creds = credentialsFor(loadSettings(), { armed: false });
const from = await creds.get("google-admin");
if (!from) throw new Error("no google-admin credential");
await creds.put("google@wren", from);
console.log("copied to google@wren");
