import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMenu } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './WorkflowPage.module.css';

export default function MenusPage() {
  const { activeConnectionId } = useAppStore();
  const [menuName, setMenuName] = useState('');
  const [lookupName, setLookupName] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['menu', activeConnectionId, lookupName],
    queryFn: () => getMenu(lookupName),
    enabled: !!activeConnectionId && !!lookupName
  });

  if (!activeConnectionId) return (
    <div className={styles.noConn}><div className={styles.noConnIcon}>≡</div><div>No instance selected</div></div>
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Menus"
        subtitle="BMC's REST API only supports looking up a menu by exact name — there's no bulk-list endpoint"
      />
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          placeholder="Exact menu name…"
          value={menuName}
          onChange={e => setMenuName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setLookupName(menuName)}
        />
        <Button variant="primary" onClick={() => setLookupName(menuName)} disabled={!menuName}>
          Look up
        </Button>
      </div>
      <div className={styles.list}>
        {isLoading && <div className={styles.loading}>Loading menu…</div>}
        {error && <div className={styles.errorBox}>✗ {error.response?.data?.error || error.message}</div>}
        {data && (
          <div style={{ margin: '0 16px 16px', background: 'var(--bg-raised)', border: '1px solid var(--border-md)', borderRadius: 'var(--radius)', padding: '12px' }}>
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
