import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getActiveLink, createActiveLink, updateActiveLink } from '../lib/api';
import Button from './Button';
import styles from './ActiveLinkDrawer.module.css';

function JsonEditor({ value, onChange }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState(null);

  const handleChange = (v) => {
    setText(v);
    try { onChange(JSON.parse(v)); setErr(null); }
    catch { setErr('Invalid JSON'); }
  };

  return (
    <div className={styles.jsonWrap}>
      {err && <div className={styles.jsonErr}>{err}</div>}
      <textarea
        className={styles.jsonEditor}
        value={text}
        onChange={e => handleChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function SectionBlock({ label, children }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{label}</div>
      <div className={styles.sectionBody}>{children}</div>
    </div>
  );
}

function QualBlock({ qualification }) {
  if (!qualification) return <span className={styles.nil}>None</span>;
  return <code className={styles.qual}>{qualification}</code>;
}

function ActionList({ actions = [] }) {
  if (!actions.length) return <span className={styles.nil}>No actions</span>;
  return (
    <div className={styles.actions}>
      {actions.map((a, i) => (
        <div key={i} className={styles.actionItem}>
          <span className={styles.actionNum}>{i + 1}</span>
          <div className={styles.actionBody}>
            <div className={styles.actionType}>{a.actionType || a.type || 'Action'}</div>
            {a.fieldValues && (
              <div className={styles.fieldVals}>
                {a.fieldValues.map((fv, j) => (
                  <div key={j} className={styles.fieldVal}>
                    <span className={styles.fieldName}>{fv.fieldName || fv.field} ({fv.fieldId})</span>
                    <span className={styles.eq}>=</span>
                    <span className={styles.fieldValue}>{String(fv.value ?? '""')}</span>
                  </div>
                ))}
              </div>
            )}
            {a.message && <div className={styles.msgPreview}>{a.message}</div>}
            {a.processName && <div className={styles.msgPreview}>{a.processName}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ActiveLinkDrawer({ name, onClose }) {
  const isNew = !name;
  const qc = useQueryClient();
  const [editMode, setEditMode] = useState(isNew);
  const [draft, setDraft] = useState(isNew ? { name: '', schemaName: '', executionOrder: 0, actions: [] } : null);

  const { data: al, isLoading } = useQuery({
    queryKey: ['activelink', name],
    queryFn: () => getActiveLink(name),
    enabled: !!name
  });

  useEffect(() => {
    if (al && !draft) setDraft(al);
  }, [al]);

  const { mutate: save, isPending, error: saveError } = useMutation({
    mutationFn: (def) => isNew ? createActiveLink(def) : updateActiveLink(name, def),
    onSuccess: () => {
      qc.invalidateQueries(['activelinks']);
      qc.invalidateQueries(['activelink', name]);
      setEditMode(false);
    }
  });

  const current = al || (isNew ? draft : null);

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.drawer}>
        <div className={styles.drawerHeader}>
          <div className={styles.drawerTitle}>
            {isNew ? 'New Active Link' : <span className="mono">{name}</span>}
          </div>
          <div className={styles.drawerActions}>
            {!isNew && !editMode && (
              <Button size="sm" onClick={() => setEditMode(true)}>Edit</Button>
            )}
            {editMode && (
              <>
                <Button size="sm" variant="ghost" onClick={() => { setEditMode(false); setDraft(al); }}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={isPending} onClick={() => save(draft)}>
                  Save to Helix
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
          </div>
        </div>

        <div className={styles.drawerBody}>
          {isLoading && <div className={styles.loading}>Loading…</div>}

          {saveError && (
            <div className={styles.saveError}>
              ✗ {saveError.response?.data?.error || saveError.message}
            </div>
          )}

          {editMode && draft ? (
            <div className={styles.editView}>
              <div className={styles.editMeta}>
                <label className={styles.metaField}>
                  <span>Name</span>
                  <input value={draft.name || ''} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
                </label>
                <label className={styles.metaField}>
                  <span>Form (schema)</span>
                  <input value={draft.schemaName || ''} onChange={e => setDraft(d => ({ ...d, schemaName: e.target.value }))} />
                </label>
                <label className={styles.metaField}>
                  <span>Execution order</span>
                  <input type="number" value={draft.executionOrder ?? 0} onChange={e => setDraft(d => ({ ...d, executionOrder: parseInt(e.target.value) }))} />
                </label>
              </div>
              <div className={styles.jsonLabel}>Full definition (JSON)</div>
              <JsonEditor value={draft} onChange={setDraft} />
            </div>
          ) : current ? (
            <div className={styles.readView}>
              <div className={styles.metaGrid}>
                <div className={styles.metaItem}><span>Form</span><strong>{current.schemaName || '—'}</strong></div>
                <div className={styles.metaItem}><span>Order</span><strong>{current.executionOrder ?? '—'}</strong></div>
                <div className={styles.metaItem}><span>Trigger</span><strong>{current.triggerType || '—'}</strong></div>
                <div className={styles.metaItem}><span>Enabled</span><strong>{current.enabled === false ? 'No' : 'Yes'}</strong></div>
              </div>

              <SectionBlock label="Run if (qualification)">
                <QualBlock qualification={current.runIf || current.qualification} />
              </SectionBlock>

              <SectionBlock label="Actions">
                <ActionList actions={current.actions} />
              </SectionBlock>

              <SectionBlock label="Raw JSON">
                <pre className={styles.rawJson}>{JSON.stringify(current, null, 2)}</pre>
              </SectionBlock>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
