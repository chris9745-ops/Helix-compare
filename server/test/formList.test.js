const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFormList, serializeFormList, deserializeFormList } = require('../lib/formList');

const names = (r) => r.forms.map(f => f.name);

test('names only, one per line', () => {
  const r = parseFormList('HPD:Help Desk\nCTM:People\r\n\nCTM:Support Group\n');
  assert.deepEqual(names(r), ['CTM:People', 'CTM:Support Group', 'HPD:Help Desk']);
});

test('tab-separated rows with the Name/Server/Type header (a typical copy from the table)', () => {
  const text = [
    'Name\tServer\tType',
    'AAS:SV_Union_WorkInfo_SocialEvents\tonbmc-s\tForm',
    'ABYD:Additional Data\tonbmc-s\tForm',
    'Abydos Sample Form\tonbmc-s\tForm'
  ].join('\n');
  const r = parseFormList(text);
  assert.deepEqual(r.forms, [
    { name: 'AAS:SV_Union_WorkInfo_SocialEvents', type: 'Form' },
    { name: 'ABYD:Additional Data', type: 'Form' },
    { name: 'Abydos Sample Form', type: 'Form' }
  ]);
});

test('one cell per line (Name / Server / Type repeating), with and without the header', () => {
  const cells = ['AAS:Foo', 'onbmc-s', 'Form', 'ABYD:Bar', 'onbmc-s', 'Join', 'CTM:Baz', 'onbmc-s', 'Form'];
  const withHeader = parseFormList(['Name', 'Server', 'Type', ...cells].join('\n'));
  const without = parseFormList(cells.join('\n'));
  for (const r of [withHeader, without]) {
    assert.deepEqual(r.forms, [
      { name: 'AAS:Foo', type: 'Form' }, { name: 'ABYD:Bar', type: 'Join' }, { name: 'CTM:Baz', type: 'Form' }
    ]);
  }
  assert.ok(!names(withHeader).includes('onbmc-s'), 'the server column must not become form names');
});

test('names-only input is not mistaken for 3-line records', () => {
  const r = parseFormList(['A:One', 'B:Two', 'C:Three', 'D:Four', 'E:Five', 'F:Six', 'G:Seven'].join('\n'));
  assert.equal(r.forms.length, 7);
});

test('de-duplicates, keeps names with spaces, ignores blanks, sorts case-insensitively', () => {
  const r = parseFormList('zeta form\nAlpha:One\nAlpha:One\n   \nBeta Form');
  assert.deepEqual(names(r), ['Alpha:One', 'Beta Form', 'zeta form']);
});

test('skips junk lines (too long / control characters) and counts them', () => {
  const r = parseFormList(['Good:Form', 'x'.repeat(300), 'bad\u0001name'].join('\n'));
  assert.deepEqual(names(r), ['Good:Form']);
  assert.equal(r.skipped, 2);
});

test('empty or missing input yields no forms', () => {
  assert.deepEqual(parseFormList('').forms, []);
  assert.deepEqual(parseFormList(undefined).forms, []);
  assert.deepEqual(parseFormList('Name\tServer\tType').forms, []);
});

const PAGE_TOP = ['AR System Object List', 'Logout', 'Search', 'Server', 'Application', 'Name', 'Search', 'Search Results',
  'Show Hidden', '6576 entries returned - 6576 matched', 'Preferences', 'Refresh'];
const PAGE_BOTTOM = ['Open New', 'Open Search', 'Open'];

test('a select-all on the whole page, 4 columns, one cell per line: only the table rows become forms', () => {
  const records = [];
  for (let i = 0; i < 40; i++) records.push(`FORM${i}:Name_${i}`, 'onbmc-s', i % 7 === 0 ? 'Join' : 'Form', 'Enabled');
  const text = [...PAGE_TOP, 'Name', 'Server', 'Type', 'Status', ...records, ...PAGE_BOTTOM].join('\n');

  const r = parseFormList(text);
  assert.equal(r.forms.length, 40);
  const all = names(r);
  for (const junk of ['Logout', 'Search', 'Open New', 'Open Search', 'Open', 'onbmc-s', 'Form', 'Enabled', 'Preferences']) {
    assert.ok(!all.includes(junk), `"${junk}" must not become a form name`);
  }
  assert.equal(r.forms.find(f => f.name === 'FORM0:Name_0').type, 'Join');
});

test('a select-all on the whole page, tab-separated rows: page text around the table is ignored', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `FORM${i}:Name_${i}\tonbmc-s\tForm\tEnabled`);
  const text = [...PAGE_TOP, 'Name\tServer\tType\tStatus', ...rows, ...PAGE_BOTTOM].join('\n');
  const r = parseFormList(text);
  assert.equal(r.forms.length, 30);
  assert.ok(!names(r).includes('Logout') && !names(r).includes('Open New'));
});

test('a table with 5 columns is recognised too', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(`F:${i}`, 'srv', 'Form', 'a', 'b');
  const r = parseFormList(['Name', 'Server', 'Type', 'C4', 'C5', ...records].join('\n'));
  assert.equal(r.forms.length, 10);
});

test('a short list of names that merely contains the word "Form" is still just names', () => {
  const r = parseFormList(['Form', 'Join', 'View', 'HPD:Help Desk'].join('\n'));
  assert.equal(r.forms.length, 4);
});

test('the full environment: 6,576 forms (hidden ones included) round-trip and fit one stored document', () => {
  const rows = Array.from({ length: 6576 }, (_, i) =>
    `PFX${i % 60}:Realistic_Looking_Form_Name_With_Some_Length_${i}\tonbmc-s\t${i % 9 === 0 ? 'Join' : 'Form'}\tEnabled`);
  const r = parseFormList(['Name\tServer\tType\tStatus', ...rows].join('\n'));
  assert.equal(r.forms.length, 6576);

  const stored = serializeFormList(r.forms);
  assert.deepEqual(deserializeFormList(stored), r.forms);
  assert.ok(Buffer.byteLength(stored) < 800 * 1024, `stored size ${Buffer.byteLength(stored)} bytes must stay under the 800 kB cap`);
});
