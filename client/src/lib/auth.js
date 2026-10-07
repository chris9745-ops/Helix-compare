// Firebase sign-in for the hosted site. Entirely inert in desktop/dev builds:
// AUTH_ENABLED is only true when the build is given VITE_AUTH_MODE=firebase, and
// the Firebase SDK is loaded lazily so local builds never run (or need) it.

export const AUTH_ENABLED = import.meta.env.VITE_AUTH_MODE === 'firebase';

let firebasePromise;

function getFirebase() {
  if (!firebasePromise) {
    firebasePromise = (async () => {
      const [{ initializeApp }, authMod] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth')
      ]);
      const app = initializeApp({
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID
      });
      return { auth: authMod.getAuth(app), authMod };
    })();
  }
  return firebasePromise;
}

// Current user's ID token (auto-refreshed by Firebase), or null if signed out.
export async function getIdToken() {
  if (!AUTH_ENABLED) return null;
  const { auth } = await getFirebase();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}

// Calls cb(user|null) now and on every sign-in/out. Resolves to an unsubscribe fn.
export async function subscribeToAuth(cb) {
  const { auth, authMod } = await getFirebase();
  return authMod.onAuthStateChanged(auth, cb);
}

export async function signInWithGoogle() {
  const { auth, authMod } = await getFirebase();
  return authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider());
}

export async function signOutUser() {
  const { auth, authMod } = await getFirebase();
  return authMod.signOut(auth);
}
