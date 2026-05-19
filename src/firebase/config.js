import { initializeApp } from "firebase/app";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

const env = import.meta.env;

/** Trim + strip surrounding quotes — avoids broken config when .env has `KEY= "value"`. */
function envStr(key) {
    const raw = env[key];
    if (raw == null || typeof raw !== "string") return "";
    let s = raw.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
    }
    return s;
}

const firebaseConfig = {
    apiKey: envStr("VITE_FIREBASE_API_KEY"),
    authDomain: envStr("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: envStr("VITE_FIREBASE_PROJECT_ID"),
    storageBucket: envStr("VITE_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: envStr("VITE_FIREBASE_MESSAGING_SENDER_ID"),
    appId: envStr("VITE_FIREBASE_APP_ID"),
    ...(envStr("VITE_FIREBASE_MEASUREMENT_ID")
        ? { measurementId: envStr("VITE_FIREBASE_MEASUREMENT_ID") }
        : {}),
};

const requiredKeys = [
    ["VITE_FIREBASE_API_KEY", firebaseConfig.apiKey],
    ["VITE_FIREBASE_AUTH_DOMAIN", firebaseConfig.authDomain],
    ["VITE_FIREBASE_PROJECT_ID", firebaseConfig.projectId],
    ["VITE_FIREBASE_STORAGE_BUCKET", firebaseConfig.storageBucket],
    ["VITE_FIREBASE_MESSAGING_SENDER_ID", firebaseConfig.messagingSenderId],
    ["VITE_FIREBASE_APP_ID", firebaseConfig.appId],
];

const missing = requiredKeys.filter(([, value]) => !value).map(([key]) => key);

if (missing.length > 0) {
    throw new Error(
        `[Firebase] Missing environment variables: ${missing.join(", ")}. ` +
            `Copy .env.example to .env, add your web app config from the Firebase console, then restart the dev server.`,
    );
}

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
    }),
});
export const auth = getAuth(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
export default app;