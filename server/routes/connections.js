const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');

// GET /api/connections
router.get('/', (req, res) => {
  res.json(store.getAll());
});

// POST /api/connections
router.post('/', (req, res) => {
  const { name, baseUrl, username, password, ignoreSSL } = req.body;
  if (!name || !baseUrl || !username || !password) {
    return res.status(400).json({ error: 'name, baseUrl, username, and password are required' });
  }
  const conn = store.create({ name, baseUrl, username, password, ignoreSSL });
  res.status(201).json(conn);
});

// PUT /api/connections/:id
router.put('/:id', (req, res) => {
  const conn = store.update(req.params.id, req.body);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(conn);
});

// DELETE /api/connections/:id
router.delete('/:id', (req, res) => {
  helix.clearToken(req.params.id);
  store.delete(req.params.id);
  res.status(204).send();
});

// POST /api/connections/:id/test  — authenticate and validate
router.post('/:id/test', async (req, res) => {
  const conn = store.getById(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  helix.clearToken(conn.id); // force fresh login
  const result = await helix.testConnection(conn);
  res.json(result);
});

module.exports = router;
