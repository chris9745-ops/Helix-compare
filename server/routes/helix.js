const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');

// Middleware: resolve the caller's connection from the header. Looked up under
// the signed-in user (req.user), so one user can't use another's connection.
router.use(async (req, res, next) => {
  const connId = req.headers['x-connection-id'];
  if (!connId) return res.status(400).json({ error: 'X-Connection-Id header required' });
  const conn = await store.getById(req.user.uid, connId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  req.helixConn = conn;
  next();
});

// ── Form fields ───────────────────────────────────────────────────────────
// Only lookup-by-form-name exists in BMC's REST API (no "list all forms").

router.get('/forms/:formName/fields', async (req, res) => {
  const data = await helix.getFormFields(req.helixConn, req.params.formName);
  res.json(data);
});

// ── Menus ─────────────────────────────────────────────────────────────────
// No bulk-list endpoint exists in BMC's platform REST API — lookup by known
// menu name only.

router.get('/menus/:menuName', async (req, res) => {
  const data = await helix.getMenu(req.helixConn, req.params.menuName);
  res.json(data);
});

// ── Companies ─────────────────────────────────────────────────────────────
// Used to populate the Company dropdown on the Compare page.
router.get('/companies', async (req, res) => {
  const data = await helix.queryEntries(req.helixConn, 'CTM:Company', {
    fields: 'values(Company Name)',
    limit: 1000
  });
  const items = (data.entries || data || [])
    .map(e => e.values?.['Company Name'])
    .filter(Boolean)
    .sort();
  res.json({ items });
});

module.exports = router;

// ── Diagnostic: probe which internal admin forms exist on this instance ────
router.get('/diagnostic', async (req, res) => {
  const conn = req.helixConn;
  const token = await require('../lib/helixClient').testConnection(conn).then(r => r.token);

  // A custom comma-separated ?forms= list replaces the default probe set —
  // lets you test candidate form names (e.g. for SRM catalog or DWP admin
  // config forms) without needing a code change first.
  const customForms = req.query.forms
    ? req.query.forms.split(',').map(f => f.trim()).filter(Boolean)
    : null;

  const formsToProbe = customForms || [
    // Sanity check — these should exist on virtually every ITSM instance.
    // If these 404 too, the /api/arsys/v1/entry path isn't routing
    // correctly on this environment (not a form-naming problem).
    'HPD:Help Desk', 'CTM:People', 'CTM:Support Group',
    // Workflow objects — different names across versions
    'ARActiveLink', 'AR Active Link', 'Active Link',
    'ARFilter', 'AR Filter',
    'AREscalation', 'AR Escalation',
    'ARCharMenu', 'AR Char Menu',
    'ARSchema', 'AR Schema',
    'ARField', 'AR Field',
    // Some versions prefix with numbers
    'AR System Active Links',
  ];

  const https = require('https');
  const axios = require('axios');
  const agent = conn.ignoreSSL ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  // Get fresh token
  const cachedToken = require('../lib/helixClient');
  const tkn = (await cachedToken.testConnection(conn)).token.replace('...', '');

  // Re-auth to get full token
  const params = new URLSearchParams();
  params.append('username', conn.username);
  params.append('password', conn.password);
  if (conn.authString) params.append('authString', conn.authString);

  const loginRes = await axios.post(`${conn.baseUrl}/api/jwt/login`, params.toString(), {
    httpsAgent: agent, timeout: 15000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    responseType: 'text'
  });
  const fullToken = loginRes.data.trim();

  const results = {};
  for (const form of formsToProbe) {
    try {
      const r = await axios.get(
        `${conn.baseUrl}/api/arsys/v1/entry/${encodeURIComponent(form)}`,
        {
          httpsAgent: agent, timeout: 8000,
          headers: { Authorization: `AR-JWT ${fullToken}` },
          params: { limit: 1 }
        }
      );
      results[form] = { status: r.status, count: r.data?.entries?.length ?? '?' };
    } catch (e) {
      const raw = typeof e.response?.data === 'string'
        ? e.response.data.slice(0, 300)
        : e.response?.data;
      results[form] = {
        status: e.response?.status || e.code,
        error: e.response?.data?.messageText || e.message,
        contentType: e.response?.headers?.['content-type'],
        raw
      };
    }
  }

  res.json({ results });
});
