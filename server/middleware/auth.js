// Identifies the caller and sets req.user = { uid, email }.
//
// local mode : no login — a fixed single user (desktop app / dev).
// hosted mode: requires a Firebase ID token (Authorization: Bearer <token>),
//              and the verified email must be on the ALLOWED_EMAILS list.
//              Fails closed if hosted config is incomplete.

const { isHosted, hostedConfigProblems, isEmailAllowed } = require('../config');

// Turn a token-verification failure into the right HTTP response. Only genuine
// token problems may say "sign in again"; deploy/config/runtime problems must say
// so, otherwise people loop re-signing-in against a broken server.
function classifyVerifyError(err) {
  const code = err && err.code;
  const message = String((err && err.message) || '');

  if (code === 'auth/id-token-expired') {
    return { status: 401, code: 'unauthenticated', error: 'Your session expired — sign in again' };
  }
  // Token was issued by a different Firebase project than the server is set up for
  if (/incorrect "(aud|iss)"/.test(message)) {
    return {
      status: 500,
      code: 'misconfigured',
      error: 'Sign-in project mismatch: FIREBASE_PROJECT_ID on the server does not match the Firebase project in the site\'s web config (VITE_FIREBASE_PROJECT_ID). Fix the variable and redeploy.'
    };
  }
  // Other Firebase *token* errors (garbage, bad signature, revoked…) — the user can fix by signing in again.
  // auth/internal-error means the SDK couldn't do its job (e.g. couldn't fetch Google's signing keys): a server problem.
  if (typeof code === 'string' && code.startsWith('auth/') && code !== 'auth/internal-error') {
    return { status: 401, code: 'unauthenticated', error: "Couldn't verify your sign-in — sign in again" };
  }
  return {
    status: 500,
    code: 'verification_unavailable',
    error: 'The server could not verify your sign-in (server error) — check the Netlify function logs'
  };
}

function createAuthMiddleware({ verifyIdToken } = {}) {
  return async function authenticate(req, res, next) {
    if (!isHosted()) {
      req.user = { uid: 'local', email: null };
      return next();
    }

    const problems = hostedConfigProblems();
    if (problems.length) {
      console.error('[auth] hosted mode is missing env vars:', problems.join(', '));
      return res.status(500).json({
        error: 'The hosted site is not fully configured yet',
        missing: problems
      });
    }

    const match = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Sign in required', code: 'unauthenticated' });
    }

    // Initialise Firebase outside the token try/catch: a bad service-account key
    // is a deploy problem, and must not masquerade as "your session expired"
    // (which would send people in circles re-signing-in).
    if (!verifyIdToken) {
      try {
        require('../lib/firebaseAdmin').getApp();
      } catch (err) {
        console.error('[auth] Firebase Admin failed to initialise:', err.message);
        return res.status(500).json({
          error: 'The server could not initialise Firebase — check the FIREBASE_* environment variables (especially FIREBASE_PRIVATE_KEY)',
          code: 'misconfigured'
        });
      }
    }

    const verify = verifyIdToken || require('../lib/firebaseAdmin').verifyIdToken;
    let decoded;
    try {
      decoded = await verify(match[1]);
    } catch (err) {
      console.error('[auth] token verification failed:', err && err.code, '-', err && err.message);
      const { status, ...body } = classifyVerifyError(err);
      return res.status(status).json(body);
    }

    if (!decoded.email_verified || !isEmailAllowed(decoded.email)) {
      return res.status(403).json({
        error: `${decoded.email || 'This account'} is not authorized to use this tool`,
        code: 'not_allowed'
      });
    }

    req.user = { uid: decoded.uid, email: String(decoded.email).toLowerCase() };
    next();
  };
}

module.exports = { createAuthMiddleware, classifyVerifyError };
