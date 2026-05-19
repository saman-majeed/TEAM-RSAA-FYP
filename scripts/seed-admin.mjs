/**
 * Creates / updates the Firestore admin document this app expects:
 * Collection: admins
 * Document ID: must match the username typed at login (default: admin@gmail.com)
 * Fields: role "admin", password in field "admin" or "password"
 *
 * Requires a service account JSON (Firebase Console → Project settings → Service accounts → Generate new private key).
 * Save as serviceAccountKey.json in the project root (gitignored) or set GOOGLE_APPLICATION_CREDENTIALS to its path.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || "";
if (!projectId) {
  try {
    const rc = JSON.parse(readFileSync(join(root, ".firebaserc"), "utf8"));
    projectId = rc?.projects?.default || "";
  } catch {
    /* ignore */
  }
}
if (!projectId) projectId = "team-fyp-41054";

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(root, "serviceAccountKey.json");
const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@gmail.com").trim();
const adminPassword =
  process.env.SEED_ADMIN_PASSWORD?.trim() ||
  process.argv[2]?.trim() ||
  randomBytes(9).toString("base64url");

if (!existsSync(credPath)) {
  console.error("\nMissing service account JSON.\n");
  console.error(`1) Open: https://console.firebase.google.com/project/${projectId}/settings/serviceaccounts/adminsdk`);
  console.error("2) Click “Generate new private key” and download the JSON file.");
  console.error(`3) Save it as: ${credPath}`);
  console.error("   (or set GOOGLE_APPLICATION_CREDENTIALS to the full path of that file)\n");
  console.error("Then run: npm run seed:admin\n");
  process.exit(1);
}

if (!getApps().length) {
  const cred = JSON.parse(readFileSync(credPath, "utf8"));
  initializeApp({ credential: cert(cred) });
}

const db = getFirestore();
await db.collection("admins").doc(adminEmail).set(
  {
    role: "admin",
    admin: adminPassword,
    email: adminEmail,
  },
  { merge: true },
);

console.log("\nAdmin document ready.");
console.log(`  Firestore path: admins/${adminEmail}`);
console.log(`  Sign-in username: ${adminEmail}`);
console.log(`  Password: ${adminPassword}`);
console.log("\nIf you did not set SEED_ADMIN_PASSWORD, copy the password above — it was generated for you.\n");
