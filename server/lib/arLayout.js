/**
 * Form layout: turns the helper's raw view / field display properties into something a page can
 * draw and diff. Pure functions, no I/O.
 *
 * Raw field (from the helper): { id, name, dt, type, props } where `props` is the field's AR_DPROP_*
 * map for ONE view — { "3": { dt: 41, v: [ {xCoordinate, yCoordinate}, ... ] }, "20": { dt: 4, v: "Label" } }
 * — or null when the field isn't on that view.
 *
 * Coordinates are in the server's own units (≈ 1/1000 of an inch-ish; only ratios matter). A child's
 * box is relative to its parent container — except that children of a Page live in the *page holder's*
 * space (the page's own box is just where its tab body sits), which the page renders accordingly.
 */
const DPROP = {
  BBOX: 3, VISIBLE: 4, ENABLE: 5, Z_ORDER: 7, LABEL: 20, LABEL_BBOX: 21, TAB_ORDER: 143,
  DATA_BBOX: 151, DISPLAY_PARENT: 170, PAGE_ORDER: 180
};

// AR data types (AR_DATA_TYPE_*), as the field-type column a person would recognise
const TYPE_LABELS = {
  0: 'Null', 2: 'Integer', 3: 'Real', 4: 'Character', 5: 'Diary', 6: 'Selection', 7: 'Date/Time',
  8: 'Bitmask', 9: 'Bytes', 10: 'Decimal', 11: 'Attachment', 12: 'Currency', 13: 'Date', 14: 'Time',
  30: 'Join', 31: 'Trim', 32: 'Control', 33: 'Table', 34: 'Column', 35: 'Page', 36: 'Page Holder',
  37: 'Attachment Pool', 40: 'Unsigned Long', 41: 'Coords', 42: 'View', 43: 'Display'
};
const ACCESS_LABELS = { 1: 'Read only', 2: 'Read/Write', 3: 'Disabled' };
const CONTAINER_TYPES = new Set([33, 35, 36]);       // table, page, page holder

const prop = (f, id) => (f.props && f.props[id] ? f.props[id].v : undefined);

/** Bounding box of a list of AR coordinate points, or null. */
function boxOf(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const xs = points.map((p) => p.xCoordinate), ys = points.map((p) => p.yCoordinate);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Views, base views first (translated copies are listed after, tagged by locale). */
function normalizeViews(raw) {
  return (raw || [])
    .filter((v) => !v.error)
    .map((v) => {
      const label = v.props && v.props[20] && v.props[20].v;
      return { id: v.id, name: v.name, label: label || v.name, locale: v.locale || '', isBase: !v.locale };
    })
    .sort((a, b) => (Number(b.isBase) - Number(a.isBase)) || a.label.localeCompare(b.label) || a.locale.localeCompare(b.locale));
}

/** Fields that are actually on the view, normalised. Fields not on the view are dropped. */
function normalizeFields(raw) {
  return (raw || []).filter((f) => f.props).map((f) => {
    const parent = prop(f, DPROP.DISPLAY_PARENT);
    const visible = prop(f, DPROP.VISIBLE);
    const access = prop(f, DPROP.ENABLE);
    const label = prop(f, DPROP.LABEL);
    return {
      id: f.id,
      name: f.name,
      dataType: f.dt,
      type: TYPE_LABELS[f.dt] || `Type ${f.dt}`,
      container: CONTAINER_TYPES.has(f.dt),
      parent: Number.isFinite(parent) ? parent : null,   // 0 = top level of the view, null = not placed
      visible: visible === undefined ? null : visible !== 0,
      access: ACCESS_LABELS[access] || null,
      label: typeof label === 'string' ? label : null,
      box: boxOf(prop(f, DPROP.BBOX)),
      labelBox: boxOf(prop(f, DPROP.LABEL_BBOX)),
      dataBox: boxOf(prop(f, DPROP.DATA_BBOX)),
      tabOrder: Number.isFinite(prop(f, DPROP.TAB_ORDER)) ? prop(f, DPROP.TAB_ORDER) : null,
      zOrder: Number.isFinite(prop(f, DPROP.Z_ORDER)) ? prop(f, DPROP.Z_ORDER) : null
    };
  });
}

const sameBox = (a, b) => (!a && !b) || (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * Differences for one field present on both sides, as readable aspect labels. Position and size are
 * reported separately so "moved" and "resized" can be told apart.
 */
function fieldChanges(l, r) {
  const out = [];
  if (l.name !== r.name) out.push('Name');
  if ((l.label || '') !== (r.label || '')) out.push('Label');
  if (l.visible !== r.visible) out.push('Visibility');
  if (l.access !== r.access) out.push('Access');
  if (l.parent !== r.parent) out.push('Container');
  if (!sameBox(l.box, r.box)) {
    if (l.box && r.box && (l.box.x !== r.box.x || l.box.y !== r.box.y)) out.push('Position');
    if (l.box && r.box && (l.box.w !== r.box.w || l.box.h !== r.box.h)) out.push('Size');
    if (!l.box || !r.box) out.push('Position');
  }
  if (!sameBox(l.labelBox, r.labelBox)) out.push('Label placement');
  if (l.tabOrder !== r.tabOrder) out.push('Tab order');
  if (l.zOrder !== r.zOrder) out.push('Stacking order');
  return out;
}

/** left/right: normalized field arrays for the same view on two servers. */
function compareLayouts(left, right) {
  const L = new Map(left.map((f) => [f.id, f])), R = new Map(right.map((f) => [f.id, f]));
  const items = [];
  let same = 0, reordered = 0;
  for (const [id, l] of L) {
    const r = R.get(id);
    if (!r) { items.push({ id, name: l.name, label: l.label, type: l.type, status: 'onlyLeft', aspects: [], left: l, right: null }); continue; }
    const aspects = fieldChanges(l, r);
    // Stacking order is renumbered whenever fields are inserted, with no visible effect on its own —
    // count it separately rather than listing hundreds of fields that look identical on screen.
    if (aspects.length === 1 && aspects[0] === 'Stacking order') { reordered += 1; continue; }
    if (aspects.length) items.push({ id, name: l.name, label: l.label, type: l.type, status: 'modified', aspects, left: l, right: r });
    else same += 1;
  }
  for (const [id, r] of R) {
    if (!L.has(id)) items.push({ id, name: r.name, label: r.label, type: r.type, status: 'onlyRight', aspects: [], left: null, right: r });
  }
  const order = { modified: 0, onlyLeft: 1, onlyRight: 2 };
  items.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  return {
    summary: {
      left: left.length, right: right.length,
      onlyLeft: items.filter((i) => i.status === 'onlyLeft').length,
      onlyRight: items.filter((i) => i.status === 'onlyRight').length,
      modified: items.filter((i) => i.status === 'modified').length,
      same,
      reordered
    },
    items
  };
}

/** Pick the view with this internal name, preferring the base (non-translated) one. */
function findViewByName(views, name) {
  const matches = views.filter((v) => v.name === name);
  return matches.find((v) => v.isBase) || matches[0] || null;
}

module.exports = { DPROP, boxOf, normalizeViews, normalizeFields, fieldChanges, compareLayouts, findViewByName, TYPE_LABELS };
