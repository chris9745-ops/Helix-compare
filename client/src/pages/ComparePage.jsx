import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getConnections, getCompanies, compareData, compareFields } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import { DATA_PRESETS } from '../lib/presets';
import { useFormNames } from '../lib/useFormNames';
import styles from './ComparePage.module.css';

// A company value can be: blank (no filter), a single name, a comma-separated
// list (OR'd together), or contain * / % for a LIKE-style wildcard match.
function buildCompanyQualification(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;

  const clauses = parts.map(p => {
    const escaped = p.replace(/"/g, '\\"');
    if (p.includes('*') || p.includes('%')) {
      return `'Company' LIKE "${escaped.replace(/\*/g, '%')}"`;
    }
    return `'Company' = "${escaped}"`;
  });

  return clauses.length > 1 ? clauses.map(c => `(${c})`).join(' OR ') : clauses[0];
}

// Join several qualifications with AND. Each is parenthesised so an OR inside one
// (e.g. a company list) can't change the meaning of the whole.
function combineQualifications(...parts) {
  const present = parts.map(p => (p || '').trim()).filter(Boolean);
  if (!present.length) return undefined;
  return present.length === 1 ? present[0] : present.map(p => `(${p})`).join(' AND ');
}

function formatVal(v) {
  if (v == null) return <span className={styles.nil}>—</span>;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ConnectionPicker({ label, value, onChange, connections }) {
  return (
    <label className={styles.connPicker}>
      <span className={styles.connPickerLabel}>{label}</span>
      <select className={styles.select} value={value || ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">— select instance —</option>
        {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

function SummaryBadges({ summary }) {
  return (
    <div className={styles.summaryRow}>
      <span className={`${styles.summaryBadge} ${styles.added}`}>+{summary.added} only in right</span>
      <span className={`${styles.summaryBadge} ${styles.removed}`}>−{summary.removed} only in left</span>
      <span className={`${styles.summaryBadge} ${styles.modified}`}>~{summary.modified} modified</span>
      <span className={`${styles.summaryBadge} ${styles.unchanged}`}>{summary.unchanged} unchanged</span>
    </div>
  );
}

// The main event: a flat table so differences are visible without clicking
// into every row. One row per differing field for "modified" records (with
// the key shown once via rowSpan), plus compact rows for added/removed.
function DiffTable({ result }) {
  const hasRows = result.removed.length || result.added.length || result.modified.length;
  if (!hasRows) return <div className={styles.empty}>No differences found.</div>;

  return (
    <table className={styles.diffTable}>
      <thead>
        <tr>
          <th className={styles.colStatus}>Status</th>
          <th className={styles.colKey}>Key</th>
          <th className={styles.colField}>Field</th>
          <th className={styles.colValue}>Left</th>
          <th className={styles.colValue}>Right</th>
        </tr>
      </thead>
      <tbody>
        {result.removed.map(item => (
          <tr key={`removed-${item.key}`} className={styles.trRemoved}>
            <td><span className={styles.statusTag}>only in left</span></td>
            <td className={styles.keyCell}>{item.key}</td>
            <td colSpan={3} className={styles.wholeRecordNote}>record not present on the right side</td>
          </tr>
        ))}
        {result.added.map(item => (
          <tr key={`added-${item.key}`} className={styles.trAdded}>
            <td><span className={styles.statusTag}>only in right</span></td>
            <td className={styles.keyCell}>{item.key}</td>
            <td colSpan={3} className={styles.wholeRecordNote}>record not present on the left side</td>
          </tr>
        ))}
        {result.modified.map(item => (
          item.fieldDiffs.map((fd, i) => (
            <tr key={`modified-${item.key}-${fd.field}`} className={styles.trModified}>
              {i === 0 && (
                <>
                  <td rowSpan={item.fieldDiffs.length}><span className={styles.statusTag}>modified</span></td>
                  <td rowSpan={item.fieldDiffs.length} className={styles.keyCell}>{item.key}</td>
                </>
              )}
              <td className={styles.fieldCell}>{fd.field}</td>
              <td className={styles.valueCellLeft}>{formatVal(fd.left)}</td>
              <td className={styles.valueCellRight}>{formatVal(fd.right)}</td>
            </tr>
          ))
        ))}
      </tbody>
    </table>
  );
}

function UnchangedTable({ items }) {
  const keys = items.length
    ? Array.from(new Set(items.flatMap(i => Object.keys(i.left || {})))).sort()
    : [];
  return (
    <table className={styles.diffTable}>
      <thead>
        <tr>
          <th className={styles.colKey}>Key</th>
          {keys.map(k => <th key={k} className={styles.colValue}>{k}</th>)}
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <tr key={item.key}>
            <td className={styles.keyCell}>{item.key}</td>
            {keys.map(k => <td key={k} className={styles.valueCellMatch}>{formatVal(item.left?.[k])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ComparePage() {
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });

  const [source, setSource] = useState('data'); // 'data' | 'schema'
  const [leftConnId, setLeftConnId] = useState(null);
  const [rightConnId, setRightConnId] = useState(null);
  const [formName, setFormName] = useState('');
  const [keyField, setKeyField] = useState('');
  const [company, setCompany] = useState('');
  const [fields, setFields] = useState('');
  const [qualification, setQualification] = useState('');
  const [showUnchanged, setShowUnchanged] = useState(false);

  const { names: formNames } = useFormNames(leftConnId);
  // Thousands of options: build them once, not on every keystroke
  const formOptions = useMemo(() => formNames.map(n => <option key={n} value={n} />), [formNames]);

  const { data: companiesData, error: companiesError } = useQuery({
    queryKey: ['companies', leftConnId],
    queryFn: () => getCompanies(leftConnId),
    enabled: !!leftConnId && source === 'data',
    retry: false
  });
  const companies = companiesData?.items || [];

  const dataMutation = useMutation({ mutationFn: compareData });
  const fieldsMutation = useMutation({ mutationFn: compareFields });
  const mutation = source === 'data' ? dataMutation : fieldsMutation;
  const result = mutation.data;

  const canRun = !!(leftConnId && rightConnId && formName && keyField);

  const runCompare = () => {
    if (source === 'schema') {
      fieldsMutation.mutate({ leftConnId, rightConnId, formName, keyField });
      return;
    }
    // Same qualification on both sides: company filter AND any extra qualification
    const q = combineQualifications(buildCompanyQualification(company), qualification);
    const fieldList = fields.split(',').map(f => f.trim()).filter(Boolean);
    if (fieldList.length && !fieldList.includes(keyField)) fieldList.unshift(keyField);
    const fieldsParam = fieldList.length ? `values(${fieldList.join(',')})` : undefined;
    dataMutation.mutate({ leftConnId, rightConnId, formName, keyField, qLeft: q, qRight: q, fields: fieldsParam });
  };

  const totalItems = result
    ? result.summary.added + result.summary.removed + result.summary.modified + result.summary.unchanged
    : 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Compare"
        subtitle="Diff configuration/reference data or form schema between two Helix instances"
      />

      <div className={styles.controls}>
        <div className={styles.connRow}>
          <ConnectionPicker label="Left (e.g. Dev)" value={leftConnId} onChange={setLeftConnId} connections={connections} />
          <span className={styles.vs}>vs</span>
          <ConnectionPicker label="Right (e.g. Prod)" value={rightConnId} onChange={setRightConnId} connections={connections} />
        </div>

        <div className={styles.modeTabs}>
          <button
            className={`${styles.modeTab} ${source === 'data' ? styles.modeTabActive : ''}`}
            onClick={() => setSource('data')}
          >
            Data (records)
          </button>
          <button
            className={`${styles.modeTab} ${source === 'schema' ? styles.modeTabActive : ''}`}
            onClick={() => setSource('schema')}
          >
            Schema (field definitions)
          </button>
        </div>

        <div className={styles.optionsRow}>
          <input
            className={styles.input}
            list="data-presets"
            placeholder="Form name (e.g. CTM:Support Group)…"
            value={formName}
            onChange={e => {
              setFormName(e.target.value);
              const preset = DATA_PRESETS.find(p => p.formName === e.target.value);
              if (preset) setKeyField(preset.keyField);
            }}
          />
          <datalist id="data-presets">
            {formOptions}
          </datalist>
          <input
            className={styles.input}
            placeholder={source === 'schema' ? 'Key field (e.g. fieldId, name — check Forms & Fields)…' : 'Key field (e.g. Name)…'}
            value={keyField}
            onChange={e => setKeyField(e.target.value)}
          />
          {source === 'data' && (
            <>
              <input
                className={styles.input}
                list="company-options"
                placeholder="Company filter — name, comma list, or wildcard with * (optional)…"
                value={company}
                onChange={e => setCompany(e.target.value)}
                disabled={!leftConnId}
              />
              <datalist id="company-options">
                {companies.map(c => <option key={c} value={c} />)}
              </datalist>
            </>
          )}
        </div>

        {source === 'data' && (
          <div className={styles.optionsRow}>
            <input
              className={styles.input}
              placeholder={`Extra qualification (optional) — e.g. 'Status' = "Enabled". Needed if your Helix server refuses searches with no qualification.`}
              value={qualification}
              onChange={e => setQualification(e.target.value)}
            />
          </div>
        )}

        {source === 'data' && (
          <div className={styles.optionsRow}>
            <input
              className={styles.input}
              placeholder="Fields to compare (optional, comma-separated — leave blank to use BMC's default set)…"
              value={fields}
              onChange={e => setFields(e.target.value)}
            />
          </div>
        )}

        <div className={styles.hint}>
          Presets are common starting points — exact form/field names vary by ITSM version. Confirm with the Forms browser or Diagnostics page first.
          {source === 'data' && <> Company filter assumes a standard <code className={styles.hintCode}>Company</code> field; use commas for multiple companies or <code className={styles.hintCode}>*</code> for a wildcard (e.g. <code className={styles.hintCode}>Germania*</code>).</>}
          {source === 'data' && leftConnId && companiesError && ' Could not load a company list from the left connection (CTM:Company not found, or the server refuses unqualified searches) — type the name manually.'}
          {source === 'data' && ' If a comparison shows no difference you know should exist, list the specific field(s) above — without it, BMC may only return a default subset of fields.'}
          {source === 'schema' && ' The exact shape of BMC\'s field-metadata response varies by version — if the key field you enter isn\'t found, check what a raw field-list response actually looks like first.'}
        </div>

        <Button variant="primary" disabled={!canRun} loading={mutation.isPending} onClick={runCompare}>
          Run compare
        </Button>
      </div>

      {mutation.error && (
        <div className={styles.errorBox}>
          ✗ {mutation.error.response?.data?.error || mutation.error.message}
        </div>
      )}

      {result && (
        <div className={styles.results}>
          <SummaryBadges summary={result.summary} />

          <div className={styles.tableScroll}>
            {totalItems === 0 ? (
              <div className={styles.empty}>No items found on either side.</div>
            ) : (
              <DiffTable result={result} />
            )}

            {result.unchanged.length > 0 && (
              <>
                <div className={styles.unchangedNote} onClick={() => setShowUnchanged(s => !s)}>
                  {showUnchanged ? '▾' : '▸'} {result.unchanged.length} unchanged item{result.unchanged.length === 1 ? '' : 's'} {showUnchanged ? '' : '(click to show)'}
                </div>
                {showUnchanged && <UnchangedTable items={result.unchanged} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
