import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getEscalations } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import styles from './WorkflowPage.module.css';

export default function EscalationsPage() {
  const { activeConnectionId } = useAppStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['escalations', activeConnectionId],
    queryFn: getEscalations,
    enabled: !!activeConnectionId
  });

  const items = (data?.items || data || []);
  const filtered = items.filter(e => !search || e.name?.toLowerCase().includes(search.toLowerCase()));

  if (!activeConnectionId) return (
    <div className={styles.noConn}><div className={styles.noConnIcon}>⬡</div><div>No instance selected</div></div>
  );

  return (
    <div className={styles.page}>
      <PageHeader title="Escalations" subtitle={`${filtered.length} of ${items.length} shown`} />
      <div className={styles.toolbar}>
        <input className={styles.search} placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className={styles.list}>
        {isLoading && <div className={styles.loading}>Loading escalations…</div>}
        {error && <div className={styles.errorBox}>✗ {error.response?.data?.error || error.message}</div>}
        {filtered.map(e => (
          <div key={e.name} className={styles.row} onClick={() => setSelected(e === selected ? null : e)}>
            <div className={styles.rowMain}>
              <span className={styles.rowName}>{e.name}</span>
              <div className={styles.rowBadges}>
                {e.pollingInterval && (
                  <span className={`${styles.badge} ${styles.badge_blue}`}>
                    every {e.pollingInterval}s
                  </span>
                )}
              </div>
            </div>
            <div className={styles.rowMeta}>
              <span className={styles.form}>{e.schemaName}</span>
              {e.enabled === false && <span className={styles.disabled}>Disabled</span>}
            </div>
          </div>
        ))}
        {selected && (
          <div style={{ margin: '0 16px 16px', background: 'var(--bg-raised)', border: '1px solid var(--border-md)', borderRadius: 'var(--radius)', padding: '12px' }}>
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(selected, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
