const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');
const { diffByKey } = require('../lib/diff');

function resolveConn(id, label) {
  if (!id) {
    const err = new Error(`${label} connection id is required`);
    err.status = 400;
    throw err;
  }
  const conn = store.getById(id);
  if (!conn) {
    const err = new Error(`${label} connection not found`);
    err.status = 404;
    throw err;
  }
  return conn;
}

// POST /api/compare/data — generic ITSM configuration/reference data diff.
// Works against any form (e.g. CTM:Category, CTM:Support Group, CTM:People
// Organization). This is the only compare mode: Active Links, Filters,
// Escalations aren't exposed by BMC's REST API at all, and Menus only
// supports lookup-by-known-name, not bulk listing — so entries are the only
// object type that can be diffed wholesale between two environments.
router.post('/data', async (req, res) => {
  const { leftConnId, rightConnId, formName, keyField, qLeft, qRight, fields } = req.body;
  if (!formName) return res.status(400).json({ error: 'formName is required' });
  if (!keyField) return res.status(400).json({ error: 'keyField is required' });

  const leftConn = resolveConn(leftConnId, 'Left');
  const rightConn = resolveConn(rightConnId, 'Right');

  const [leftData, rightData] = await Promise.all([
    helix.queryEntries(leftConn, formName, { q: qLeft, fields, limit: 1000 }),
    helix.queryEntries(rightConn, formName, { q: qRight, fields, limit: 1000 })
  ]);

  const normalize = (data) => (data.entries || data || []).map(e => e.values || e);

  const result = diffByKey(normalize(leftData), normalize(rightData), keyField);
  res.json(result);
});

module.exports = router;
