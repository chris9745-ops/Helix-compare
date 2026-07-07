import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMenus, getMenu } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import styles from './WorkflowPage.module.css';

export default function MenusPage() {
  const { activeConnectionId } = useAppStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['menus', activeConnectionId],
    queryFn: getMenus,
    enabled: !!activeConnectionId
  });

  const items = (data?.items || data || []);
  const filtered = items.filter(m => !search || m.name?.toLowerCase().includes(search.toLowerCase()));

  if (!activeConnectionId) return (
    <div className={styles.noConn}><div className={styles.noConnIcon}>≡</div><div>No instance selected</div></div>
  );

  return (
    <div className={styles.page}>
      <PageHeader title="Menus" subtitle={`${filtered.length} menus`} />
      <div className={styles.toolbar}>
        <input className={styles.search} placeholder="Search menus…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className={styles.list}>
        {isLoading && <div className={styles.loading}>Loading menus…</div>}
        {error && <div className={styles.errorBox}>✗ {error.response?.data?.error || error.message}</div>}
        {filtered.map(m => (
          <div key={m.name} className={styles.row} onClick={() => setSelected(m === selected ? null : m)}>
            <div className={styles.rowMain}>
              <span className={styles.rowName}>{m.name}</span>
              <div className={styles.rowBadges}>
                {m.menuType && (
                  <span className={`${styles.badge} ${styles.badge_teal}`}>{m.menuType}</span>
                )}
              </div>
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
