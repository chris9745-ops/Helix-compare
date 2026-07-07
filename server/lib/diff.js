// ── Generic diff engine ─────────────────────────────────────────────────────
// Matches two lists of records by a key field and classifies each key as
// added (right only), removed (left only), modified (both, fields differ),
// or unchanged.

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
  return false;
}

function fieldsToCompare(left, right, fields) {
  const keys = fields && fields.length
    ? fields
    : Array.from(new Set([...Object.keys(left || {}), ...Object.keys(right || {})]));
  const diffs = [];
  for (const k of keys) {
    if (k === '_entryId') continue;
    const lv = left?.[k];
    const rv = right?.[k];
    if (!deepEqual(lv, rv)) diffs.push({ field: k, left: lv, right: rv });
  }
  return diffs;
}

function diffByKey(leftItems, rightItems, keyField, compareFields) {
  const leftMap = new Map(leftItems.filter(i => i?.[keyField] != null).map(i => [i[keyField], i]));
  const rightMap = new Map(rightItems.filter(i => i?.[keyField] != null).map(i => [i[keyField], i]));

  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];

  for (const [key, leftItem] of leftMap) {
    const rightItem = rightMap.get(key);
    if (!rightItem) {
      removed.push({ key, left: leftItem });
      continue;
    }
    const fieldDiffs = fieldsToCompare(leftItem, rightItem, compareFields);
    if (fieldDiffs.length) {
      modified.push({ key, left: leftItem, right: rightItem, fieldDiffs });
    } else {
      unchanged.push({ key, left: leftItem, right: rightItem });
    }
  }
  for (const [key, rightItem] of rightMap) {
    if (!leftMap.has(key)) added.push({ key, right: rightItem });
  }

  return {
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      unchanged: unchanged.length
    },
    added, removed, modified, unchanged
  };
}

// Recursive field-path diff for two full definitions (e.g. two active links).
function deepDiff(left, right, prefix = '') {
  const diffs = [];
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const k of keys) {
    if (k === '_entryId') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const lv = left?.[k];
    const rv = right?.[k];
    const bothPlainObjects =
      lv && rv && typeof lv === 'object' && typeof rv === 'object' && !Array.isArray(lv) && !Array.isArray(rv);
    if (bothPlainObjects) {
      diffs.push(...deepDiff(lv, rv, path));
    } else if (!deepEqual(lv, rv)) {
      diffs.push({ path, left: lv, right: rv });
    }
  }
  return diffs;
}

module.exports = { diffByKey, deepDiff, deepEqual };
