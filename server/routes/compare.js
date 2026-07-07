const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');
const { diffByKey, deepDiff } = require('../lib/diff');

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

// Workflow ("code") object types this tool already knows how to browse.
const LIST_FETCHERS = {
  activelinks: (conn, form) => helix.getActiveLinkNames(conn, form),
  filters: (conn, form) => helix.getFilterNames(conn, form),
  escalations: (conn) => helix.getEscalationNames(conn),
  menus: (conn) => helix.getMenus(conn),
};

const DETAIL_FETCHERS = {
  activelinks: (conn, name) => helix.getActiveLink(conn, name),
  filters: (conn, name) => helix.getFilter(conn, name),
  escalations: (conn, name) => helix.getEscalation(conn, name),
  menus: (conn, name) => helix.getMenu(conn, name),
};

// Fields worth flagging as "modified" at the list level — the summary pass
// avoids fetching every full definition, since that can mean hundreds of
// requests per side. Deep field diffs happen lazily via /workflow/detail.
const SUMMARY_COMPARE_FIELDS = ['enabled', 'executionOrder', 'modifiedDate', 'modifiedBy', 'schemaName', 'menuType'];

// POST /api/compare/workflow — added/removed/modified summary for one object type
router.post('/workflow', async (req, res) => {
  const { leftConnId, rightConnId, objectType, form } = req.body;
  const fetcher = LIST_FETCHERS[objectType];
  if (!fetcher) return res.status(400).json({ error: `Unknown objectType "${objectType}"` });

  const leftConn = resolveConn(leftConnId, 'Left');
  const rightConn = resolveConn(rightConnId, 'Right');

  const [leftData, rightData] = await Promise.all([
    fetcher(leftConn, form),
    fetcher(rightConn, form)
  ]);

  const result = diffByKey(leftData.items || [], rightData.items || [], 'name', SUMMARY_COMPARE_FIELDS);
  res.json(result);
});

// POST /api/compare/workflow/detail — full field-by-field diff for one named object
router.post('/workflow/detail', async (req, res) => {
  const { leftConnId, rightConnId, objectType, name } = req.body;
  const fetcher = DETAIL_FETCHERS[objectType];
  if (!fetcher) return res.status(400).json({ error: `Unknown objectType "${objectType}"` });
  if (!name) return res.status(400).json({ error: 'name is required' });

  const leftConn = resolveConn(leftConnId, 'Left');
  const rightConn = resolveConn(rightConnId, 'Right');

  const [left, right] = await Promise.all([
    fetcher(leftConn, name).catch(() => null),
    fetcher(rightConn, name).catch(() => null)
  ]);

  const diffs = left && right ? deepDiff(left, right) : [];
  res.json({ left, right, diffs });
});

// POST /api/compare/data — generic ITSM configuration/reference data diff.
// Works against any form (e.g. CTM:Category, CTM:Support Group, CTM:People
// Organization) rather than the fixed workflow object types above.
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
