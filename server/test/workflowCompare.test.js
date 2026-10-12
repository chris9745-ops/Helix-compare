const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/workflowCompare');

const filter = (over = {}) => ({
  name: 'F', enable: true, order: 10, opSet: 6, formList: ['A', 'B'], owner: 'Remedy', properties: {},
  qualifier: { op: 'rel', rel: 1, l: { t: 99, v: 7 }, r: { t: 2, v: { dt: 6, v: 4 } } },
  actionList: [{ _type: 'RunProcessAction', commandLine: 'x' }], elseList: [], permissions: [],
  lastUpdateTime: { value: 1 }, lastChangedBy: 'a', key: 'k1', diary: [], changeFlags: { x: 1 }, ...over
});

test('deployment metadata does not make an object "modified"', () => {
  const a = C.fingerprint(filter());
  const b = C.fingerprint(filter({ lastUpdateTime: { value: 999 }, lastChangedBy: 'someone', key: 'k2', diary: [{ x: 1 }] }));
  assert.deepEqual(C.changedAspects(a, b), []);
});

test('order of forms and groups is irrelevant; order of actions is not', () => {
  const base = C.fingerprint(filter({ groupList: [1, 2] }));
  assert.deepEqual(C.changedAspects(base, C.fingerprint(filter({ formList: ['B', 'A'], groupList: [2, 1] }))), []);
  const two = [{ _type: 'A', n: 1 }, { _type: 'A', n: 2 }];
  assert.deepEqual(
    C.changedAspects(C.fingerprint(filter({ actionList: two })), C.fingerprint(filter({ actionList: [...two].reverse() }))),
    ['If actions']
  );
});

test('object key order does not matter (map iteration order differs between servers)', () => {
  const a = C.fingerprint(filter({ properties: { 90002: { dt: 4, v: 'x' }, 1: { dt: 2, v: 1 } } }));
  const b = C.fingerprint(filter({ properties: { 1: { dt: 2, v: 1 }, 90002: { v: 'x', dt: 4 } } }));
  assert.deepEqual(C.changedAspects(a, b), []);
});

test('changed aspects are reported with readable labels', () => {
  const a = C.fingerprint(filter());
  const b = C.fingerprint(filter({
    enable: false, order: 11, opSet: 2,
    qualifier: { op: 'rel', rel: 6, l: { t: 99, v: 7 }, r: { t: 2, v: { dt: 6, v: 4 } } }
  }));
  assert.deepEqual(C.changedAspects(a, b).sort(), ['Enabled', 'Execute on', 'Order', 'Run If']);
});

test('compareFingerprints splits only-left, only-right, modified and identical', () => {
  const left = new Map([['same', C.fingerprint(filter())], ['mod', C.fingerprint(filter())], ['devOnly', C.fingerprint(filter())]]);
  const right = new Map([['same', C.fingerprint(filter())], ['mod', C.fingerprint(filter({ order: 99 }))], ['prodOnly', C.fingerprint(filter())]]);
  const r = C.compareFingerprints(left, right);
  assert.deepEqual(r.onlyLeft, ['devOnly']);
  assert.deepEqual(r.onlyRight, ['prodOnly']);
  assert.deepEqual(r.modified, [{ name: 'mod', aspects: ['Order'] }]);
  assert.equal(r.same, 1);
});

test('action diff aligns on content, so an inserted action is one addition, not a cascade', () => {
  const act = (label) => ({ label, lines: [`line of ${label}`] });
  const left = [act('one'), act('two'), act('three')];
  const right = [act('one'), act('inserted'), act('two'), act('three')];
  const d = C.diffActions('If action', left, right);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'added');
  assert.match(d[0].right, /inserted/);

  const changed = C.diffActions('If action', [act('one'), act('two')], [act('one'), { label: 'two', lines: ['different'] }]);
  assert.deepEqual(changed.map((c) => c.kind), ['changed']);
  assert.equal(changed[0].aspect, 'If action 2');
  assert.deepEqual(C.diffActions('If action', [act('x')], []).map((c) => c.kind), ['removed']);
});

test('changesBetween reports scalar, form-list and action differences', () => {
  const side = (over) => ({
    enabled: true, order: 10, executeOn: ['Modify'], schedule: null, runIf: "'Status' = 4", owner: 'Remedy',
    helpText: null, forms: ['A', 'B'], actions: [{ label: 'Set', lines: ['x'] }], elseActions: [], ...over
  });
  const ch = C.changesBetween(side(), side({
    enabled: false, runIf: "'Status' = 5", forms: ['A', 'C'], actions: [{ label: 'Set', lines: ['y'] }]
  }));
  const by = Object.fromEntries(ch.map((c) => [c.aspect, c]));
  assert.equal(by.Enabled.left, 'Enabled');
  assert.equal(by.Enabled.right, 'Disabled');
  assert.equal(by['Run If'].right, "'Status' = 5");
  assert.match(by.Forms.left, /B/);
  assert.match(by.Forms.right, /C/);
  assert.equal(by['If action 1'].kind, 'changed');
  assert.deepEqual(C.changesBetween(null, side()), []);
});

test('name patterns: * is a wildcard (anchored), otherwise a case-insensitive substring', () => {
  const m = C.matcher('HPD:INC:*');
  assert.equal(m('HPD:INC:Resolve'), true);
  assert.equal(m('xHPD:INC:Resolve'), false);
  assert.equal(C.matcher('*_100')('HPD:INC:Foo_100'), true);
  assert.equal(C.matcher('resolve')('HPD:INC:Resolve_1'), true);
  assert.equal(C.matcher('a.c')('abc'), false, 'regex metacharacters are literal');
  assert.equal(C.matcher('   '), null);
});

test('property differences are listed by name, only for what actually differs', () => {
  const p = (id, name, value) => ({ id, name, value });
  const d = C.diffProperties(
    [p(60006, 'SCC_LOCKED_BY', '""'), p(60069, 'OVERLAY_EXTEND_MASK', '0'), p(60070, 'OVERLAY_INHERIT_MASK', '3')],
    [p(60006, 'SCC_LOCKED_BY', '""')]
  );
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'removed');   // present on the left only
  assert.equal(d[0].left, 'OVERLAY_EXTEND_MASK = 0\nOVERLAY_INHERIT_MASK = 3');
  assert.equal(d[0].right, null);
  assert.deepEqual(C.diffProperties([p(1, 'A', '1')], [p(1, 'A', '1')]), []);
  assert.equal(C.diffProperties([p(1, 'A', '1')], [p(1, 'A', '2')])[0].kind, 'changed');
});

test('exclude patterns: wildcard is anchored, plain text is a substring, blanks are ignored', () => {
  const ex = C.buildExcluder('zSLMGen:*\n  , *_Temp ,\n');
  assert.equal(ex('zSLMGen:SLM01201_MeasReqAssoc'), true);
  assert.equal(ex('HPD:zSLMGen:Foo'), false, 'anchored at the start');
  assert.equal(ex('HPD:Thing_Temp'), true);
  assert.equal(C.buildExcluder('   '), null);
  assert.equal(C.buildExcluder([]), null);
  assert.equal(C.buildExcluder(['legacy'])('Old_Legacy_Rule'), true, 'substring, case-insensitive');
});
