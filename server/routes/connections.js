const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');
const { isHosted } = require('../config');
const { validateBaseUrl } = require('../lib/urlGuard');
const { parseFormList, serializeFormList, deserializeFormList } = require('../lib/formList');

// Firestore documents are capped at 1 MB; stay well under it.
const MAX_FORM_LIST_BYTES = 800 * 1024;

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

// ── Imported form list (from the Mid-Tier "AR System Object List") ──────────
// BMC's REST API can't list a server's forms, so the user pastes the table once
// per environment and we keep it with the connection for typeahead.

async function requireConnection(req) {
  const conn = await store.getById(req.user.uid, req.params.id);
  if (!conn) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }
}

router.get('/:id/forms', async (req, res) => {
  await requireConnection(req);
  const saved = await store.getFormList(req.user.uid, req.params.id);
  res.json({
    forms: saved ? deserializeFormList(saved.text) : [],
    importedAt: saved ? saved.importedAt : null
  });
});

router.put('/:id/forms', async (req, res) => {
  await requireConnection(req);
  const { forms, skipped } = parseFormList(req.body && req.body.text);
  if (!forms.length) {
    return res.status(400).json({
      error: 'No form names found in the pasted text. Copy the Name column (or the whole table) from the Mid-Tier object list.'
    });
  }
  const text = serializeFormList(forms);
  if (Buffer.byteLength(text) > MAX_FORM_LIST_BYTES) {
    return res.status(413).json({ error: 'That form list is too large to store' });
  }
  const importedAt = new Date().toISOString();
  await store.setFormList(req.user.uid, req.params.id, { text, importedAt });
  res.json({ count: forms.length, skipped, importedAt });
});

router.delete('/:id/forms', async (req, res) => {
  await requireConnection(req);
  await store.deleteFormList(req.user.uid, req.params.id);
  res.status(204).send();
});

module.exports = router;
