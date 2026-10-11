const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/arLayout');

const raw = (id, name, dt, props) => ({ id, name, dt, type: 1, props });
const pt = (x, y) => ({ xCoordinate: x, yCoordinate: y });

test('boxOf: bounding box of corner points', () => {
  assert.deepEqual(L.boxOf([pt(33520, 7000), pt(66365, 9100)]), { x: 33520, y: 7000, w: 32845, h: 2100 });
  assert.deepEqual(L.boxOf([pt(10, 30), pt(0, 5)]), { x: 0, y: 5, w: 10, h: 25 }, 'order of points does not matter');
  assert.equal(L.boxOf([]), null);
  assert.equal(L.boxOf(undefined), null);
});

test('views: base views first, labelled from the display property', () => {
  const v = L.normalizeViews([
    { id: 2, name: 'Z_fr', locale: 'fr', props: { 20: { v: 'Zebra' } } },
    { id: 1, name: 'B', locale: '', props: { 20: { v: 'Beta' } } },
    { id: 3, name: 'A', locale: '', props: {} },
    { id: 4, name: 'Broken', locale: '', error: 'boom' }
  ]);
  assert.deepEqual(v.map((x) => x.id), [3, 1, 2]);
  assert.equal(v[0].label, 'A', 'falls back to the name');
  assert.equal(v[1].label, 'Beta');
  assert.equal(v[2].isBase, false);
});

test('fields: only those on the view, with decoded type, visibility and parent', () => {
  const f = L.normalizeFields([
    raw(1, 'Status', 6, {
      3: { dt: 41, v: [pt(0, 0), pt(100, 20)] }, 4: { dt: 6, v: 0 }, 5: { dt: 6, v: 1 }, 20: { dt: 4, v: 'Status*' },
      170: { dt: 40, v: 0 }, 143: { dt: 40, v: 7 }
    }),
    raw(2, 'Elsewhere', 4, null),
    raw(3, 'Col', 34, { 4: { dt: 6, v: 1 } })
  ]);
  assert.equal(f.length, 2);
  assert.deepEqual(
    { type: f[0].type, visible: f[0].visible, access: f[0].access, parent: f[0].parent, label: f[0].label, tab: f[0].tabOrder },
    { type: 'Selection', visible: false, access: 'Read only', parent: 0, label: 'Status*', tab: 7 }
  );
  assert.deepEqual(f[0].box, { x: 0, y: 0, w: 100, h: 20 });
  assert.equal(f[1].parent, null, 'no display parent = not placed');
  assert.equal(f[1].box, null);
});

test('moved and resized are told apart; unchanged fields are not listed', () => {
  const base = { id: 1, name: 'A', label: 'A', visible: true, access: 'Read/Write', parent: 0, tabOrder: 1, zOrder: 1,
    box: { x: 0, y: 0, w: 10, h: 10 }, labelBox: null, dataBox: null };
  assert.deepEqual(L.fieldChanges(base, { ...base }), []);
  assert.deepEqual(L.fieldChanges(base, { ...base, box: { x: 5, y: 0, w: 10, h: 10 } }), ['Position']);
  assert.deepEqual(L.fieldChanges(base, { ...base, box: { x: 0, y: 0, w: 20, h: 10 } }), ['Size']);
  assert.deepEqual(
    L.fieldChanges(base, { ...base, label: 'B', visible: false, parent: 9, tabOrder: 2 }).sort(),
    ['Container', 'Label', 'Tab order', 'Visibility']
  );
});

test('compareLayouts splits modified / only-left / only-right / same', () => {
  const f = (id, over = {}) => ({ id, name: `F${id}`, label: `F${id}`, type: 'Character', visible: true, access: null,
    parent: 0, tabOrder: id, zOrder: null, box: { x: 0, y: id, w: 1, h: 1 }, labelBox: null, dataBox: null, ...over });
  const r = L.compareLayouts([f(1), f(2), f(3)], [f(1), f(2, { label: 'New' }), f(4)]);
  assert.deepEqual(r.summary, { left: 3, right: 3, onlyLeft: 1, onlyRight: 1, modified: 1, same: 1, reordered: 0 });
  assert.deepEqual(r.items.map((i) => [i.id, i.status]), [[2, 'modified'], [3, 'onlyLeft'], [4, 'onlyRight']]);
  assert.deepEqual(r.items[0].aspects, ['Label']);
});

test('findViewByName prefers the base view over a translated copy', () => {
  const views = [{ id: 2, name: 'V', locale: 'fr', isBase: false }, { id: 1, name: 'V', locale: '', isBase: true }];
  assert.equal(L.findViewByName(views, 'V').id, 1);
  assert.equal(L.findViewByName(views, 'nope'), null);
});

test('a field whose only difference is stacking order is counted apart, not listed', () => {
  const f = (z) => ({ id: 1, name: 'A', label: 'A', type: 'Character', visible: true, access: null, parent: 0,
    tabOrder: 1, zOrder: z, box: { x: 0, y: 0, w: 1, h: 1 }, labelBox: null, dataBox: null });
  const r = L.compareLayouts([f(1)], [f(9)]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.summary, { left: 1, right: 1, onlyLeft: 0, onlyRight: 0, modified: 0, same: 0, reordered: 1 });
  // …but it is still reported when something else changed too
  const g = { ...f(9), label: 'B' };
  assert.deepEqual(L.compareLayouts([f(1)], [g]).items[0].aspects.sort(), ['Label', 'Stacking order']);
});
