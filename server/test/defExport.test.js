const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/defExport');

test('items are validated, trimmed and de-duplicated', () => {
  const out = D.normalizeItems([
    { kind: 'filter', name: ' A ' }, { kind: 'filter', name: 'A' }, { kind: 'activeLink', name: 'A' }
  ]);
  assert.deepEqual(out, [{ kind: 'filter', name: 'A' }, { kind: 'activeLink', name: 'A' }]);
  for (const bad of [[], null, [{ kind: 'nope', name: 'x' }], [{ kind: 'filter', name: '  ' }], [{ kind: 'filter' }]]) {
    assert.throws(() => D.normalizeItems(bad), (e) => e.status === 400);
  }
  const many = Array.from({ length: D.MAX_OBJECTS + 1 }, (_, i) => ({ kind: 'filter', name: `F${i}` }));
  assert.throws(() => D.normalizeItems(many), (e) => e.status === 400 && /Narrow the selection/.test(e.message));
});

test('ordering is stable: forms first, then workflow by kind and name', () => {
  const sorted = D.sortItems([
    { kind: 'filter', name: 'b' }, { kind: 'escalation', name: 'z' }, { kind: 'form', name: 'F' },
    { kind: 'activeLink', name: 'a' }, { kind: 'filter', name: 'a' }
  ]);
  assert.deepEqual(sorted.map((i) => `${i.kind}:${i.name}`), ['form:F', 'activeLink:a', 'filter:a', 'filter:b', 'escalation:z']);
});

test('large exports are split into files of PART_SIZE objects, each named so they sort together', () => {
  const items = Array.from({ length: D.PART_SIZE * 2 + 1 }, (_, i) => ({ kind: 'filter', name: `F${i}` }));
  const parts = D.chunk(items);
  assert.deepEqual(parts.map((p) => p.length), [D.PART_SIZE, D.PART_SIZE, 1]);
  assert.equal(D.partFileName('Dev_x', 'def', 0, 1), 'Dev_x.def');
  assert.equal(D.partFileName('Dev_x', 'xml', 1, 3), 'Dev_x-part2of3.xml');
  assert.deepEqual(D.toHelperItems([{ kind: 'activeLink', name: 'A' }, { kind: 'form', name: 'F' }]),
    [{ type: 6, name: 'A' }, { type: 1, name: 'F' }]);
});

const info = {
  source: 'Dev', target: 'Prod', scope: 'Compare of form HPD:Help Desk: objects only on Dev', format: 'def',
  files: [{ name: 'Dev_x.def', count: 3 }],
  items: [{ kind: 'filter', name: 'F1' }, { kind: 'activeLink', name: 'A1' }, { kind: 'activeLink', name: 'A`2' }],
  attachedForms: ['HPD:Help Desk', 'AST:ComputerSystem_Combined'], referencedForms: ['CTM:People'],
  generatedAt: new Date('2026-10-14T13:00:00Z')
};

test('manifest names the source, target, files, objects and what is missing on the target', () => {
  const md = D.manifestMarkdown({ ...info, targetForms: new Set(['HPD:Help Desk', 'CTM:People']) });
  assert.match(md, /^# Definition export from Dev/);
  assert.match(md, /\*\*Generated:\*\* 2026-10-14 13:00:00 UTC/);
  assert.match(md, /\*\*Intended target:\*\* Prod/);
  assert.match(md, /`Dev_x\.def` — 3 objects/);
  assert.match(md, /\*\*Active Links \(2\)\*\*/);
  assert.match(md, /- `A'2`/, 'backticks in names cannot break the markdown');
  assert.match(md, /3 forms involved; 2 exist on Prod, \*\*1 do not\*\*/);
  assert.match(md, /Missing on Prod[\s\S]*- `AST:ComputerSystem_Combined` — attached to\n/);
  assert.match(md, /Used by actions and qualifications \(1\)[\s\S]*- `CTM:People`/);
  assert.match(md, /<details><summary>Forms the objects are attached to \(2\)<\/summary>/);
  assert.match(md, /produced read-only/);
});

test('without a target the manifest lists the forms and says they were not checked', () => {
  const md = D.manifestMarkdown({ ...info, target: null, targetForms: null });
  assert.match(md, /3 forms involved\. Not checked against a target/);
  assert.doesNotMatch(md, /Intended target/);
  assert.match(md, /- `CTM:People`/);
  assert.match(D.manifestMarkdown({ ...info, attachedForms: [], referencedForms: [] }), /_None found\._/);
});

test('definitions are counted from the file itself, overlays separately', () => {
  const text = [
    'char-set: UTF-8', '#', 'begin active link', '   name           : A', '   owner : x', 'end',
    'begin active link', '   name           : A__o', 'end',
    'begin filter', '   name           : F', '   field-name : not-a-top-level-name', 'end'
  ].join('\n');
  assert.deepEqual(D.countDefinitions(text), { total: 3, overlays: 1 });
  assert.deepEqual(D.countDefinitions(''), { total: 0, overlays: 0 });

  const md = D.manifestMarkdown({ ...info, definitions: { total: 4, overlays: 1 }, items: info.items.slice(0, 3) });
  assert.match(md, /4 definitions in total for 3 objects requested/);
  assert.match(md, /1 of them is an overlay object \(named `…__o`\)/);
});
