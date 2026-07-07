import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getForms, getFormFields } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './FormsPage.module.css';

const FIELD_TYPE_COLORS = {
  CHAR: 'blue', INTEGER: 'green', REAL: 'green', DATE: 'amber',
  TIME: 'amber', DIARY: 'purple', SELECTION: 'teal', ATTACH: 'coral',
  DEFAULT: 'gray'
};

export default function FormsPage() {
  const { activeConnectionId } = useAppStore();
  const [search, setSearch] = useState('');
  const [selectedForm, setSelectedForm] = useState(null);
  const [fieldSearch, setFieldSearch] = useState('');

  const { data: formsData, isLoading, error } = useQuery({
    queryKey: ['forms', activeConnectionId],
    queryFn: getForms,
    enabled: !!activeConnectionId
  });

  const { data: fieldsData, isLoading: fieldsLoading } = useQuery({
    queryKey: ['fields', activeConnectionId, selectedForm],
    queryFn: () => getFormFields(selectedForm),
    enabled: !!selectedForm
  });

  const forms = (formsData?.items || formsData || []);
  const fields = (fieldsData?.items || fieldsData || []);

  const filteredForms = forms.filter(f =>
    !search || f.name?.toLowerCase().includes(search.toLowerCase())
  );
  const filteredFields = fields.filter(f =>
    !fieldSearch ||
    f.fieldName?.toLowerCase().includes(fieldSearch.toLowerCase()) ||
    String(f.fieldId).includes(fieldSearch)
  );

  if (!activeConnectionId) return (
    <div className={styles.noConn}><div className={styles.noConnIcon}>▦</div><div>No instance selected</div></div>
  );

  return (
    <div className={styles.page}>
      <PageHeader title="Forms & Fields" subtitle="Browse schema definitions" />
      <div className={styles.split}>

        {/* Left: form list */}
        <div className={styles.formList}>
          <div className={styles.paneHeader}>
            <input className={styles.search} placeholder="Search forms…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className={styles.formItems}>
            {isLoading && <div className={styles.empty}>Loading…</div>}
            {error && <div className={styles.err}>✗ {error.response?.data?.error || error.message}</div>}
            {filteredForms.map(f => (
              <div
                key={f.name}
                className={`${styles.formItem} ${selectedForm === f.name ? styles.active : ''}`}
                onClick={() => { setSelectedForm(f.name); setFieldSearch(''); }}
              >
                <span className={styles.formName}>{f.name}</span>
                {f.type && <span className={styles.formType}>{f.type}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Right: field list */}
        <div className={styles.fieldPane}>
          {!selectedForm ? (
            <div className={styles.emptyPane}>← Select a form to browse its fields</div>
          ) : (
            <>
              <div className={styles.paneHeader}>
                <span className={styles.paneTitle}>{selectedForm}</span>
                <input className={styles.search} placeholder="Search fields…" value={fieldSearch} onChange={e => setFieldSearch(e.target.value)} />
                <Button size="sm" variant="primary">+ Add Field</Button>
              </div>
              <div className={styles.fieldTable}>
                <div className={styles.fieldHeader}>
                  <span>ID</span><span>Field name</span><span>Type</span><span>Required</span>
                </div>
                {fieldsLoading && <div className={styles.empty}>Loading fields…</div>}
                {filteredFields.map(f => {
                  const typeColor = FIELD_TYPE_COLORS[f.dataType] || FIELD_TYPE_COLORS.DEFAULT;
                  return (
                    <div key={f.fieldId} className={styles.fieldRow}>
                      <span className={styles.fieldId}>{f.fieldId}</span>
                      <span className={styles.fieldName}>{f.fieldName}</span>
                      <span className={`${styles.typeBadge} ${styles[`type_${typeColor}`]}`}>
                        {f.dataType || '?'}
                      </span>
                      <span className={styles.req}>
                        {f.required ? <span className={styles.yes}>Yes</span> : <span className={styles.no}>—</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
