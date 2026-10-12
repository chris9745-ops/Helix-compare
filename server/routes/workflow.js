// Workflow browsing (Active Links / Filters / Escalations) via the native AR API helper.
// Desktop/local mode only — the Client Gateway it needs is on the user's own machine.
const express = require('express');
const path = require('path');
const router = express.Router();
const store = require('../lib/connectionStore');
const { isHosted } = require('../config');
const workflow = require('../lib/workflowService');
const { CompareJobs, changesBetween } = require('../lib/workflowCompare');
const reports = require('../lib/reports');

/** Send a generated report as a file download (md or csv). */
function sendReport(res, { format, base, md, csv }) {
  const isCsv = String(format).toLowerCase() === 'csv';
  res.setHeader('Content-Type', isCsv ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${reports.slug(base)}-${reports.day(new Date())}.${isCsv ? 'csv' : 'md'}"`);
  res.send(isCsv ? csv() : md());
}

const MAX_REPORT_DETAILS = 150;

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

// Download the finished compare as Markdown (optionally with side-by-side details) or CSV.
router.get('/compare/:jobId/export', async (req, res) => {
  const job = jobOr404(req);
  if (job.status !== 'done') {
    return res.status(409).json({ error: job.status === 'running' ? 'The comparison is still running.' : 'The comparison did not finish.' });
  }
  const wantDetails = req.query.details === '1' && String(req.query.format).toLowerCase() !== 'csv';
  let details;
  if (wantDetails) {
    details = new Map();
    const mods = job.result.items.filter((i) => i.status === 'modified');
    const [leftConn, rightConn] = [await connById(req, job.left.id), await connById(req, job.right.id)];
    const batch = mods.slice(0, MAX_REPORT_DETAILS);
    const side = async (conn, i) => {
      try { return await svc().describe(conn, i.kind, i.name, { includeRaw: false }); }
      catch (e) { if (e.status === 404) return null; throw e; }
    };
    for (let n = 0; n < batch.length; n += 6) {
      await Promise.all(batch.slice(n, n + 6).map(async (i) => {
        const [l, r] = await Promise.all([side(leftConn, i), side(rightConn, i)]);
        details.set(`${i.kind}:${i.name}`, { changes: changesBetween(l, r) });
      }));
    }
    details.truncated = mods.length > MAX_REPORT_DETAILS;
  }
  const scopeName = job.scope.type === 'form' ? job.scope.form : job.scope.pattern;
  sendReport(res, {
    format: req.query.format,
    base: `workflow-compare_${job.left.name}-vs-${job.right.name}_${scopeName}`,
    md: () => reports.compareMarkdown(job, { details }),
    csv: () => reports.compareCsv(job)
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

router.get('/layout-compare/export', async (req, res) => {
  const { leftConnId, rightConnId, form, view, format } = req.query;
  const [left, right] = [await connById(req, leftConnId), await connById(req, rightConnId)];
  if (left.id === right.id) return res.status(400).json({ error: 'Pick two different instances to compare.' });
  const cmp = await svc().compareLayout(left, right, String(form || ''), String(view || ''));
  const meta = { form: String(form), left: left.name, right: right.name };
  sendReport(res, {
    format,
    base: `layout-compare_${left.name}-vs-${right.name}_${form}_${cmp.view.label || cmp.view.name}`,
    md: () => reports.layoutMarkdown(cmp, meta),
    csv: () => reports.layoutCsv(cmp, meta)
  });
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

// ── Recent changes ──────────────────────────────────────────────────────────
function parseRecentQuery(q) {
  let since;
  if (q.since) since = new Date(String(q.since));
  else {
    const days = Number(q.days || 7);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      const err = new Error('days must be between 1 and 3650');
      err.status = 400;
      throw err;
    }
    since = new Date(Date.now() - days * 86400000);
  }
  const kinds = q.kinds ? String(q.kinds).split(',').map((k) => k.trim()).filter(Boolean) : undefined;
  return { since, kinds, form: String(q.form || '').trim() || undefined, user: q.user };
}

router.get('/:id/recent', async (req, res) => {
  res.json(await svc().recentChanges(await connection(req), parseRecentQuery(req.query)));
});

router.get('/:id/recent/export', async (req, res) => {
  const conn = await connection(req);
  const recent = await svc().recentChanges(conn, parseRecentQuery(req.query));
  sendReport(res, {
    format: req.query.format,
    base: `recent-changes_${conn.name}`,
    md: () => reports.recentMarkdown(recent, { instance: conn.name }),
    csv: () => reports.recentCsv(recent)
  });
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
