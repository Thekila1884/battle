import { initializeApp } from "@firebase/app";
import { getAuth, signInAnonymously } from "@firebase/auth";
import { getDatabase, onValue, ref } from "@firebase/database";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Object.values(config).every(Boolean);

let database;
let currentUser;

export async function connectFirebase() {
  if (!firebaseConfigured) {
    throw new Error(
      "Falta la configuración de Firebase. Copia .env.example a .env.local y completa los datos de tu proyecto."
    );
  }

  if (!database) {
    const app = initializeApp(config);
    const auth = getAuth(app);
    const credential = await signInAnonymously(auth);
    currentUser = credential.user;
    database = getDatabase(app);
  }

  return { database, user: currentUser };
}

export function waitForDatabase(database, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          "No se pudo conectar con Realtime Database. Verifica que la base esté creada y que VITE_FIREBASE_DATABASE_URL sea la URL exacta de Firebase."
        )
      );
    }, timeoutMs);

    unsubscribe = onValue(
      ref(database, ".info/connected"),
      (snapshot) => {
        if (snapshot.val() !== true) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(`Error conectando con Realtime Database: ${error.message}`));
      }
    );
  });
}
