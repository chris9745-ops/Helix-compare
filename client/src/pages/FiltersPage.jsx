import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getFilters, getFilter, updateFilter, createFilter } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './WorkflowPage.module.css';

const OPERATIONS = {
  Submit: 'green', Modify: 'amber', Display: 'teal',
  Delete: 'coral', Merge: 'purple', Default: 'gray'
};

export default function FiltersPage() {
  const { activeConnectionId } = useAppStore();
  const [search, setSearch] = useState('');
  const [formFilter, setFormFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['filters', activeConnectionId, formFilter],
    queryFn: () => getFilters(formFilter || undefined),
    enabled: !!activeConnectionId
  });

  const items = (data?.items || data || []);
  const filtered = items.filter(f => !search || f.name?.toLowerCase().includes(search.toLowerCase()));

  if (!activeConnectionId) return (
    <div className={styles.noConn}>
      <div className={styles.noConnIcon}>⬡</div>
      <div>No instance selected</div>
    </div>
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Filters"
        subtitle={`${filtered.length} of ${items.length} shown`}
        actions={<Button variant="primary">+ New Filter</Button>}
      />
      <div className={styles.toolbar}>
        <input className={styles.search} placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
        <input className={styles.formInput} placeholder="Filter by form…" value={formFilter} onChange={e => setFormFilter(e.target.value)} />
      </div>
      <div className={styles.list}>
        {isLoading && <div className={styles.loading}>Loading filters…</div>}
        {error && <div className={styles.errorBox}>✗ {error.response?.data?.error || error.message}</div>}
        {filtered.map(f => (
          <div key={f.name} className={styles.row} onClick={() => setSelected(f === selected ? null : f)}>
            <div className={styles.rowMain}>
              <span className={styles.rowName}>{f.name}</span>
              <div className={styles.rowBadges}>
                {f.executionOrder != null && <span className={styles.order}>#{f.executionOrder}</span>}
                {(f.operationSet || f.operations || []).map(op => (
                  <span key={op} className={`${styles.badge} ${styles[`badge_${OPERATIONS[op] || 'gray'}`]}`}>{op}</span>
                ))}
              </div>
            </div>
            <div className={styles.rowMeta}>
              <span className={styles.form}>{f.schemaName}</span>
              {f.enabled === false && <span className={styles.disabled}>Disabled</span>}
            </div>
          </div>
        ))}
        {selected && (
          <div className={styles.errorBox} style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)', borderColor: 'var(--border-md)' }}>
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(selected, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
