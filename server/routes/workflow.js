// Workflow browsing (Active Links / Filters / Escalations) via the native AR API helper.
// Desktop/local mode only — the Client Gateway it needs is on the user's own machine.
const express = require('express');
const router = express.Router();
const store = require('../lib/connectionStore');
const { isHosted } = require('../config');
const workflow = require('../lib/workflowService');

router.use((req, res, next) => {
  if (isHosted()) {
    return res.status(501).json({
      error: 'Workflow browsing needs the desktop app: it talks to your BMC Client Gateway on this computer, which the hosted site cannot reach.'
    });
  }
  next();
});

const svc = () => workflow.getService();

async function connection(req) {
  const conn = await store.getById(req.user.uid, req.params.id);
  if (!conn) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }
  return conn;
}

router.get('/status', (req, res) => res.json(svc().status()));

router.get('/:id/forms', async (req, res) => {
  res.json({ forms: await svc().forms(await connection(req)) });
});

router.get('/:id/form-workflow', async (req, res) => {
  const form = String(req.query.form || '').trim();
  if (!form) return res.status(400).json({ error: 'form is required' });
  res.json(await svc().formWorkflow(await connection(req), form));
});

router.get('/:id/search', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  res.json(await svc().search(await connection(req), String(req.query.kind || ''), req.query.q, limit));
});

router.get('/:id/object', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(await svc().describe(await connection(req), String(req.query.kind || ''), name));
});

router.post('/:id/objects', async (req, res) => {
  const { kind, names } = req.body || {};
  res.json({ objects: await svc().describeMany(await connection(req), String(kind || ''), names) });
});

router.post('/:id/disconnect', async (req, res) => {
  svc().close(req.params.id);
  res.status(204).send();
});

module.exports = router;
