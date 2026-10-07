const axios = require('axios');
const http = require('http');
const https = require('https');

// In-memory token cache: { connectionId -> { token, expiresAt } }
const tokenCache = new Map();

// Connection reuse (keep-alive) is OFF on purpose. On serverless hosts such as
// Netlify the process is frozen between requests, so a pooled socket is often
// already closed by the server when the function wakes up, and the next call fails
// with "read ECONNRESET". A fresh connection per call costs a little latency and
// removes that whole failure mode.
const httpAgent = new http.Agent({ keepAlive: false });
const strictHttpsAgent = new https.Agent({ keepAlive: false });
const lenientHttpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

function agentsFor(connection) {
  return { httpAgent, httpsAgent: connection.ignoreSSL ? lenientHttpsAgent : strictHttpsAgent };
}

// A reset/broken pipe means the request may never have been processed, and our
// Helix calls (reads and logins) are safe to repeat, so retry once on a fresh
// connection. One retry only: a second failure is reported, not hidden.
const RETRYABLE = new Set(['ECONNRESET', 'EPIPE']);

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!RETRYABLE.has(err.code)) throw err;
    return fn();
  }
}

function makeClient(connection, contentType = 'application/json') {
  return axios.create({
    baseURL: connection.baseUrl,
    ...agentsFor(connection),
    timeout: 30000,
    headers: { 'Content-Type': contentType }
  });
}

async function getToken(connection) {
  const cached = tokenCache.get(connection.id);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const agents = agentsFor(connection);

  const params = new URLSearchParams();
  params.append('username', connection.username);
  params.append('password', connection.password);
  if (connection.authString) params.append('authString', connection.authString);

  let token;
  let refreshToken;

  try {
    const res = await withRetry(() => axios.post(
      `${connection.baseUrl}/api/jwt/login`,
      params.toString(),
      {
        ...agents,
        timeout: 30000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'text'
      }
    ));

    token = typeof res.data === 'string' ? res.data.trim() : null;

    if (!token || token.startsWith('{')) {
      try {
        const parsed = JSON.parse(res.data);
        token = parsed.token || parsed.access_token || parsed.jwtToken;
        refreshToken = parsed.refreshToken || parsed.refresh_token;
      } catch { /* plain string token */ }
    }

    if (!token) throw new Error('Empty token in login response');

  } catch (err) {
    if (err.response?.status === 415 || err.response?.status === 404) {
      const res2 = await withRetry(() => axios.post(
        `${connection.baseUrl}/api/rx/authentication/loginrequest`,
        { userName: connection.username, password: connection.password, locale: 'en-us' },
        {
          ...agents,
          timeout: 30000,
          headers: { 'Content-Type': 'application/json', 'X-Requested-By': 'XMLHttpRequest' },
          responseType: 'text'
        }
      ));
      token = typeof res2.data === 'string' ? res2.data.trim() : null;
      if (!token) throw new Error('No token from Innovation Suite auth endpoint');
    } else {
      throw err;
    }
  }

  tokenCache.set(connection.id, {
    token,
    refreshToken: refreshToken || null,
    expiresAt: Date.now() + 55 * 60 * 1000
  });

  return token;
}

async function helixGet(connection, path, params = {}) {
  const token = await getToken(connection);
  const client = makeClient(connection);
  const res = await withRetry(() => client.get(path, {
    headers: { Authorization: `AR-JWT ${token}` },
    params
  }));
  return res.data;
}

async function helixPost(connection, path, body) {
  const token = await getToken(connection);
  const client = makeClient(connection);
  const res = await client.post(path, body, {
    headers: { Authorization: `AR-JWT ${token}` }
  });
  return res.data;
}

async function helixPut(connection, path, body) {
  const token = await getToken(connection);
  const client = makeClient(connection);
  const res = await client.put(path, body, {
    headers: { Authorization: `AR-JWT ${token}` }
  });
  return res.data;
}

async function helixDelete(connection, path) {
  const token = await getToken(connection);
  const client = makeClient(connection);
  const res = await client.delete(path, {
    headers: { Authorization: `AR-JWT ${token}` }
  });
  return res.data;
}

function clearToken(connectionId) {
  tokenCache.delete(connectionId);
}

// ── Entry API query helper ─────────────────────────────────────────────────
// All workflow objects are queried via /api/arsys/v1/entry/<InternalForm>
async function queryEntries(connection, formName, { q, fields, limit = 100, offset = 0 } = {}) {
  const params = { limit, offset };
  if (q) params.q = q;
  if (fields) params.fields = fields;
  return helixGet(connection, `/api/arsys/v1/entry/${encodeURIComponent(formName)}`, params);
}

// ── Test connection ────────────────────────────────────────────────────────
async function testConnection(connection) {
  const token = await getToken(connection);
  return { success: true, token: token.substring(0, 20) + '...' };
}

// ── Fields ─────────────────────────────────────────────────────────────────
async function getFormFields(connection, formName) {
  // Documented platform REST API resource: "field on a form" — GET /fields/{formName}
  return helixGet(connection, `/api/arsys/v1/fields/${encodeURIComponent(formName)}`);
}

// ── Menus ──────────────────────────────────────────────────────────────────
// Documented platform REST API resource: "menu on a form" — there is no
// bulk-list endpoint, only lookup by known menu name.
async function getMenu(connection, menuName) {
  return helixGet(connection, `/api/arsys/v1/menu/${encodeURIComponent(menuName)}`);
}

module.exports = {
  testConnection,
  clearToken,
  queryEntries,
  getFormFields,
  getMenu
};
