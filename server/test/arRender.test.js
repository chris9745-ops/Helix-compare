const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/arRender');

const ctx = (names = {}) => ({
  primaryForm: 'HPD:Help Desk',
  fields: (form, id) => (names[form] || {})[id] || null
});
const rel = (op, l, r) => ({ op: 'rel', rel: op, l, r });
const cur = (id, t = 99) => ({ t, v: id });
const val = (dt, v) => ({ t: 2, v: { dt, v } });

test('qualifiers: fields, operators, values and keywords', () => {
  const c = ctx({ 'HPD:Help Desk': { 7: 'Status', 8: 'Short Description' } });
  const q = { op: 'and', l: rel(1, cur(7), val(6, 4)), r: rel(7, cur(8), val(4, 'DB%')) };
  assert.equal(R.renderQualifier(q, c), `'Status' = 4 AND 'Short Description' LIKE "DB%"`);
  assert.equal(R.renderQualifier(rel(1, val(1, 1), val(4, 'x')), c), '$USER$ = "x"');
  assert.equal(R.renderQualifier(rel(6, cur(8), val(0, null)), c), `'Short Description' != $NULL$`);
  assert.equal(R.renderQualifier(null, c), '');
});

test('qualifiers: parentheses only where AND/OR mix; NOT wraps', () => {
  const a = rel(1, cur(7), val(6, 1)), b = rel(1, cur(7), val(6, 2)), d = rel(1, cur(8), val(4, 'z'));
  const c = ctx({ 'HPD:Help Desk': { 7: 'S', 8: 'D' } });
  assert.equal(R.renderQualifier({ op: 'and', l: { op: 'and', l: a, r: b }, r: d }, c), `'S' = 1 AND 'S' = 2 AND 'D' = "z"`);
  assert.equal(R.renderQualifier({ op: 'and', l: { op: 'or', l: a, r: b }, r: d }, c), `('S' = 1 OR 'S' = 2) AND 'D' = "z"`);
  assert.equal(R.renderQualifier({ op: 'not', x: a }, c), `NOT ('S' = 1)`);
});

test('unresolved field ids fall back to core names, then #id', () => {
  const c = ctx();
  assert.equal(R.renderQualifier(rel(1, cur(7), val(6, 1)), c), `'Status' = 1`);
  assert.equal(R.renderQualifier(rel(1, cur(999), val(6, 1)), c), `'#999' = 1`);
});

test('transaction and database field references', () => {
  const c = ctx({ 'HPD:Help Desk': { 7: 'Status' } });
  assert.equal(R.renderQualifier(rel(6, cur(7), cur(7, 51)), c), `'Status' != 'DB.Status'`);
  assert.equal(R.renderQualifier(rel(1, cur(7), cur(7, 50)), c), `'Status' = 'TR.Status'`);
});

test('inside actions, type-1 fields belong to the other form and type-99 are read from the current record', () => {
  const c = ctx({ 'HPD:Help Desk': { 8: 'Short Description' }, 'CTM:Support Group': { 1: 'Group' } });
  const q = rel(1, cur(1, 1), cur(8, 99));
  assert.equal(R.renderQualifier(q, c, { topLevel: false, otherForm: 'CTM:Support Group' }), `'Group' = $Short Description$`);
});

test('assignments: value, field lookup, process, arithmetic, function, SQL', () => {
  const c = ctx({ 'HPD:Help Desk': { 8: 'Short Description' }, 'CTM:Support Group': { 5: 'Name' } });
  assert.equal(R.renderAssign({ assignType: 1, value: { dt: 4, v: 'a"b' } }, c), '"a\\"b"');
  assert.equal(R.renderAssign({ assignType: 3, process: 'Application-Foo 1' }, c), '$PROCESS$ Application-Foo 1');
  assert.equal(R.renderAssign({ assignType: 2, field: { form: '@', fieldId: 8 } }, c), '$Short Description$');
  assert.equal(R.renderAssign({ assignType: 2, field: { form: '*', fieldId: 8 } }, c), '$Short Description$');
  assert.equal(
    R.renderAssign({ assignType: 2, field: { form: 'CTM:Support Group', fieldId: 5, qualifier: rel(1, cur(5, 1), cur(8, 99)) } }, c),
    `'CTM:Support Group'.'Name' WHERE 'Name' = $Short Description$`
  );
  assert.equal(R.renderAssign({
    assignType: 4, arithOp: { operation: 1, operandLeft: { assignType: 1, value: { dt: 2, v: 1 } }, operandRight: { assignType: 1, value: { dt: 2, v: 2 } } }
  }, c), '(1 + 2)');
  assert.equal(R.renderAssign({
    assignType: 5, function: { functionCode: 14, parameterList: [{ assignType: 2, field: { form: '@', fieldId: 8 } }] }
  }, c), 'UPPER($Short Description$)');
  assert.match(R.renderAssign({ assignType: 7, sql: { sqlCommand: 'SELECT 1' } }, c), /^SQL: SELECT 1/);
});

test('actions: messages, process, guide, goto and unknown types', () => {
  const c = ctx();
  const msg = R.describeAction({ _type: 'FilterMessageAction', messageType: 2, messageNum: 12, messageText: 'Nope' }, c);
  assert.equal(msg.label, 'Message — Error #12');
  assert.deepEqual(msg.lines, ['Nope']);
  assert.equal(R.describeAction({ _type: 'CallGuideAction', guideName: 'G1', serverName: '@' }, c).label, `Call Guide 'G1'`);
  assert.equal(R.describeAction({ _type: 'GotoAction', tag: 2, fieldIdOrValue: 999 }, c).label, 'Goto — execution order 999');
  assert.equal(R.describeAction({ _type: 'RunProcessAction', commandLine: 'PERFORM-ACTION-X' }, c).lines[0], 'PERFORM-ACTION-X');
  const unknown = R.describeAction({ _type: 'BrandNewAction', foo: 1 }, c);
  assert.equal(unknown.label, 'BrandNewAction');
  assert.match(unknown.lines[0], /"foo":1/);
});

test('object description: execute-on bits, schedule, application, timestamp', () => {
  const al = R.describeObject('activeLink', { name: 'A', executeMask: 1 | 16 | 16384, enable: true, formList: ['F'], actionList: [], elseList: [] }, ctx());
  assert.deepEqual(al.executeOn, ['Button/Menu Item', 'Display', 'Window Open']);
  const f = R.describeObject('filter', { name: 'F', opSet: 2 | 4, formList: ['F'], actionList: [], elseList: [] }, ctx());
  assert.deepEqual(f.executeOn, ['Modify', 'Submit']);
  const e = R.describeObject('escalation', {
    name: 'E', enable: false, formList: ['F'], actionList: [], elseList: [],
    escalationTm: { _type: 'EscalationInterval', days: 0, hours: 0, minutes: 5, value: 300 },
    lastUpdateTime: { value: 1587576885 }, properties: { 90002: { dt: 4, v: 'Remedy ITSM' } }
  }, ctx());
  assert.equal(e.schedule, 'Every 5m');
  assert.equal(e.enabled, false);
  assert.equal(e.application, 'Remedy ITSM');
  assert.equal(e.lastChanged, '2020-04-22T17:34:45.000Z');
  assert.equal(R.describeSchedule({ _type: 'EscalationTime', hours: '{2}', minute: 0, weekDayMask: 0b0111110, allMonthDays: false }),
    'At 2:00 — Mon, Tue, Wed, Thu, Fri');
});

test('referencedForms skips the (possibly huge) formList but keeps the primary form', () => {
  const forms = R.referencedForms({
    primaryForm: 'A', formList: ['A', 'B', 'C'],
    actionList: [{ _type: 'PushFieldsAction', pushToForm: 'X', pushFieldsList: [{ field: { form: 'Y', fieldId: 1 } }] },
      { _type: 'OpenWindowAction', formName: 'W', serverName: '@' }]
  }).sort();
  assert.deepEqual(forms, ['A', 'W', 'X', 'Y']);
});
