import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getFormFields, importFormList, clearFormList } from '../lib/api';
import { useAppStore } from '../lib/store';
import { useFormNames } from '../lib/useFormNames';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './FormsPage.module.css';

// Columns most likely to matter, shown first when present. The rest follow in
// the order they appear — we don't assume field names because the exact shape
// of BMC's field-list response varies by version.
const PREFERRED = ['id', 'fieldId', 'name', 'fieldName', 'label', 'dataType', 'type', 'required', 'entryMode', 'defaultValue'];
const MAX_COLUMNS = 8;

// Same flattening the server uses for list responses.
function normalizeList(data) {
  const arr = Array.isArray(data) ? data : (data?.fields || data?.entries || data?.items || []);
  return arr.map(e => e?.values || e);
}

// Primitive-valued keys only (nested objects are visible in the raw view).
function pickColumns(rows) {
  const keys = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      if (v === null || typeof v !== 'object') keys.add(k);
    }
  }
  const ordered = [
    ...PREFERRED.filter(k => keys.has(k)),
    ...[...keys].filter(k => !PREFERRED.includes(k))
  ];
  return ordered.slice(0, MAX_COLUMNS);
}

function formatCell(v) {
  if (v === null || v === undefined || v === '') return <span className={styles.nil}>—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v);
}

// One-time-per-environment import of the server's form list. BMC's REST API can't
// list forms, but the Mid-Tier's "AR System Object List" screen can.
function ImportPanel({ connectionId, importedCount, importedAt }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [message, setMessage] = useState(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['formList', connectionId] });
  const save = useMutation({
    mutationFn: () => importFormList(connectionId, text),
    onSuccess: (r) => {
      refresh();
      setText('');
      setMessage({ ok: true, text: `Imported ${r.count.toLocaleString()} forms${r.skipped ? ` (${r.skipped} unusable lines skipped)` : ''}.` });
    },
    onError: (e) => setMessage({ ok: false, text: e.response?.data?.error || e.message })
  });
  const clear = useMutation({
    mutationFn: () => clearFormList(connectionId),
    onSuccess: () => { refresh(); setMessage({ ok: true, text: 'Form list cleared.' }); }
  });

  return (
    <details className={styles.import}>
      <summary className={styles.importSummary}>
        {importedCount
          ? `Form list: ${importedCount.toLocaleString()} forms imported${importedAt ? ' on ' + new Date(importedAt).toLocaleDateString() : ''}`
          : 'Import this environment’s form list (enables typeahead for form names)'}
      </summary>
      <ol className={styles.steps}>
        <li>Open this environment’s Mid-Tier object list — the screen that lists every form (usually <code>…/arsys/forms</code>, then “AR System Object List”).</li>
        <li>Tick <strong>Show Hidden</strong> (many configuration forms are hidden), then click <strong>Search</strong>.</li>
        <li>Click inside the results table, select all (⌘A / Ctrl+A) and copy (⌘C / Ctrl+C).</li>
        <li>Paste it below and click <strong>Import</strong>. The count it reports should match the “entries returned” number above the Mid-Tier table (a full environment can have thousands). Each environment has its own list, so repeat for each connection.</li>
      </ol>
      <textarea
        className={styles.textarea}
        rows={5}
        placeholder="Paste the copied table (or just a list of form names) here…"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className={styles.importActions}>
        <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!text.trim()} loading={save.isPending}>Import</Button>
        {importedCount > 0 && <Button size="sm" variant="ghost" onClick={() => clear.mutate()} loading={clear.isPending}>Clear list</Button>}
        {message && <span className={message.ok ? styles.msgOk : styles.msgErr}>{message.text}</span>}
      </div>
    </details>
  );
}

export default function FormsPage() {
  const { activeConnectionId } = useAppStore();
  const [draft, setDraft] = useState('');
  const [formName, setFormName] = useState('');
  const [filter, setFilter] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const { names: formNames, importedCount, importedAt } = useFormNames(activeConnectionId);
  // Thousands of options: build them once, not on every keystroke
  const formOptions = useMemo(() => formNames.map(n => <option key={n} value={n} />), [formNames]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['fields', activeConnectionId, formName],
    queryFn: () => getFormFields(formName),
    enabled: !!activeConnectionId && !!formName,
    retry: false
  });

  const rows = useMemo(() => (data ? normalizeList(data) : []), [data]);
  const columns = useMemo(() => pickColumns(rows), [rows]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => JSON.stringify(r).toLowerCase().includes(needle));
  }, [rows, filter]);

  const lookup = () => { setFormName(draft.trim()); setFilter(''); };

  if (!activeConnectionId) return (
    <div className={styles.noConn}>
      <div className={styles.noConnIcon}>▦</div>
      <div>No instance selected</div>
      <div className={styles.hint}>Choose a connection from the sidebar to look up a form's fields</div>
    </div>
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Forms & Fields"
        subtitle="Look up the field definitions of a form by its exact name"
      />

      <div className={styles.toolbar}>
        <input
          className={styles.input}
          list="form-presets"
          placeholder="Exact form name, e.g. CTM:Support Group"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && draft.trim() && lookup()}
        />
        <datalist id="form-presets">
          {formOptions}
        </datalist>
        <Button variant="primary" onClick={lookup} disabled={!draft.trim()} loading={isLoading}>
          Look up
        </Button>
      </div>

      <div className={styles.hint}>
        BMC's REST API can't list every form on a server, so enter a name you know — or import this
        environment's form list below for typeahead. To test whether a name is reachable, use the Diagnostics page.
      </div>

      <ImportPanel connectionId={activeConnectionId} importedCount={importedCount} importedAt={importedAt} />

      <div className={styles.body}>
        {!formName && <div className={styles.empty}>Enter a form name above to see its fields.</div>}

        {error && (
          <div className={styles.err}>
            ✗ {error.response?.data?.error || error.message}
          </div>
        )}

        {data && (
          <>
            <div className={styles.resultBar}>
              <span className={styles.resultTitle}>{formName}</span>
              <span className={styles.count}>
                {filter ? `${visible.length} of ${rows.length}` : rows.length} field{rows.length === 1 ? '' : 's'}
              </span>
              <input
                className={styles.filter}
                placeholder="Filter fields…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
              <button className={styles.linkBtn} onClick={() => setShowRaw(r => !r)}>
                {showRaw ? 'Hide' : 'Show'} raw response
              </button>
            </div>

            {showRaw && <pre className={styles.raw}>{JSON.stringify(data, null, 2)}</pre>}

            {rows.length === 0 ? (
              <div className={styles.empty}>
                The form exists but returned no field list in a shape this page recognises.
                Use “Show raw response” to see what came back.
              </div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>{columns.map(c => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {visible.map((row, i) => (
                      <tr key={row.id ?? row.fieldId ?? i}>
                        {columns.map(c => <td key={c}>{formatCell(row[c])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
