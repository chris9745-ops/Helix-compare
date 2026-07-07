const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');

// Middleware: resolve connection from header
router.use((req, res, next) => {
  const connId = req.headers['x-connection-id'];
  if (!connId) return res.status(400).json({ error: 'X-Connection-Id header required' });
  const conn = store.getById(connId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  req.helixConn = conn;
  next();
});

// ── Active Links ──────────────────────────────────────────────────────────

router.get('/activelinks', async (req, res) => {
  const data = await helix.getActiveLinkNames(req.helixConn, req.query.form);
  res.json(data);
});

router.get('/activelinks/:name', async (req, res) => {
  const data = await helix.getActiveLink(req.helixConn, req.params.name);
  res.json(data);
});

router.post('/activelinks', async (req, res) => {
  const data = await helix.createActiveLink(req.helixConn, req.body);
  res.status(201).json(data);
});

router.put('/activelinks/:name', async (req, res) => {
  const data = await helix.updateActiveLink(req.helixConn, req.params.name, req.body);
  res.json(data);
});

router.delete('/activelinks/:name', async (req, res) => {
  await helix.deleteActiveLink(req.helixConn, req.params.name);
  res.status(204).send();
});

// ── Filters ───────────────────────────────────────────────────────────────

router.get('/filters', async (req, res) => {
  const data = await helix.getFilterNames(req.helixConn, req.query.form);
  res.json(data);
});

router.get('/filters/:name', async (req, res) => {
  const data = await helix.getFilter(req.helixConn, req.params.name);
  res.json(data);
});

router.post('/filters', async (req, res) => {
  const data = await helix.createFilter(req.helixConn, req.body);
  res.status(201).json(data);
});

router.put('/filters/:name', async (req, res) => {
  const data = await helix.updateFilter(req.helixConn, req.params.name, req.body);
  res.json(data);
});

// ── Escalations ───────────────────────────────────────────────────────────

router.get('/escalations', async (req, res) => {
  const data = await helix.getEscalationNames(req.helixConn);
  res.json(data);
});

router.get('/escalations/:name', async (req, res) => {
  const data = await helix.getEscalation(req.helixConn, req.params.name);
  res.json(data);
});

router.put('/escalations/:name', async (req, res) => {
  const data = await helix.updateEscalation(req.helixConn, req.params.name, req.body);
  res.json(data);
});

// ── Forms / Schema ────────────────────────────────────────────────────────

router.get('/forms', async (req, res) => {
  const data = await helix.getForms(req.helixConn);
  res.json(data);
});

router.get('/forms/:formName', async (req, res) => {
  const data = await helix.getFormSchema(req.helixConn, req.params.formName);
  res.json(data);
});

router.get('/forms/:formName/fields', async (req, res) => {
  const data = await helix.getFormFields(req.helixConn, req.params.formName);
  res.json(data);
});

router.post('/forms/:formName/fields', async (req, res) => {
  const data = await helix.createField(req.helixConn, req.params.formName, req.body);
  res.status(201).json(data);
});

router.put('/forms/:formName/fields/:fieldId', async (req, res) => {
  const data = await helix.updateField(req.helixConn, req.params.formName, req.params.fieldId, req.body);
  res.json(data);
});

// ── Menus ─────────────────────────────────────────────────────────────────

router.get('/menus', async (req, res) => {
  const data = await helix.getMenus(req.helixConn);
  res.json(data);
});

router.get('/menus/:menuName', async (req, res) => {
  const data = await helix.getMenu(req.helixConn, req.params.menuName);
  res.json(data);
});

module.exports = router;

// ── Diagnostic: probe which internal admin forms exist on this instance ────
router.get('/diagnostic', async (req, res) => {
  const conn = req.helixConn;
  const token = await require('../lib/helixClient').testConnection(conn).then(r => r.token);

  const formsToProbe = [
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
      results[form] = { status: e.response?.status || e.code, error: e.response?.data?.messageText || e.message };
    }
  }

  res.json({ results });
});
