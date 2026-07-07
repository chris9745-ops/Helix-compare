import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getConnections, compareWorkflow, compareWorkflowDetail, compareData } from '../lib/api';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './ComparePage.module.css';

const CODE_TYPES = [
  { value: 'activelinks', label: 'Active Links' },
  { value: 'filters', label: 'Filters' },
  { value: 'escalations', label: 'Escalations' },
  { value: 'menus', label: 'Menus' },
];

// Common starting points only — exact form/field names vary across ITSM
// versions and modules, so these are meant to be edited, not trusted blindly.
const DATA_PRESETS = [
  { label: 'Support Groups', formName: 'CTM:Support Group', keyField: 'Support Group Name' },
  { label: 'People', formName: 'CTM:People', keyField: 'Remedy Login ID' },
  { label: 'Company', formName: 'CTM:Company', keyField: 'Company Name' },
  { label: 'Operational Categorization', formName: 'CFG:Categorization', keyField: 'Name' },
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

export default function ComparePage() {
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });

  const [leftConnId, setLeftConnId] = useState(null);
  const [rightConnId, setRightConnId] = useState(null);
  const [mode, setMode] = useState('code'); // 'code' | 'data'
  const [objectType, setObjectType] = useState('activelinks');
  const [form, setForm] = useState('');
  const [formName, setFormName] = useState('');
  const [keyField, setKeyField] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [detailItem, setDetailItem] = useState(null); // { name } — code mode drawer

  const workflowMutation = useMutation({ mutationFn: compareWorkflow });
  const dataMutation = useMutation({ mutationFn: compareData });
  const activeMutation = mode === 'code' ? workflowMutation : dataMutation;
  const result = activeMutation.data;

  const detailQuery = useQuery({
    queryKey: ['compareDetail', leftConnId, rightConnId, objectType, detailItem?.name],
    queryFn: () => compareWorkflowDetail({ leftConnId, rightConnId, objectType, name: detailItem.name }),
    enabled: !!detailItem && mode === 'code'
  });

  const canRun = !!(leftConnId && rightConnId && (mode === 'code' || (formName && keyField)));

  const runCompare = () => {
    if (mode === 'code') {
      workflowMutation.mutate({ leftConnId, rightConnId, objectType, form: form || undefined });
    } else {
      dataMutation.mutate({ leftConnId, rightConnId, formName, keyField });
    }
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
        subtitle="Diff workflow objects and configuration data between two Helix instances"
      />

      <div className={styles.controls}>
        <div className={styles.connRow}>
          <ConnectionPicker label="Left (e.g. Dev)" value={leftConnId} onChange={setLeftConnId} connections={connections} />
          <span className={styles.vs}>vs</span>
          <ConnectionPicker label="Right (e.g. Prod)" value={rightConnId} onChange={setRightConnId} connections={connections} />
        </div>

        <div className={styles.modeTabs}>
          <button
            className={`${styles.modeTab} ${mode === 'code' ? styles.modeTabActive : ''}`}
            onClick={() => setMode('code')}
          >
            Code (workflow)
          </button>
          <button
            className={`${styles.modeTab} ${mode === 'data' ? styles.modeTabActive : ''}`}
            onClick={() => setMode('data')}
          >
            Data (configuration)
          </button>
        </div>

        {mode === 'code' ? (
          <div className={styles.optionsRow}>
            <select className={styles.select} value={objectType} onChange={e => setObjectType(e.target.value)}>
              {CODE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input
              className={styles.input}
              placeholder="Filter by form (optional)…"
              value={form}
              onChange={e => setForm(e.target.value)}
            />
          </div>
        ) : (
          <>
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
            </div>
            <div className={styles.hint}>
              Presets are common starting points — exact form/field names vary by ITSM version. Confirm with the Forms browser or Diagnostics page first.
            </div>
          </>
        )}

        <Button variant="primary" disabled={!canRun} loading={activeMutation.isPending} onClick={runCompare}>
          Run compare
        </Button>
      </div>

      {activeMutation.error && (
        <div className={styles.errorBox}>
          ✗ {activeMutation.error.response?.data?.error || activeMutation.error.message}
        </div>
      )}

      {result && (
        <div className={styles.results}>
          <SummaryBadges summary={result.summary} />

          <div className={styles.list}>
            {totalItems === 0 && <div className={styles.empty}>No items found on either side.</div>}

            {result.removed.map(item => (
              <div key={`removed-${item.key}`} className={`${styles.row} ${styles.rowRemoved}`}>
                <span className={styles.rowTag}>only in left</span>
                <span className={styles.rowName}>{item.key}</span>
              </div>
            ))}
            {result.added.map(item => (
              <div key={`added-${item.key}`} className={`${styles.row} ${styles.rowAdded}`}>
                <span className={styles.rowTag}>only in right</span>
                <span className={styles.rowName}>{item.key}</span>
              </div>
            ))}
            {result.modified.map(item => (
              <div key={`modified-${item.key}`} className={styles.rowGroup}>
                <div
                  className={`${styles.row} ${styles.rowModified}`}
                  onClick={() => mode === 'code' ? setDetailItem({ name: item.key }) : toggleExpand(item.key)}
                >
                  <span className={styles.rowTag}>modified</span>
                  <span className={styles.rowName}>{item.key}</span>
                  <span className={styles.rowMeta}>
                    {item.fieldDiffs.length} field{item.fieldDiffs.length === 1 ? '' : 's'} differ
                  </span>
                </div>
                {mode === 'data' && expanded.has(item.key) && (
                  <FieldDiffTable fieldDiffs={item.fieldDiffs} />
                )}
              </div>
            ))}

            {result.unchanged.length > 0 && (
              <div className={styles.unchangedNote}>
                {result.unchanged.length} unchanged item{result.unchanged.length === 1 ? '' : 's'} hidden
              </div>
            )}
          </div>
        </div>
      )}

      {detailItem && mode === 'code' && (
        <div className={styles.overlay} onClick={e => e.target === e.currentTarget && setDetailItem(null)}>
          <div className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <span className="mono">{detailItem.name}</span>
              <Button size="sm" variant="ghost" onClick={() => setDetailItem(null)}>✕</Button>
            </div>
            <div className={styles.drawerBody}>
              {detailQuery.isLoading && <div className={styles.loading}>Loading diff…</div>}
              {detailQuery.error && (
                <div className={styles.errorBox}>
                  ✗ {detailQuery.error.response?.data?.error || detailQuery.error.message}
                </div>
              )}
              {detailQuery.data && (
                detailQuery.data.diffs.length === 0 ? (
                  <div className={styles.empty}>
                    No field differences found — the full definitions match on both sides.
                  </div>
                ) : (
                  <FieldDiffTable fieldDiffs={detailQuery.data.diffs} />
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
