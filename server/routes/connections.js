const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');
const { isHosted } = require('../config');
const { validateBaseUrl } = require('../lib/urlGuard');

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// On the hosted site, skipping TLS verification would send Helix credentials
// over an unverified connection from a shared server — refuse it there. (The
// desktop app is the right tool for self-signed/dev instances.)
function rejectInsecureTlsWhenHosted(ignoreSSL) {
  if (isHosted() && ignoreSSL === true) {
    const err = new Error('"Ignore SSL errors" is not allowed on the hosted site — use the desktop app for self-signed instances');
    err.status = 400;
    throw err;
  }
}

// GET /api/connections
router.get('/', async (req, res) => {
  res.json(await store.getAll(req.user.uid));
});

// POST /api/connections
router.post('/', async (req, res) => {
  const { name, baseUrl, username, password, authString, ignoreSSL } = req.body;
  if (![name, baseUrl, username, password].every(isNonEmptyString)) {
    return res.status(400).json({ error: 'name, baseUrl, username, and password are required' });
  }
  rejectInsecureTlsWhenHosted(ignoreSSL);
  const conn = await store.create(req.user.uid, {
    name: name.trim(),
    baseUrl: validateBaseUrl(baseUrl, { hosted: isHosted() }),
    username,
    password,
    authString: typeof authString === 'string' ? authString : '',
    ignoreSSL: ignoreSSL === true
  });
  res.status(201).json(conn);
});

// PUT /api/connections/:id
router.put('/:id', async (req, res) => {
  const updates = { ...req.body };
  rejectInsecureTlsWhenHosted(updates.ignoreSSL);
  if (updates.baseUrl !== undefined) {
    updates.baseUrl = validateBaseUrl(updates.baseUrl, { hosted: isHosted() });
  }
  const conn = await store.update(req.user.uid, req.params.id, updates);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(conn);
});

// DELETE /api/connections/:id
router.delete('/:id', async (req, res) => {
  helix.clearToken(req.params.id);
  await store.delete(req.user.uid, req.params.id);
  res.status(204).send();
});

// POST /api/connections/:id/test  — authenticate and validate
router.post('/:id/test', async (req, res) => {
  const conn = await store.getById(req.user.uid, req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  helix.clearToken(conn.id); // force fresh login
  const result = await helix.testConnection(conn);
  res.json(result);
});

module.exports = router;
