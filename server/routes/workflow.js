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
const defExport = require('../lib/defExport');
const fs = require('fs');

/** Send a generated report as a file download (md or csv). */
function sendReport(res, { format, base, md, csv }) {
  const isCsv = String(format).toLowerCase() === 'csv';
  res.setHeader('Content-Type', isCsv ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${reports.slug(base)}-${reports.day(new Date())}.${isCsv ? 'csv' : 'md'}"`);
  res.send(isCsv ? csv() : md());
}

const MAX_REPORT_DETAILS = 150;

// ── Definition export (.def / .xml) ─────────────────────────────────────────
const exportDir = () => workflow.readSettings(dataDir()).exportDir || '';

function checkFolder(raw) {
  const dir = path.resolve(String(raw || '').trim().replace(/^~(?=$|[\\/])/, process.env.HOME || '~'));
  if (!raw || !String(raw).trim()) {
    const err = new Error('Enter a folder to save exports in.');
    err.status = 400;
    throw err;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (e) {
    const err = new Error(`That folder can't be written to: ${e.code || e.message}`);
    err.status = 400;
    throw err;
  }
  return dir;
}

/** First free path: name.def, name-2.def, … so a repeated export never silently overwrites a file. */
function freePath(dir, file) {
  const ext = path.extname(file), stem = file.slice(0, file.length - ext.length);
  let candidate = path.join(dir, file), n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${n++}${ext}`);
  return candidate;
}

/**
 * Export `items` from `conn`. With `save` the files (and a manifest) are written to the export folder
 * and a JSON summary is returned; otherwise a single .def/.xml is returned as a download.
 * `target` (optional) is the instance the objects are meant for: forms missing there are reported.
 */
async function runExport(res, { conn, target, items, format, label, scope, save }) {
  const list = defExport.sortItems(defExport.normalizeItems(items));
  const fmt = String(format || 'def').toLowerCase() === 'xml' ? 'xml' : 'def';
  const dir = save ? exportDir() : null;
  if (save && !dir) {
    return res.status(400).json({ error: 'Choose a folder for exports first (Export folder), then try again.' });
  }
  const parts = await svc().exportDefs(conn, list, fmt);
  if (!save && parts.length > 1) {
    return res.status(400).json({
      error: `This export is ${parts.length} files long (${list.length} objects). Use "Save to folder" so all parts are written together.`
    });
  }
  const base = reports.slug(`${conn.name}_${label || 'export'}_${reports.day(new Date())}`);
  const files = parts.map((p, i) => ({ name: defExport.partFileName(base, fmt, i, parts.length), text: p.text, count: p.count }));

  if (!save) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${files[0].name}"`);
    res.setHeader('X-Export-Objects', String(list.length));
    return res.send(files[0].text);
  }

  const definitions = files.reduce((acc, f) => {
    const c = defExport.countDefinitions(f.text);
    return { total: acc.total + c.total, overlays: acc.overlays + c.overlays };
  }, { total: 0, overlays: 0 });
  const [deps, targetForms] = await Promise.all([
    svc().exportDependencies(conn, list),
    target ? svc().forms(target) : Promise.resolve(null)
  ]);
  const manifest = defExport.manifestMarkdown({
    source: conn.name, target: target ? target.name : null, scope, format: fmt,
    files: files.map((f) => ({ name: f.name, count: f.count })), items: list, definitions,
    attachedForms: deps.attachedForms, referencedForms: deps.referencedForms,
    targetForms: targetForms ? new Set(targetForms) : null
  });
  const saved = files.map((f) => {
    const p = freePath(dir, f.name);
    fs.writeFileSync(p, f.text);
    return { path: p, bytes: Buffer.byteLength(f.text), objects: f.count };
  });
  const manifestPath = freePath(dir, `${base}.manifest.md`);
  fs.writeFileSync(manifestPath, manifest);
  const all = [...new Set([...deps.attachedForms, ...deps.referencedForms])];
  const missingForms = targetForms ? all.filter((f) => !new Set(targetForms).has(f)).sort() : null;
  return res.json({
    saved, manifestPath, objects: list.length, definitions, format: fmt, missingForms,
    forms: all.length, attachedForms: deps.attachedForms.length, referencedForms: deps.referencedForms.length
  });
}

router.get('/export-folder', (req, res) => {
  const dir = exportDir();
  res.json({ dir, exists: !!dir && fs.existsSync(dir) });
});

router.put('/export-folder', (req, res) => {
  const dir = checkFolder(req.body && req.body.dir);
  workflow.writeSettings(dataDir(), { exportDir: dir });
  res.json({ dir, exists: true });
});

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

// Export what a compare found: objects only on the left and/or different, taken from the LEFT instance.
router.post('/compare/:jobId/export-def', async (req, res) => {
  const job = jobOr404(req);
  if (job.status !== 'done') return res.status(409).json({ error: 'The comparison has not finished.' });
  const { include = ['onlyLeft', 'modified'], format, save } = req.body || {};
  const wanted = (Array.isArray(include) ? include : []).filter((s) => ['onlyLeft', 'modified'].includes(s));
  if (!wanted.length) return res.status(400).json({ error: 'Choose "only on the left" and/or "different".' });
  const items = job.result.items.filter((i) => wanted.includes(i.status)).map((i) => ({ kind: i.kind, name: i.name }));
  if (!items.length) return res.status(400).json({ error: 'There is nothing to export for that selection.' });
  const [left, right] = [await connById(req, job.left.id), await connById(req, job.right.id)];
  const what = wanted.map((s) => (s === 'onlyLeft' ? `only on ${left.name}` : 'different')).join(' + ');
  const scopeName = job.scope.type === 'form' ? `form ${job.scope.form}` : `names matching ${job.scope.pattern}`;
  return runExport(res, {
    conn: left, target: right, items, format, save: !!save,
    label: `${scopeName.replace(/^(form|names matching) /, '')}_${wanted.join('-')}`,
    scope: `Compare of ${scopeName}: objects ${what} compared with ${right.name}`
  });
});

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

// Export objects from this instance: an explicit list, or everything attached to a form.
router.post('/:id/export', async (req, res) => {
  const conn = await connection(req);
  const { items, scope, format, save, label } = req.body || {};
  let list = items;
  let scopeText = 'Selected objects';
  let name = label;
  if (scope && scope.type === 'form') {
    const form = String(scope.form || '').trim();
    if (!form) return res.status(400).json({ error: 'Enter a form name.' });
    const kinds = (Array.isArray(scope.kinds) && scope.kinds.length ? scope.kinds : ['activeLink', 'filter', 'escalation'])
      .filter((k) => workflow.KINDS.includes(k));
    const w = await svc().formWorkflow(conn, form);
    const keyOf = { activeLink: 'activeLinks', filter: 'filters', escalation: 'escalations' };
    list = kinds.flatMap((k) => (w[keyOf[k]] || []).map((n) => ({ kind: k, name: n })));
    if (scope.includeForm) list.push({ kind: 'form', name: form });
    scopeText = `Everything attached to form ${form}: ${kinds.join(', ')}${scope.includeForm ? ' and the form definition' : ''}`;
    name = name || form;
  } else if (Array.isArray(items)) {
    scopeText = `${items.length} selected object${items.length === 1 ? '' : 's'}`;
    name = name || (items.length === 1 ? items[0].name : 'selection');
  }
  return runExport(res, { conn, items: list, format, save: !!save, label: name, scope: scopeText });
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
