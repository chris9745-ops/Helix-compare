// Identifies the caller and sets req.user = { uid, email }.
//
// local mode : no login — a fixed single user (desktop app / dev).
// hosted mode: requires a Firebase ID token (Authorization: Bearer <token>),
//              and the verified email must be on the ALLOWED_EMAILS list.
//              Fails closed if hosted config is incomplete.

const { isHosted, hostedConfigProblems, isEmailAllowed } = require('../config');

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
    } catch {
      return res.status(401).json({ error: 'Your session expired — sign in again', code: 'unauthenticated' });
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

module.exports = { createAuthMiddleware };
