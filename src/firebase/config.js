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

const firebaseConfig = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    ...(env.VITE_FIREBASE_MEASUREMENT_ID?.trim()
        ? { measurementId: env.VITE_FIREBASE_MEASUREMENT_ID.trim() }
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