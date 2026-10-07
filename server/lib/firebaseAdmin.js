// Lazy Firebase Admin init — only loaded in hosted mode, so the desktop app
// never needs the firebase-admin package at all.
//
// Credentials come from three separate env vars rather than one big service
// account JSON: Netlify caps total function env-var size at a few KB, and the
// full JSON eats most of it.
//
// Uses firebase-admin's modular API (v10+); the old `admin.apps` / `admin.auth()`
// namespace no longer exists in v14.

let app;

function getApp() {
  if (app) return app;
  const { initializeApp, getApps, getApp: getExistingApp, cert } = require('firebase-admin/app');

  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')       // key pasted with literal "\n" sequences
    .replace(/^"|"$/g, '');      // …or accidentally wrapped in quotes

  app = getApps().length
    ? getExistingApp()
    : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey
        })
      });
  return app;
}

function getDb() {
  return require('firebase-admin/firestore').getFirestore(getApp());
}

async function verifyIdToken(idToken) {
  return require('firebase-admin/auth').getAuth(getApp()).verifyIdToken(idToken);
}

module.exports = { getApp, getDb, verifyIdToken };
