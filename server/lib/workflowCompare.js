/**
 * Dev-vs-Prod comparison of workflow objects (Active Links, Filters, Escalations).
 *
 * Objects are matched by name within a kind. "Modified" is decided on the raw definitions with
 * volatile metadata removed (who/when it was last changed, internal keys), and lists whose order
 * means nothing are sorted first — so promoting a package doesn't light up every object.
 *
 * Only a hash per top-level property is kept per object, so comparing a few thousand objects stays
 * small in memory. Readable detail for one object is computed on demand (changesBetween).
 */
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { KINDS } = require('./workflowService');

// Properties that change on every deployment without the workflow itself changing.
const VOLATILE = new Set(['key', 'newName', 'lastUpdateTime', 'lastChangedBy', 'changeFlags', 'diary', '_type']);
// Lists whose order carries no meaning.
const UNORDERED = new Set(['formList', 'groupList', 'permissions']);

const ASPECT_LABELS = {
  enable: 'Enabled', order: 'Order', executeMask: 'Execute on', opSet: 'Execute on',
  formList: 'Forms', primaryForm: 'Primary form', qualifier: 'Run If', actionList: 'If actions',
  elseList: 'Else actions', helpText: 'Help text', owner: 'Owner', permissions: 'Permissions',
  groupList: 'Permissions', properties: 'Properties', escalationTm: 'Schedule',
  focusField: 'Focus field', controlField: 'Control field', assignedGroup: 'Assigned group',
  errorActlinkName: 'Error handler', errorActlinkOptions: 'Error handler',
  errorHandlingFilter: 'Error handler', errorFilterOptions: 'Error handler'
};
const aspectLabel = (key) => ASPECT_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** Deterministic form of a value: object keys sorted, nothing dependent on map iteration order. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(canonical(v))).digest('hex');

/** { aspectKey: sha1 } for the properties that matter, with unordered lists sorted. */
function fingerprint(raw) {
  const parts = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (VOLATILE.has(k)) continue;
    let value = v;
    if (UNORDERED.has(k) && Array.isArray(v)) {
      value = [...v].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
    }
    parts[k] = hash(value);
  }
  return parts;
}

/** Top-level properties whose hashes differ — as user-facing labels, de-duplicated. */
function changedAspects(a, b) {
  const labels = new Set();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) labels.add(aspectLabel(key));
  }
  return [...labels];
}

/**
 * left/right: Map name -> fingerprint. Returns names only in left / only in right, the modified
 * ones with what changed, and how many were identical.
 */
function compareFingerprints(left, right) {
  const onlyLeft = [], onlyRight = [], modified = [];
  let same = 0;
  for (const [name, fp] of left) {
    const other = right.get(name);
    if (!other) { onlyLeft.push(name); continue; }
    const aspects = changedAspects(fp, other);
    if (aspects.length) modified.push({ name, aspects }); else same += 1;
  }
  for (const name of right.keys()) if (!left.has(name)) onlyRight.push(name);
  const byName = (a, b) => (a.name || a).localeCompare(b.name || b);
  return { onlyLeft: onlyLeft.sort(), onlyRight: onlyRight.sort(), modified: modified.sort(byName), same };
}

// ── readable detail for one object ───────────────────────────────────────────────────────────

const actionText = (a) => [a.label, ...a.lines].join('\n');

/** Align two action lists (LCS on text) so an inserted action doesn't make everything look changed. */
function diffActions(title, left, right) {
  const a = left.map(actionText), b = right.map(actionText);
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0, delRun = [], addRun = [];
  const flush = () => {
    const pairs = Math.max(delRun.length, addRun.length);
    for (let p = 0; p < pairs; p++) {
      const l = delRun[p], r = addRun[p];
      out.push({
        aspect: `${title} ${(l !== undefined ? l : r) + 1}`,
        kind: l === undefined ? 'added' : r === undefined ? 'removed' : 'changed',
        left: l === undefined ? null : a[l],
        right: r === undefined ? null : b[r]
      });
    }
    delRun = []; addRun = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) delRun.push(i++);
    else addRun.push(j++);
  }
  flush();
  return out;
}

/** One entry listing only the object properties that were added, removed or changed. */
function diffProperties(left, right) {
  const byId = (list) => new Map(list.map((p) => [p.id, p]));
  const [l, r] = [byId(left), byId(right)];
  const leftLines = [], rightLines = [];
  for (const id of [...new Set([...l.keys(), ...r.keys()])].sort((a, b) => a - b)) {
    const a = l.get(id), b = r.get(id);
    if (a && b && a.value === b.value) continue;
    if (a) leftLines.push(`${a.name} = ${a.value}`);
    if (b) rightLines.push(`${b.name} = ${b.value}`);
  }
  if (!leftLines.length && !rightLines.length) return [];
  return [{
    aspect: 'Properties',
    kind: !leftLines.length ? 'added' : !rightLines.length ? 'removed' : 'changed',
    left: leftLines.length ? leftLines.join('\n') : null,
    right: rightLines.length ? rightLines.join('\n') : null
  }];
}

const setDiff = (a, b) => ({ onlyLeft: a.filter((x) => !b.includes(x)), onlyRight: b.filter((x) => !a.includes(x)) });

/**
 * Readable differences between two describeObject() results (either may be null if the object is
 * missing on that side). Returns [{ aspect, kind, left, right }].
 */
function changesBetween(l, r) {
  if (!l || !r) return [];
  const out = [];
  const scalar = (aspect, a, b) => { if (String(a) !== String(b)) out.push({ aspect, kind: 'changed', left: String(a), right: String(b) }); };
  scalar('Enabled', l.enabled ? 'Enabled' : 'Disabled', r.enabled ? 'Enabled' : 'Disabled');
  scalar('Order', l.order === null ? '—' : l.order, r.order === null ? '—' : r.order);
  scalar('Execute on', l.executeOn.join(', ') || '—', r.executeOn.join(', ') || '—');
  scalar('Schedule', l.schedule || '—', r.schedule || '—');
  scalar('Run If', l.runIf || '(always)', r.runIf || '(always)');
  scalar('Owner', l.owner || '—', r.owner || '—');
  scalar('Help text', l.helpText || '', r.helpText || '');
  const forms = setDiff([...l.forms].sort(), [...r.forms].sort());
  if (forms.onlyLeft.length || forms.onlyRight.length) {
    out.push({
      aspect: 'Forms', kind: 'changed',
      left: forms.onlyLeft.length ? `Only here:\n${forms.onlyLeft.join('\n')}` : '—',
      right: forms.onlyRight.length ? `Only here:\n${forms.onlyRight.join('\n')}` : '—'
    });
  }
  out.push(...diffProperties(l.properties || [], r.properties || []));
  out.push(...diffActions('If action', l.actions, r.actions));
  out.push(...diffActions('Else action', l.elseActions, r.elseActions));
  return out;
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────

const MAX_OBJECTS_PER_KIND = 6000;
const JOB_TTL_MS = 60 * 60 * 1000;

const wildcardToRegExp = (pattern) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

function matcher(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return null;
  if (p.includes('*')) { const re = wildcardToRegExp(p); return (n) => re.test(n); }
  const needle = p.toLowerCase();
  return (n) => n.toLowerCase().includes(needle);
}

/**
 * Exclude patterns: a string (one per line or comma-separated) or an array. Same matching rules as
 * name patterns — `*` is an anchored wildcard, otherwise a case-insensitive substring. Returns a
 * predicate (name -> true when excluded), or null when there is nothing to exclude.
 */
function buildExcluder(exclude) {
  const list = (Array.isArray(exclude) ? exclude : String(exclude || '').split(/[\n,]+/))
    .map((p) => String(p).trim()).filter(Boolean);
  const tests = list.map(matcher).filter(Boolean);
  if (!tests.length) return null;
  return (name) => tests.some((t) => t(name));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

class CompareJobs {
  constructor({ service }) {
    this.service = service;
    this.jobs = new Map();
  }

  _gc() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, j] of this.jobs) if (j.createdAt < cutoff) this.jobs.delete(id);
  }

  get(id, ownerId) {
    const job = this.jobs.get(id);
    return job && job.ownerId === ownerId ? job : null;
  }

  /** Validates, then runs in the background. Returns the job immediately. */
  start({ ownerId, left, right, kinds, scope }) {
    this._gc();
    const wanted = (kinds && kinds.length ? kinds : KINDS).filter((k) => KINDS.includes(k));
    if (!wanted.length) throw httpError(400, 'Choose at least one of: activeLink, filter, escalation.');
    if (!scope || (scope.type === 'form' && !String(scope.form || '').trim())) throw httpError(400, 'Enter a form name to compare.');
    if (scope.type === 'pattern' && String(scope.pattern || '').replace(/\*/g, '').trim().length < 2) {
      throw httpError(400, 'Enter at least 2 characters of a name (use * as a wildcard, e.g. HPD:INC:*).');
    }
    if (!['form', 'pattern'].includes(scope.type)) throw httpError(400, 'scope.type must be "form" or "pattern".');
    if (left.id === right.id) throw httpError(400, 'Pick two different instances to compare.');
    const excluder = buildExcluder(scope.exclude);
    if (scope.exclude && String(Array.isArray(scope.exclude) ? scope.exclude.join('') : scope.exclude).replace(/[*\s,]/g, '').length === 0) {
      throw httpError(400, 'An exclude pattern must contain some text (a lone * would hide everything).');
    }

    const job = {
      id: randomUUID(), ownerId, createdAt: Date.now(), status: 'running',
      left: { id: left.id, name: left.name }, right: { id: right.id, name: right.name },
      scope: { ...scope, exclude: excluder ? (Array.isArray(scope.exclude) ? scope.exclude : String(scope.exclude).split(/[\n,]+/).map((p) => p.trim()).filter(Boolean)) : [] },
      excluder, kinds: wanted, progress: { step: 0, steps: wanted.length * 2, label: 'Starting…' },
      result: null, error: null
    };
    this.jobs.set(job.id, job);
    this._run(job, left, right).catch((e) => {
      job.status = 'error';
      job.error = e.message;
      job.errorStatus = e.status || 500;
    });
    return job;
  }

  async _fingerprints(conn, kind, scope, names, excluder, excluded) {
    const raws = scope.type === 'form'
      ? await this.service.fetchObjects(conn, kind, { form: scope.form.trim() })
      : await this.service.fetchObjects(conn, kind, { names });
    const out = new Map();
    for (const [name, raw] of raws) {
      if (excluder && excluder(name)) { excluded.add(name); continue; }
      out.set(name, fingerprint(raw));
    }
    return out;
  }

  async _run(job, left, right) {
    const step = (label) => { job.progress.step += 1; job.progress.label = label; };
    const summary = {};
    const items = [];
    for (const kind of job.kinds) {
      const kindLabel = { activeLink: 'active links', filter: 'filters', escalation: 'escalations' }[kind];
      let leftNames = null, rightNames = null;
      const excluded = new Set();
      if (job.scope.type === 'pattern') {
        const test = matcher(job.scope.pattern);
        const [ln, rn] = await Promise.all([this.service.allNames(left, kind), this.service.allNames(right, kind)]);
        // excluded objects are never read at all in this mode (cheaper than reading then dropping)
        const keep = (n) => {
          if (!test(n)) return false;
          if (job.excluder && job.excluder(n)) { excluded.add(n); return false; }
          return true;
        };
        leftNames = ln.filter(keep);
        rightNames = rn.filter(keep);
        if (leftNames.length > MAX_OBJECTS_PER_KIND || rightNames.length > MAX_OBJECTS_PER_KIND) {
          throw httpError(400, `That pattern matches more than ${MAX_OBJECTS_PER_KIND.toLocaleString()} ${kindLabel}. Narrow it down.`);
        }
      }
      job.progress.label = `Reading ${kindLabel} from ${job.left.name} and ${job.right.name}…`;
      const [lfp, rfp] = await Promise.all([
        this._fingerprints(left, kind, job.scope, leftNames, job.excluder, excluded).then((m) => { step(`Read ${kindLabel} from ${job.left.name}`); return m; }),
        this._fingerprints(right, kind, job.scope, rightNames, job.excluder, excluded).then((m) => { step(`Read ${kindLabel} from ${job.right.name}`); return m; })
      ]);
      const cmp = compareFingerprints(lfp, rfp);
      summary[kind] = {
        left: lfp.size, right: rfp.size,
        onlyLeft: cmp.onlyLeft.length, onlyRight: cmp.onlyRight.length, modified: cmp.modified.length, same: cmp.same,
        excluded: excluded.size
      };
      for (const name of cmp.onlyLeft) items.push({ kind, name, status: 'onlyLeft' });
      for (const name of cmp.onlyRight) items.push({ kind, name, status: 'onlyRight' });
      for (const m of cmp.modified) items.push({ kind, name: m.name, status: 'modified', aspects: m.aspects });
    }
    job.result = { summary, items };
    job.status = 'done';
    job.progress.label = 'Done';
  }
}

module.exports = {
  canonical, fingerprint, changedAspects, compareFingerprints, changesBetween, diffActions, diffProperties,
  matcher, buildExcluder, CompareJobs, MAX_OBJECTS_PER_KIND
};
