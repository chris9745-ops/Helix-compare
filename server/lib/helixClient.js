const axios = require('axios');
const https = require('https');

// In-memory token cache: { connectionId -> { token, expiresAt } }
const tokenCache = new Map();

function makeClient(connection, contentType = 'application/json') {
  const agent = connection.ignoreSSL
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  return axios.create({
    baseURL: connection.baseUrl,
    httpsAgent: agent,
    timeout: 30000,
    headers: { 'Content-Type': contentType }
  });
}

async function getToken(connection) {
  const cached = tokenCache.get(connection.id);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const agent = connection.ignoreSSL
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  const params = new URLSearchParams();
  params.append('username', connection.username);
  params.append('password', connection.password);
  if (connection.authString) params.append('authString', connection.authString);

  let token;
  let refreshToken;

  try {
    const res = await axios.post(
      `${connection.baseUrl}/api/jwt/login`,
      params.toString(),
      {
        httpsAgent: agent,
        timeout: 30000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'text'
      }
    );

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
      const res2 = await axios.post(
        `${connection.baseUrl}/api/rx/authentication/loginrequest`,
        { userName: connection.username, password: connection.password, locale: 'en-us' },
        {
          httpsAgent: agent,
          timeout: 30000,
          headers: { 'Content-Type': 'application/json', 'X-Requested-By': 'XMLHttpRequest' },
          responseType: 'text'
        }
      );
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
  const res = await client.get(path, {
    headers: { Authorization: `AR-JWT ${token}` },
    params
  });
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

// ── Forms / Schema ─────────────────────────────────────────────────────────
async function getForms(connection) {
  // ARSchema is the internal form that lists all forms
  try {
    const fields = 'values(Schema Name,Schema Type,Modified Date)';
    const data = await queryEntries(connection, 'ARSchema', { fields, limit: 500 });
    const items = (data.entries || data).map(e => ({
      name: e.values?.['Schema Name'],
      type: e.values?.['Schema Type'],
      modifiedDate: e.values?.['Modified Date'],
    }));
    return { items };
  } catch (err) {
    // Fallback: try the v1 schema endpoint which works on some versions
    try {
      return await helixGet(connection, '/api/arsys/v1/schema');
    } catch {
      throw err;
    }
  }
}

async function getFormSchema(connection, formName) {
  try {
    return await helixGet(connection, `/api/arsys/v1/schema/${encodeURIComponent(formName)}`);
  } catch (err) {
    throw err;
  }
}

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

// ── Stub write operations (for future implementation) ──────────────────────
async function createField(connection, formName, fieldDef) {
  throw new Error('Creating fields via REST API is not supported in this version.');
}

async function updateField(connection, formName, fieldId, fieldDef) {
  throw new Error('Updating fields via REST API is not supported in this version.');
}

module.exports = {
  testConnection,
  clearToken,
  queryEntries,
  getForms, getFormSchema, getFormFields, createField, updateField,
  getMenu
};
