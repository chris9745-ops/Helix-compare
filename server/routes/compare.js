const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const helix = require('../lib/helixClient');
const { diffByKey } = require('../lib/diff');

async function resolveConn(req, id, label) {
  if (!id) {
    const err = new Error(`${label} connection id is required`);
    err.status = 400;
    throw err;
  }
  const conn = await store.getById(req.user.uid, id);
  if (!conn) {
    const err = new Error(`${label} connection not found`);
    err.status = 404;
    throw err;
  }
  return conn;
}

// Tag a failure with which instance it came from, so the message can say
// 'Left connection "Dev": …' instead of leaving the user to guess.
const forSide = (label, conn, promise) =>
  promise.catch(err => { err.helixContext = `${label} connection "${conn.name}"`; throw err; });

// Normalizes BMC's various "list" response shapes into a flat array. Used for
// both entry responses ({ entries: [{ values: {...} }] }) and field-metadata
// responses (shape unverified across BMC versions — could be an array, or
// wrapped in { fields } / { items }).
function normalizeList(data) {
  const arr = Array.isArray(data) ? data : (data?.entries || data?.fields || data?.items || []);
  return arr.map(e => e?.values || e);
}

// Trim the diff down to what the UI actually renders. Matters most on the
// hosted site, where serverless responses are capped at a few MB: full left and
// right copies of every record would roughly triple the payload.
function slim(result) {
  return {
    summary: result.summary,
    removed: result.removed.map(({ key }) => ({ key })),
    added: result.added.map(({ key }) => ({ key })),
    modified: result.modified.map(({ key, fieldDiffs }) => ({ key, fieldDiffs })),
    unchanged: result.unchanged.map(({ key, left }) => ({ key, left }))
  };
}

// POST /api/compare/data — generic ITSM configuration/reference data diff.
// Works against any form (e.g. CTM:Category, CTM:Support Group, CTM:People
// Organization). Entries are the one BMC REST resource that supports real
// bulk listing/searching — Active Links, Filters, Escalations aren't exposed
// via REST at all, and Menus only support lookup-by-known-name.
router.post('/data', async (req, res) => {
  const { leftConnId, rightConnId, formName, keyField, qLeft, qRight, fields } = req.body;
  if (!formName) return res.status(400).json({ error: 'formName is required' });
  if (!keyField) return res.status(400).json({ error: 'keyField is required' });

  const leftConn = await resolveConn(req, leftConnId, 'Left');
  const rightConn = await resolveConn(req, rightConnId, 'Right');

  const [leftData, rightData] = await Promise.all([
    forSide('Left', leftConn, helix.queryEntries(leftConn, formName, { q: qLeft, fields, limit: 1000 })),
    forSide('Right', rightConn, helix.queryEntries(rightConn, formName, { q: qRight, fields, limit: 1000 }))
  ]);

  res.json(slim(diffByKey(normalizeList(leftData), normalizeList(rightData), keyField)));
});

// POST /api/compare/fields — diff a form's FIELD DEFINITIONS (schema) rather
// than its data, e.g. to catch a custom field that exists in Dev but hasn't
// been promoted to Prod yet. Uses the same generic key-based diff engine —
// key field is user-specified since the exact response shape from BMC's
// /fields/{form} endpoint isn't fully verified across versions.
router.post('/fields', async (req, res) => {
  const { leftConnId, rightConnId, formName, keyField } = req.body;
  if (!formName) return res.status(400).json({ error: 'formName is required' });
  if (!keyField) return res.status(400).json({ error: 'keyField is required' });

  const leftConn = await resolveConn(req, leftConnId, 'Left');
  const rightConn = await resolveConn(req, rightConnId, 'Right');

  const [leftData, rightData] = await Promise.all([
    forSide('Left', leftConn, helix.getFormFields(leftConn, formName)),
    forSide('Right', rightConn, helix.getFormFields(rightConn, formName))
  ]);

  res.json(slim(diffByKey(normalizeList(leftData), normalizeList(rightData), keyField)));
});

module.exports = router;
