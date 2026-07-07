import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getConnections, getCompanies, compareData } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './ComparePage.module.css';

// Common starting points only — exact form/field names vary across ITSM
// versions and modules, so these are meant to be edited, not trusted blindly.
const DATA_PRESETS = [
  { label: 'Support Groups', formName: 'CTM:Support Group', keyField: 'Support Group Name' },
  { label: 'People', formName: 'CTM:People', keyField: 'Remedy Login ID' },
  { label: 'Company', formName: 'CTM:Company', keyField: 'Company Name' },
  { label: 'Operational Categorization', formName: 'CFG:Categorization', keyField: 'Name' },
  { label: 'Service Requests', formName: 'SRM:Request', keyField: 'Request Number' },
];

function formatVal(v) {
  if (v == null) return <em className={styles.nil}>—</em>;
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

function FieldDiffTable({ fieldDiffs }) {
  return (
    <div className={styles.fieldDiffTable}>
      {fieldDiffs.map(fd => (
        <div key={fd.field || fd.path} className={styles.fieldDiffRow}>
          <span className={styles.fieldDiffName}>{fd.field || fd.path}</span>
          <span className={styles.fieldDiffLeft}>{formatVal(fd.left)}</span>
          <span className={styles.fieldDiffArrow}>→</span>
          <span className={styles.fieldDiffRight}>{formatVal(fd.right)}</span>
        </div>
      ))}
    </div>
  );
}

// Shows exactly what was fetched for both sides of a record — the way to
// tell "genuinely unchanged" apart from "the differing field was never
// fetched in the first place" (BMC's entry API only returns the fields you
// ask for; no `fields` param means whatever subset it defaults to).
function RawValuesTable({ left, right }) {
  const keys = Array.from(new Set([...Object.keys(left || {}), ...Object.keys(right || {})])).sort();
  return (
    <div className={styles.fieldDiffTable}>
      {keys.map(k => (
        <div key={k} className={styles.fieldDiffRow}>
          <span className={styles.fieldDiffName}>{k}</span>
          <span className={styles.fieldDiffLeft}>{formatVal(left?.[k])}</span>
          <span className={styles.fieldDiffArrow}>·</span>
          <span className={styles.fieldDiffRight}>{formatVal(right?.[k])}</span>
        </div>
      ))}
      {keys.length === 0 && <div className={styles.hint}>No fields returned for this record.</div>}
    </div>
  );
}

export default function ComparePage() {
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });

  const [leftConnId, setLeftConnId] = useState(null);
  const [rightConnId, setRightConnId] = useState(null);
  const [formName, setFormName] = useState('');
  const [keyField, setKeyField] = useState('');
  const [company, setCompany] = useState('');
  const [fields, setFields] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [showUnchanged, setShowUnchanged] = useState(false);

  const { data: companiesData, error: companiesError } = useQuery({
    queryKey: ['companies', leftConnId],
    queryFn: () => getCompanies(leftConnId),
    enabled: !!leftConnId,
    retry: false
  });
  const companies = companiesData?.items || [];

  const mutation = useMutation({ mutationFn: compareData });
  const result = mutation.data;

  const canRun = !!(leftConnId && rightConnId && formName && keyField);

  const runCompare = () => {
    const trimmedCompany = company.trim();
    // Same qualification on both sides — we're comparing the same company's
    // records across Dev/Prod, not different companies against each other.
    const q = trimmedCompany ? `'Company' = "${trimmedCompany.replace(/"/g, '\\"')}"` : undefined;

    const fieldList = fields.split(',').map(f => f.trim()).filter(Boolean);
    if (fieldList.length && !fieldList.includes(keyField)) fieldList.unshift(keyField);
    const fieldsParam = fieldList.length ? `values(${fieldList.join(',')})` : undefined;

    mutation.mutate({ leftConnId, rightConnId, formName, keyField, qLeft: q, qRight: q, fields: fieldsParam });
  };

  const toggleExpand = (key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const totalItems = result
    ? result.summary.added + result.summary.removed + result.summary.modified + result.summary.unchanged
    : 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Compare"
        subtitle="Diff configuration/reference data between two Helix instances"
      />

      <div className={styles.controls}>
        <div className={styles.connRow}>
          <ConnectionPicker label="Left (e.g. Dev)" value={leftConnId} onChange={setLeftConnId} connections={connections} />
          <span className={styles.vs}>vs</span>
          <ConnectionPicker label="Right (e.g. Prod)" value={rightConnId} onChange={setRightConnId} connections={connections} />
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
            {DATA_PRESETS.map(p => <option key={p.formName} value={p.formName}>{p.label}</option>)}
          </datalist>
          <input
            className={styles.input}
            placeholder="Key field (e.g. Name)…"
            value={keyField}
            onChange={e => setKeyField(e.target.value)}
          />
          <input
            className={styles.input}
            list="company-options"
            placeholder="Company filter (optional)…"
            value={company}
            onChange={e => setCompany(e.target.value)}
            disabled={!leftConnId}
          />
          <datalist id="company-options">
            {companies.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>

        <div className={styles.optionsRow}>
          <input
            className={styles.input}
            placeholder="Fields to compare (optional, comma-separated — leave blank to use BMC's default set)…"
            value={fields}
            onChange={e => setFields(e.target.value)}
          />
        </div>

        <div className={styles.hint}>
          Presets are common starting points — exact form/field names vary by ITSM version. Confirm with the Forms browser or Diagnostics page first.
          Company filter assumes the form has a standard <code className={styles.hintCode}>Company</code> field.
          {leftConnId && companiesError && ' Could not load a company list from the left connection (CTM:Company not found?) — type the name manually.'}
          {' '}If a comparison shows no difference you know should exist, list the specific field(s) above — without it, BMC may only return a default subset of fields.
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

          <div className={styles.list}>
            {totalItems === 0 && <div className={styles.empty}>No items found on either side.</div>}

            {result.removed.map(item => (
              <div key={`removed-${item.key}`} className={styles.rowGroup}>
                <div className={`${styles.row} ${styles.rowRemoved}`} onClick={() => toggleExpand(`removed-${item.key}`)}>
                  <span className={styles.rowTag}>only in left</span>
                  <span className={styles.rowName}>{item.key}</span>
                </div>
                {expanded.has(`removed-${item.key}`) && <RawValuesTable left={item.left} right={{}} />}
              </div>
            ))}
            {result.added.map(item => (
              <div key={`added-${item.key}`} className={styles.rowGroup}>
                <div className={`${styles.row} ${styles.rowAdded}`} onClick={() => toggleExpand(`added-${item.key}`)}>
                  <span className={styles.rowTag}>only in right</span>
                  <span className={styles.rowName}>{item.key}</span>
                </div>
                {expanded.has(`added-${item.key}`) && <RawValuesTable left={{}} right={item.right} />}
              </div>
            ))}
            {result.modified.map(item => (
              <div key={`modified-${item.key}`} className={styles.rowGroup}>
                <div
                  className={`${styles.row} ${styles.rowModified}`}
                  onClick={() => toggleExpand(`modified-${item.key}`)}
                >
                  <span className={styles.rowTag}>modified</span>
                  <span className={styles.rowName}>{item.key}</span>
                  <span className={styles.rowMeta}>
                    {item.fieldDiffs.length} field{item.fieldDiffs.length === 1 ? '' : 's'} differ
                  </span>
                </div>
                {expanded.has(`modified-${item.key}`) && (
                  <FieldDiffTable fieldDiffs={item.fieldDiffs} />
                )}
              </div>
            ))}

            {result.unchanged.length > 0 && (
              <>
                <div className={styles.unchangedNote} onClick={() => setShowUnchanged(s => !s)} style={{ cursor: 'pointer' }}>
                  {showUnchanged ? '▾' : '▸'} {result.unchanged.length} unchanged item{result.unchanged.length === 1 ? '' : 's'} {showUnchanged ? '' : '(click to show)'}
                </div>
                {showUnchanged && result.unchanged.map(item => (
                  <div key={`unchanged-${item.key}`} className={styles.rowGroup}>
                    <div className={styles.row} onClick={() => toggleExpand(`unchanged-${item.key}`)}>
                      <span className={styles.rowTag}>unchanged</span>
                      <span className={styles.rowName}>{item.key}</span>
                    </div>
                    {expanded.has(`unchanged-${item.key}`) && <RawValuesTable left={item.left} right={item.right} />}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
