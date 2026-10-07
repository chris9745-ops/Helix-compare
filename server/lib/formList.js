// Parses a form list pasted from the Mid-Tier's "AR System Object List" screen
// (Name / Server / Type / …), which is the only place a full list of a server's
// forms can be seen — BMC's REST API has no "list all forms" call.
//
// Copying that table gives different text depending on browser and selection, and
// a select-all on the whole page drags in surrounding text too ("Logout", "Search",
// "Open New"…). So this accepts:
//   • names only, one per line
//   • tab-separated rows:  Name <TAB> Server <TAB> Type [<TAB> more columns…]
//   • one cell per line:   Name / Server / Type / [more…] / Name / Server / Type …
// with or without the header row, and ignores page text around the table.

const MAX_NAME_LENGTH = 254;        // AR System's own limit on object names
const CONTROL_CHARS = /[\u0000-\u001f]/;
const MIN_COLUMNS = 3;
const MAX_COLUMNS = 8;

const isHeaderCells = (cells) => /^name$/i.test(cells[0] || '') && /^server$/i.test(cells[1] || '');

// Index of a "Name, Server, Type" header laid out one cell per line, or -1.
function findHeaderLine(lines) {
  for (let i = 0; i + 2 < lines.length; i++) {
    if (isHeaderCells([lines[i], lines[i + 1]]) && /^type$/i.test(lines[i + 2])) return i;
  }
  return -1;
}

// The one-cell-per-line layout: the server is the 2nd cell of every record, so the
// same value reappears every `k` lines (k = number of columns, unknown — the table
// can have more than Name/Server/Type). Types vary (Form, Join, View…), so only
// the server is used to recognise it. Names-only input won't repeat like that.
function detectRecordLayout(lines) {
  const header = findHeaderLine(lines);
  for (let k = MIN_COLUMNS; k <= MAX_COLUMNS; k++) {
    const start = header >= 0 ? header + k : 0;
    const records = Math.floor((lines.length - start) / k);
    if (records < 2) continue;

    const server = lines[start + 1];
    if (server === lines[start]) continue;

    const sample = Math.min(records, 50);
    let matches = 0;
    for (let t = 0; t < sample; t++) {
      if (lines[start + k * t + 1] === server) matches++;
    }
    if (matches / sample >= 0.9) return { k, start, server };
  }
  return null;
}

function extractRows(lines) {
  // 1) Tab-separated table rows. Lines without tabs are page text around the table.
  const tabbed = lines.filter(l => l.includes('\t'));
  if (tabbed.length >= 2 && tabbed.length / lines.length >= 0.5) {
    return tabbed.map(l => l.split('\t').map(c => c.trim()));
  }

  // 2) One cell per line. Stop at the first record whose server differs: that's
  //    the end of the table and the start of trailing page text.
  const layout = detectRecordLayout(lines);
  if (layout) {
    const rows = [];
    for (let i = layout.start; i + layout.k <= lines.length; i += layout.k) {
      if (lines[i + 1] !== layout.server) break;
      rows.push([lines[i], lines[i + 1], lines[i + 2]]);
    }
    return rows;
  }

  // 3) A plain list of names (keep any cells so a lone header line is still recognised)
  return lines.map(l => l.split('\t').map(c => c.trim()));
}

function parseFormList(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const found = new Map();
  let skipped = 0;
  for (const cells of extractRows(lines)) {
    if (isHeaderCells(cells)) continue;
    const name = cells[0];
    const type = cells.length >= 3 ? cells[2] : '';
    if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARS.test(name)) { skipped++; continue; }
    if (!found.has(name)) found.set(name, type);
  }

  const forms = [...found].map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { forms, skipped };
}

// Stored as one compact string (Firestore can't hold nested arrays, and one
// string keeps the document small): "name<TAB>type" per line.
function serializeFormList(forms) {
  return forms.map(f => `${f.name}\t${f.type || ''}`).join('\n');
}

function deserializeFormList(text) {
  return String(text || '').split('\n').filter(Boolean).map(line => {
    const [name, type = ''] = line.split('\t');
    return { name, type };
  });
}

module.exports = { parseFormList, serializeFormList, deserializeFormList };
