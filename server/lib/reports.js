/**
 * Report generators for the compare and recent-changes views: Markdown for reading/sharing and
 * CSV for spreadsheets. Pure functions over data the routes already have — no I/O.
 *
 * These reports contain workflow names and definitions from the user's own servers. They are only
 * ever produced as a download to a local file the user chooses; nothing is stored or sent anywhere.
 */

const KIND_LABEL = { activeLink: 'Active Link', filter: 'Filter', escalation: 'Escalation' };
const KIND_PLURAL = { activeLink: 'Active Links', filter: 'Filters', escalation: 'Escalations' };

// ── small helpers ────────────────────────────────────────────────────────────

/** A table cell: pipes escaped, newlines turned into <br> so the row stays on one line. */
const cell = (v) => String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** Inline code that survives backticks inside the text. */
function code(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\r?\n/g, ' ');
  if (!s.includes('`')) return `\`${s}\``;
  return `\`\` ${s} \`\``;
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fence(text) {
  const body = String(text === null || text === undefined ? '' : text);
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${body}\n${f}`;
}

function csvEscape(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel opens UTF-8 CSV correctly only with a BOM. */
const csv = (rows) => `﻿${rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')}\r\n`;

const stamp = (d) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const day = (d) => d.toISOString().slice(0, 10);

/** A filesystem-safe file name part. */
// letters, digits, _ and - only (no dots: nothing that could read as a path or an extension)
const slug = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';

// ── workflow compare ─────────────────────────────────────────────────────────

/**
 * job: { left:{name}, right:{name}, scope, kinds, result:{summary, items} }
 * details: Map "kind:name" -> { left, right, changes } for modified objects (optional)
 */
function compareMarkdown(job, { details, generatedAt = new Date() } = {}) {
  const L = job.left.name, R = job.right.name;
  const { summary, items } = job.result;
  const out = [];
  out.push(`# Workflow compare: ${L} vs ${R}`, '');
  out.push(`- **Generated:** ${stamp(generatedAt)}`);
  out.push(`- **Scope:** ${job.scope.type === 'form' ? `form ${code(job.scope.form)}` : `names matching ${code(job.scope.pattern)}`}`);
  out.push(`- **Compared:** ${job.kinds.map((k) => KIND_PLURAL[k]).join(', ')}`);
  if (job.scope.exclude && job.scope.exclude.length) out.push(`- **Excluded:** ${job.scope.exclude.map(code).join(', ')}`);
  out.push('', '## Summary', '');
  out.push(`| | ${L} | ${R} | Only in ${L} | Only in ${R} | Different | Identical | Excluded |`);
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const kind of job.kinds) {
    const s = summary[kind];
    if (!s) continue;
    out.push(`| ${KIND_PLURAL[kind]} | ${s.left} | ${s.right} | ${s.onlyLeft} | ${s.onlyRight} | ${s.modified} | ${s.same} | ${s.excluded || 0} |`);
  }

  const group = (status) => items.filter((i) => i.status === status);
  const listOnly = (title, status) => {
    const rows = group(status);
    out.push('', `## ${title} (${rows.length})`, '');
    if (!rows.length) { out.push('_None._'); return; }
    for (const kind of job.kinds) {
      const k = rows.filter((i) => i.kind === kind);
      if (!k.length) continue;
      out.push(`**${KIND_PLURAL[kind]} (${k.length})**`, '');
      for (const i of k) out.push(`- ${code(i.name)}`);
      out.push('');
    }
  };
  listOnly(`Only in ${L}`, 'onlyLeft');
  listOnly(`Only in ${R}`, 'onlyRight');

  const mods = group('modified');
  out.push('', `## Different (${mods.length})`, '');
  if (!mods.length) out.push('_None._');
  else {
    out.push('| Kind | Object | What changed |', '|---|---|---|');
    for (const i of mods) out.push(`| ${KIND_LABEL[i.kind]} | ${code(i.name)} | ${cell((i.aspects || []).join(', '))} |`);
  }

  if (details && details.size) {
    out.push('', '## Details', '');
    for (const i of mods) {
      const d = details.get(`${i.kind}:${i.name}`);
      if (!d || !d.changes || !d.changes.length) continue;
      out.push(`### ${KIND_LABEL[i.kind]}: ${i.name}`, '');
      for (const c of d.changes) {
        out.push(`**${c.aspect}** _(${c.kind})_`, '', `${L}:`, fence(c.left === null ? '— not present —' : c.left), '', `${R}:`, fence(c.right === null ? '— not present —' : c.right), '');
      }
    }
  }
  if (details && details.truncated) {
    out.push('', `_Details are shown for the first ${details.size} different objects only._`);
  }
  out.push('');
  return out.join('\n');
}

function compareCsv(job) {
  const L = job.left.name, R = job.right.name;
  const status = { onlyLeft: `Only in ${L}`, onlyRight: `Only in ${R}`, modified: 'Different' };
  return csv([
    ['Kind', 'Object', 'Status', 'What changed'],
    ...job.result.items.map((i) => [KIND_LABEL[i.kind], i.name, status[i.status], (i.aspects || []).join('; ')])
  ]);
}

// ── form layout compare ──────────────────────────────────────────────────────

const boxText = (b) => (b ? `${b.x},${b.y} ${b.w}×${b.h}` : '—');

function changeValues(item, aspect) {
  const l = item.left, r = item.right;
  switch (aspect) {
    case 'Name': return [l.name, r.name];
    case 'Label': return [l.label || '—', r.label || '—'];
    case 'Visibility': return [l.visible ? 'Visible' : 'Hidden', r.visible ? 'Visible' : 'Hidden'];
    case 'Access': return [l.access || '—', r.access || '—'];
    case 'Container': return [l.parent === null ? 'not placed' : `#${l.parent}`, r.parent === null ? 'not placed' : `#${r.parent}`];
    case 'Position': return [l.box ? `${l.box.x}, ${l.box.y}` : '—', r.box ? `${r.box.x}, ${r.box.y}` : '—'];
    case 'Size': return [l.box ? `${l.box.w} × ${l.box.h}` : '—', r.box ? `${r.box.w} × ${r.box.h}` : '—'];
    case 'Label placement': return [boxText(l.labelBox), boxText(r.labelBox)];
    case 'Tab order': return [l.tabOrder ?? '—', r.tabOrder ?? '—'];
    case 'Stacking order': return [l.zOrder ?? '—', r.zOrder ?? '—'];
    default: return ['', ''];
  }
}

/** cmp: result of compareLayout; meta: { form, left, right, generatedAt } */
function layoutMarkdown(cmp, meta) {
  const { form, left, right, generatedAt = new Date() } = meta;
  const s = cmp.summary;
  const out = [];
  out.push(`# Form layout compare: ${form}`, '');
  out.push(`- **View:** ${code(cmp.view.label || cmp.view.name)}`);
  out.push(`- **Instances:** ${left} vs ${right}`);
  out.push(`- **Generated:** ${stamp(generatedAt)}`, '');
  out.push('## Summary', '');
  out.push(`| Fields on ${left} | Fields on ${right} | Changed | Only on ${left} | Only on ${right} | Identical | Reordered only |`);
  out.push('|---:|---:|---:|---:|---:|---:|---:|');
  out.push(`| ${s.left} | ${s.right} | ${s.modified} | ${s.onlyLeft} | ${s.onlyRight} | ${s.same} | ${s.reordered || 0} |`);

  const v = cmp.views || { onlyLeft: [], onlyRight: [] };
  if (v.onlyLeft.length || v.onlyRight.length) {
    out.push('', '## Views that exist on one instance only', '');
    for (const x of v.onlyLeft) out.push(`- ${code(x.label || x.name)} — only on ${left}`);
    for (const x of v.onlyRight) out.push(`- ${code(x.label || x.name)} — only on ${right}`);
  }

  const only = (status, where) => {
    const rows = cmp.items.filter((i) => i.status === status);
    out.push('', `## Only on ${where} (${rows.length})`, '');
    if (!rows.length) { out.push('_None._'); return; }
    out.push('| Field | ID | Type | Label |', '|---|---:|---|---|');
    for (const i of rows) out.push(`| ${code(i.name)} | ${i.id} | ${cell(i.type)} | ${cell(i.label || '')} |`);
  };
  only('onlyLeft', left);
  only('onlyRight', right);

  const mods = cmp.items.filter((i) => i.status === 'modified');
  out.push('', `## Changed (${mods.length})`, '');
  if (!mods.length) out.push('_None._');
  else {
    out.push(`| Field | ID | What | ${left} | ${right} |`, '|---|---:|---|---|---|');
    for (const i of mods) {
      i.aspects.forEach((a, n) => {
        const [lv, rv] = changeValues(i, a);
        out.push(`| ${n === 0 ? code(i.name) : ''} | ${n === 0 ? i.id : ''} | ${a} | ${cell(lv)} | ${cell(rv)} |`);
      });
    }
  }
  out.push('');
  return out.join('\n');
}

function layoutCsv(cmp, meta) {
  const { left, right } = meta;
  const rows = [['Field', 'ID', 'Type', 'Status', 'What changed', `${left}`, `${right}`]];
  for (const i of cmp.items) {
    if (i.status === 'modified') {
      for (const a of i.aspects) {
        const [lv, rv] = changeValues(i, a);
        rows.push([i.name, i.id, i.type, 'Changed', a, lv, rv]);
      }
    } else {
      rows.push([i.name, i.id, i.type, i.status === 'onlyLeft' ? `Only on ${left}` : `Only on ${right}`, '', '', '']);
    }
  }
  return csv(rows);
}

// ── recent changes ───────────────────────────────────────────────────────────

/** recent: result of recentChanges; meta: { instance, generatedAt } */
function recentMarkdown(recent, meta) {
  const { instance, generatedAt = new Date() } = meta;
  const out = [];
  out.push(`# Recent workflow changes: ${instance}`, '');
  out.push(`- **Since:** ${stamp(new Date(recent.since))}`);
  out.push(`- **Generated:** ${stamp(generatedAt)}`);
  out.push(`- **Compared kinds:** ${recent.kinds.map((k) => KIND_PLURAL[k]).join(', ')}`);
  if (recent.form) out.push(`- **Form:** ${code(recent.form)}`);
  out.push(`- **Objects changed:** ${recent.rows.length}`, '');

  const users = Object.entries(recent.byUser).sort((a, b) => b[1] - a[1]);
  if (users.length) {
    out.push('## By person', '', '| Changed by | Objects |', '|---|---:|');
    for (const [u, n] of users) out.push(`| ${cell(u)} | ${n} |`);
  }
  out.push('', '## Changes (newest first)', '');
  if (!recent.rows.length) { out.push('_Nothing changed in this window._', ''); return out.join('\n'); }
  out.push('| When (UTC) | Changed by | Kind | Object | Form | Enabled |', '|---|---|---|---|---|---|');
  for (const r of recent.rows) {
    out.push(`| ${r.changedAt ? stamp(new Date(r.changedAt)) : '—'} | ${cell(r.changedBy || '—')} | ${KIND_LABEL[r.kind]} | ${code(r.name)} | ${cell(r.primaryForm || '')}${r.formCount > 1 ? ` (+${r.formCount - 1})` : ''} | ${r.enabled ? 'Yes' : 'No'} |`);
  }
  out.push('');
  return out.join('\n');
}

function recentCsv(recent) {
  return csv([
    ['Changed at (UTC)', 'Changed by', 'Kind', 'Object', 'Primary form', 'Forms', 'Enabled', 'Owner', 'Application'],
    ...recent.rows.map((r) => [r.changedAt || '', r.changedBy, KIND_LABEL[r.kind], r.name, r.primaryForm || '', r.formCount, r.enabled ? 'Yes' : 'No', r.owner || '', r.application || ''])
  ]);
}

module.exports = {
  compareMarkdown, compareCsv, layoutMarkdown, layoutCsv, recentMarkdown, recentCsv,
  slug, day, csv, fence, code, cell, KIND_LABEL
};
