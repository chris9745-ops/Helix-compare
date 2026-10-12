// Workflow browsing (Active Links / Filters / Escalations) via the native AR API helper.
// Desktop/local mode only — the Client Gateway it needs is on the user's own machine.
const express = require('express');
const path = require('path');
const router = express.Router();
const store = require('../lib/connectionStore');
const { isHosted } = require('../config');
const workflow = require('../lib/workflowService');
const { CompareJobs, changesBetween } = require('../lib/workflowCompare');

let jobs = null;
const compareJobs = () => {
  if (!jobs || jobs.service !== workflow.getService()) jobs = new CompareJobs({ service: workflow.getService() });
  return jobs;
};

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

// ── Setup: where the AR API jars and Java live ──────────────────────────────
// A double-clicked desktop app doesn't inherit shell environment variables, so this is how the
// packaged app is pointed at the user's own Developer Studio kit.
const dataDir = () => process.env.HELIX_DATA_DIR || path.join(__dirname, '../data');

router.put('/settings', (req, res) => {
  const { libDir, javaPath } = req.body || {};
  const patch = {};
  const problems = [];

  if (libDir !== undefined) {
    const found = String(libDir).trim() ? workflow.findApiLibDir(libDir) : '';
    if (String(libDir).trim() && !found) {
      problems.push(`No arapi*.jar was found in or under "${String(libDir).trim()}". Pick the folder from your Developer Studio kit that contains arapi*.jar (usually …/com.bmc.arsys.studio.api_…/lib).`);
    } else patch.libDir = found || '';
  }
  if (javaPath !== undefined) {
    const java = String(javaPath).trim();
    if (java) {
      const major = workflow.javaMajor(java);
      if (major === null) problems.push(`Could not run Java at "${java}".`);
      else if (major > 14) problems.push(`That Java is version ${major}; the helper needs 8–14 (Nashorn was removed in 15).`);
      else patch.javaPath = java;
    } else patch.javaPath = '';
  }
  if (problems.length) return res.status(400).json({ error: problems.join(' ') });

  workflow.writeSettings(dataDir(), patch);
  res.json(svc().reconfigure(workflow.resolveConfig({ dataDir: dataDir() })));
});

// ── Dev-vs-Prod workflow compare ────────────────────────────────────────────
// Registered before the /:id routes. Long-running, so it's a background job the page polls.
async function connById(req, id) {
  const conn = id ? await store.getById(req.user.uid, id) : null;
  if (!conn) {
    const err = new Error('Connection not found');
    err.status = 404;
    throw err;
  }
  return conn;
}

router.post('/compare', async (req, res) => {
  const { leftConnId, rightConnId, kinds, scope } = req.body || {};
  const [left, right] = [await connById(req, leftConnId), await connById(req, rightConnId)];
  const job = compareJobs().start({ ownerId: req.user.uid, left, right, kinds, scope });
  res.status(202).json({ jobId: job.id });
});

function jobOr404(req) {
  const job = compareJobs().get(req.params.jobId, req.user.uid);
  if (!job) {
    const err = new Error('Compare job not found (it may have expired)');
    err.status = 404;
    throw err;
  }
  return job;
}

router.get('/compare/:jobId', (req, res) => {
  const job = jobOr404(req);
  res.json({
    status: job.status, progress: job.progress, error: job.error,
    left: job.left, right: job.right, scope: job.scope, kinds: job.kinds,
    result: job.status === 'done' ? job.result : null
  });
});

// Both sides of one object, readable, with the differences worked out.
router.get('/compare/:jobId/object', async (req, res) => {
  const job = jobOr404(req);
  const kind = String(req.query.kind || ''), name = String(req.query.name || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  const side = async (id) => {
    const conn = await connById(req, id);
    try { return await svc().describe(conn, kind, name, { includeRaw: false }); }
    catch (e) { if (e.status === 404) return null; throw e; }
  };
  const [left, right] = await Promise.all([side(job.left.id), side(job.right.id)]);
  res.json({ left, right, changes: changesBetween(left, right) });
});

// ── Form layout ─────────────────────────────────────────────────────────────
router.get('/layout-compare', async (req, res) => {
  const { leftConnId, rightConnId, form, view } = req.query;
  const [left, right] = [await connById(req, leftConnId), await connById(req, rightConnId)];
  if (left.id === right.id) return res.status(400).json({ error: 'Pick two different instances to compare.' });
  res.json(await svc().compareLayout(left, right, String(form || ''), String(view || '')));
});

router.get('/:id/layout/views', async (req, res) => {
  res.json({ views: await svc().layoutViews(await connection(req), String(req.query.form || '').trim()) });
});

router.get('/:id/layout', async (req, res) => {
  const form = String(req.query.form || '').trim();
  const view = Number(req.query.view);
  if (!form || !Number.isInteger(view)) return res.status(400).json({ error: 'form and view are required' });
  res.json({ fields: await svc().layout(await connection(req), form, view) });
});

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
