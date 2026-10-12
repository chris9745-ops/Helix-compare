const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/reports');

const job = {
  left: { name: 'Dev' }, right: { name: 'Prod' },
  scope: { type: 'form', form: 'HPD:Help Desk', exclude: ['zSLMGen:*'] },
  kinds: ['filter', 'activeLink'],
  result: {
    summary: {
      filter: { left: 10, right: 9, onlyLeft: 2, onlyRight: 1, modified: 1, same: 6, excluded: 3 },
      activeLink: { left: 5, right: 5, onlyLeft: 0, onlyRight: 0, modified: 0, same: 5, excluded: 0 }
    },
    items: [
      { kind: 'filter', name: 'A|pipe', status: 'onlyLeft' },
      { kind: 'filter', name: 'B', status: 'onlyRight' },
      { kind: 'filter', name: 'C`tick', status: 'modified', aspects: ['Run If', 'If actions'] }
    ]
  }
};

test('compare markdown: summary table, only-in lists and the changed table', () => {
  const md = R.compareMarkdown(job, { generatedAt: new Date('2026-10-12T15:00:00Z') });
  assert.match(md, /^# Workflow compare: Dev vs Prod/);
  assert.match(md, /\*\*Generated:\*\* 2026-10-12 15:00:00 UTC/);
  assert.match(md, /\*\*Scope:\*\* form `HPD:Help Desk`/);
  assert.match(md, /\*\*Excluded:\*\* `zSLMGen:\*`/);
  assert.match(md, /\| Filters \| 10 \| 9 \| 2 \| 1 \| 1 \| 6 \| 3 \|/);
  assert.match(md, /## Only in Dev \(1\)/);
  assert.match(md, /## Only in Prod \(1\)/);
  assert.match(md, /\| Filter \| `` C`tick `` \| Run If, If actions \|/, 'backticks in names do not break the code span');
});

test('compare markdown: details are fenced safely and truncation is stated', () => {
  const details = new Map([['filter:C`tick', { changes: [
    { aspect: 'Run If', kind: 'changed', left: "'Status' = 4\n```evil```", right: "'Status' = 5" },
    { aspect: 'If action 1', kind: 'removed', left: 'Set Fields', right: null }
  ] }]]);
  details.truncated = true;
  const md = R.compareMarkdown(job, { details });
  assert.match(md, /## Details/);
  assert.match(md, /### Filter: C`tick/);
  assert.match(md, /````\n'Status' = 4\n```evil```\n````/, 'fence is longer than any backtick run inside');
  assert.match(md, /— not present —/);
  assert.match(md, /first 1 different objects only/);
});

test('compare csv: BOM, quoting and one row per object', () => {
  const out = R.compareCsv(job);
  assert.equal(out.charCodeAt(0), 0xFEFF);
  const lines = out.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'Kind,Object,Status,What changed');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^Filter,C`tick,Different,Run If; If actions$/);
  assert.equal(R.csv([['a,b', 'c"d', 'e\nf']]).slice(1), '"a,b","c""d","e\nf"\r\n');
});

const layout = {
  view: { name: 'SV_Edit', label: 'SV_Edit' },
  summary: { left: 4, right: 4, onlyLeft: 1, onlyRight: 0, modified: 1, same: 2, reordered: 3 },
  views: { onlyLeft: [{ name: 'NewSV_Edit__c', label: 'NewSV_Edit__c' }], onlyRight: [] },
  items: [
    { id: 1, name: 'Billing Type', label: 'Billing Type', type: 'Selection', status: 'onlyLeft', aspects: [], left: {}, right: null },
    {
      id: 2, name: 'Description', label: 'Description', type: 'Character', status: 'modified', aspects: ['Size', 'Label'],
      left: { label: 'Description', box: { x: 0, y: 0, w: 100, h: 50 } },
      right: { label: 'Desc.', box: { x: 0, y: 0, w: 100, h: 20 } }
    }
  ]
};

test('layout markdown: views on one side, only-here fields and changed values', () => {
  const md = R.layoutMarkdown(layout, { form: 'HPD:Help Desk', left: 'Dev', right: 'Prod', generatedAt: new Date('2026-10-12T15:00:00Z') });
  assert.match(md, /^# Form layout compare: HPD:Help Desk/);
  assert.match(md, /\| 4 \| 4 \| 1 \| 1 \| 0 \| 2 \| 3 \|/);
  assert.match(md, /`NewSV_Edit__c` — only on Dev/);
  assert.match(md, /## Only on Dev \(1\)/);
  assert.match(md, /\| `Description` \| 2 \| Size \| 100 × 50 \| 100 × 20 \|/);
  assert.match(md, /\|  \|  \| Label \| Description \| Desc\. \|/);
  const c = R.layoutCsv(layout, { left: 'Dev', right: 'Prod' }).slice(1).trim().split('\r\n');
  assert.equal(c.length, 4);
  assert.equal(c[1], 'Billing Type,1,Selection,Only on Dev,,,');
});

const recent = {
  since: '2026-10-05T00:00:00.000Z', kinds: ['filter'], form: null,
  byUser: { nfoy: 2, vphanindra: 1 },
  rows: [
    { kind: 'filter', name: 'NN:Thing', changedAt: '2026-10-12T04:55:08.000Z', changedBy: 'nfoy', enabled: true, primaryForm: 'HPD:Help Desk', formCount: 3, owner: 'Remedy', application: null },
    { kind: 'filter', name: 'Old', changedAt: '2026-10-06T10:00:00.000Z', changedBy: 'vphanindra', enabled: false, primaryForm: null, formCount: 0, owner: null, application: 'Remedy ITSM' }
  ]
};

test('recent changes: markdown has the per-person tally and the changes table', () => {
  const md = R.recentMarkdown(recent, { instance: 'Dev', generatedAt: new Date('2026-10-12T15:00:00Z') });
  assert.match(md, /^# Recent workflow changes: Dev/);
  assert.match(md, /\| nfoy \| 2 \|/);
  assert.match(md, /\| 2026-10-12 04:55:08 UTC \| nfoy \| Filter \| `NN:Thing` \| HPD:Help Desk \(\+2\) \| Yes \|/);
  assert.match(md, /\| Old \| No \|\n/.test(md) ? /x/ : /`Old`/);
  assert.match(R.recentMarkdown({ ...recent, rows: [] }, { instance: 'Dev' }), /Nothing changed in this window/);
  const c = R.recentCsv(recent).slice(1).trim().split('\r\n');
  assert.equal(c[0], 'Changed at (UTC),Changed by,Kind,Object,Primary form,Forms,Enabled,Owner,Application');
  assert.equal(c[2], '2026-10-06T10:00:00.000Z,vphanindra,Filter,Old,,0,No,,Remedy ITSM');
});

test('slug keeps file names safe', () => {
  assert.equal(R.slug('workflow-compare_Dev-vs-Prod_HPD:Help Desk'), 'workflow-compare_Dev-vs-Prod_HPD-Help-Desk');
  assert.equal(R.slug('../../etc/passwd'), 'etc-passwd');
  assert.equal(R.slug(''), 'report');
});
