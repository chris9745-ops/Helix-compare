// Runtime mode.
//   local  (default) — desktop app / `npm run dev`: single user, no login,
//                      connections in a local JSON file.
//   hosted           — Netlify: Firebase sign-in required (email allowlist),
//                      per-user connections in Firestore, passwords encrypted.
//
// Everything reads process.env lazily so tests can flip modes, and hosted mode
// fails closed: if anything it needs is missing, requests are refused rather
// than quietly falling back to open/unencrypted behaviour.

function isHosted() {
  return process.env.HELIX_MODE === 'hosted';
}

const HOSTED_REQUIRED_ENV = [
  'ALLOWED_EMAILS',
  'CREDENTIAL_ENC_KEY',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY'
];

function hostedConfigProblems() {
  return HOSTED_REQUIRED_ENV.filter(name => !(process.env[name] || '').trim());
}

// ALLOWED_EMAILS: comma/space/semicolon separated. An entry starting with "@"
// allows a whole domain (e.g. "@yourcompany.com") — only use that for a domain
// you control, never a public one like @gmail.com.
function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(/[\s,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email, list = allowedEmails()) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  return list.some(entry => (entry.startsWith('@') ? e.endsWith(entry) : e === entry));
}

module.exports = { isHosted, hostedConfigProblems, allowedEmails, isEmailAllowed, HOSTED_REQUIRED_ENV };
