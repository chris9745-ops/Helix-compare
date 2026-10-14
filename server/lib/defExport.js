/**
 * Definition export (.def / .xml): which objects, in how many files, and a manifest describing what
 * went into them and what they depend on. The files themselves come from the server's own export
 * (the format Dev Studio's Export and arexport produce); this module only decides what to ask for.
 * Pure functions, no I/O.
 */

// AR_STRUCT_ITEM_* codes the export call takes
const TYPE = { form: 1, filter: 5, activeLink: 6, charMenu: 8, escalation: 9, container: 12 };
const KIND_LABEL = { form: 'Form', filter: 'Filter', activeLink: 'Active Link', escalation: 'Escalation', charMenu: 'Menu', container: 'Container' };
const KIND_ORDER = ['form', 'activeLink', 'filter', 'escalation', 'charMenu', 'container'];

const MAX_OBJECTS = 5000;     // per request — beyond this the window is too wide to review or import sanely
const PART_SIZE = 500;        // objects per file; a .def with one header, importable on its own

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Validate and normalise [{kind,name}], dropping exact duplicates. */
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'Choose at least one object to export.');
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const kind = it && it.kind, name = it && typeof it.name === 'string' ? it.name.trim() : '';
    if (!TYPE[kind]) throw httpError(400, `Unknown object kind "${kind}". Use one of: ${Object.keys(TYPE).join(', ')}.`);
    if (!name) throw httpError(400, 'Every object needs a name.');
    const key = `${kind}\u0000${name}`;
    if (!seen.has(key)) { seen.add(key); out.push({ kind, name }); }
  }
  if (out.length > MAX_OBJECTS) {
    throw httpError(400, `${out.length.toLocaleString()} objects is more than one export can hold (${MAX_OBJECTS.toLocaleString()}). Narrow the selection.`);
  }
  return out;
}

/** Stable order (forms first, then workflow by kind and name) so repeated exports diff cleanly. */
function sortItems(items) {
  return [...items].sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** Split into files of at most `size` objects. */
function chunk(items, size = PART_SIZE) {
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

/** Helper request items for one part. */
const toHelperItems = (items) => items.map((i) => ({ type: TYPE[i.kind], name: i.name }));

/**
 * What a .def actually contains. The server exports an overlaid object together with its overlay
 * (named <base>__o), so a file holds more definitions than objects were requested.
 */
function countDefinitions(text) {
  let total = 0, overlays = 0, pending = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^begin (filter|active link|escalation|schema|char menu|container|image|application)\s*$/.test(line)) { pending = true; total += 1; continue; }
    if (pending) {
      const m = /^\s+name\s*:\s*(.*)$/.exec(line);
      if (m) { pending = false; if (/__o$/.test(m[1].trim())) overlays += 1; }
    }
  }
  return { total, overlays };
}

/** `<base>.def`, or `<base>-part2of3.def` when an export needed several files. */
function partFileName(base, ext, index, total) {
  return total > 1 ? `${base}-part${index + 1}of${total}.${ext}` : `${base}.${ext}`;
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const stamp = (d) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

/**
 * What a person (or an assistant) needs to know before importing: where the files came from, what is in
 * them, and what else has to exist on the target.
 *
 * info: { source, target?, scope, format, files:[{name,count}], items:[{kind,name}],
 *         attachedForms:[...], referencedForms:[...], targetForms?:Set|null, generatedAt }
 */
function manifestMarkdown(info) {
  const { source, target, scope, format, files, items, definitions, attachedForms = [], referencedForms = [], targetForms, generatedAt = new Date() } = info;
  const out = [];
  out.push(`# Definition export from ${source}`, '');
  out.push(`- **Generated:** ${stamp(generatedAt)}`);
  out.push(`- **Source instance:** ${source}`);
  if (target) out.push(`- **Intended target:** ${target}`);
  out.push(`- **Format:** ${format === 'xml' ? 'XML (.xml)' : 'AR System definition file (.def)'}`);
  out.push(`- **What was exported:** ${scope}`);
  out.push(`- **Objects:** ${items.length}`);
  out.push('', '## Files', '');
  for (const f of files) out.push(`- ${code(f.name)} — ${f.count} object${f.count === 1 ? '' : 's'}`);

  const byKind = {};
  for (const i of items) (byKind[i.kind] = byKind[i.kind] || []).push(i.name);
  out.push('', '## Objects', '');
  for (const kind of KIND_ORDER) {
    const names = byKind[kind];
    if (!names) continue;
    out.push(`**${KIND_LABEL[kind]}s (${names.length})**`, '');
    for (const n of names.sort()) out.push(`- ${code(n)}`);
    out.push('');
  }

  if (definitions && definitions.total) {
    const extra = definitions.total - items.length;
    out.push('', '## What is in the files', '');
    out.push(`${definitions.total} definition${definitions.total === 1 ? '' : 's'} in total for ${items.length} object${items.length === 1 ? '' : 's'} requested.`);
    if (definitions.overlays > 0) {
      out.push(`${definitions.overlays} of them ${definitions.overlays === 1 ? 'is an' : 'are'} overlay object${definitions.overlays === 1 ? '' : 's'} (named \`…__o\`): the server exports an overlaid object together with its overlay, and an overlay needs its base object where it is imported.`);
    } else if (extra > 0) {
      out.push(`${extra} more than requested: the server includes objects the export depends on.`);
    }
  }

  const attached = [...new Set(attachedForms)].sort();
  const referenced = [...new Set(referencedForms)].sort();
  const all = [...new Set([...attached, ...referenced])].sort();
  out.push('', '## Forms these objects depend on', '');
  if (!all.length) out.push('_None found._');
  else {
    if (targetForms instanceof Set || Array.isArray(targetForms)) {
      const have = targetForms instanceof Set ? targetForms : new Set(targetForms);
      const missing = all.filter((f) => !have.has(f));
      out.push(`${all.length} form${all.length === 1 ? '' : 's'} involved; ${all.length - missing.length} exist on ${target || 'the target'}, **${missing.length} do not**.`, '');
      if (missing.length) {
        out.push(`**Missing on ${target || 'the target'}** — create or import these forms first, or the objects that use them will fail to import:`, '');
        for (const f of missing) {
          const why = [attached.includes(f) ? 'attached to' : null, referenced.includes(f) ? 'used by actions' : null].filter(Boolean).join(' and ');
          out.push(`- ${code(f)} — ${why}`);
        }
        out.push('');
      }
    } else {
      out.push(`${all.length} form${all.length === 1 ? '' : 's'} involved. Not checked against a target.`, '');
    }
    if (referenced.length) {
      out.push(`**Used by actions and qualifications (${referenced.length})**`, '');
      for (const f of referenced) out.push(`- ${code(f)}`);
      out.push('');
    }
    out.push(`<details><summary>Forms the objects are attached to (${attached.length})</summary>`, '');
    for (const f of attached) out.push(`- ${code(f)}`);
    out.push('', '</details>');
  }
  out.push('', '## Notes', '');
  out.push('- Overlaid objects are exported as overlays and assume their base object exists where they are imported.');
  out.push('- This export was produced read-only; nothing on the source server was changed.');
  out.push('');
  return out.join('\n');
}

module.exports = {
  TYPE, KIND_LABEL, MAX_OBJECTS, PART_SIZE,
  normalizeItems, sortItems, chunk, toHelperItems, partFileName, countDefinitions, manifestMarkdown
};
