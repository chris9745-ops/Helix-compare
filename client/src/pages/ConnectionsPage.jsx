import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getConnections, createConnection, deleteConnection, testConnection } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './ConnectionsPage.module.css';

function ConnectionForm({ onSave, onCancel }) {
  const [form, setForm] = useState({
    name: '', baseUrl: '', username: '', password: '', authString: '', ignoreSSL: false
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const qc = useQueryClient();
  const { mutate, isPending, error } = useMutation({
    mutationFn: createConnection,
    onSuccess: () => { qc.invalidateQueries(['connections']); onSave?.(); }
  });

  return (
    <div className={styles.formCard}>
      <div className={styles.formTitle}>Add connection</div>
      {error && (
        <div className={styles.errorBanner}>
          {error.response?.data?.error || error.message}
        </div>
      )}
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Name</span>
          <input placeholder="e.g. Production ITSM" value={form.name} onChange={e => set('name', e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Base URL</span>
          <input placeholder="https://helix.company.com" value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} />
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Username</span>
            <input placeholder="Demo" value={form.username} onChange={e => set('username', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Password</span>
            <input type="password" placeholder="••••••••" value={form.password} onChange={e => set('password', e.target.value)} />
          </label>
        </div>
        <label className={styles.field}>
          <span>Auth String <span className={styles.optional}>(optional — only needed for LDAP / SSO / domain auth)</span></span>
          <input
            placeholder="e.g. LDAP or domain\\username — leave blank for standard auth"
            value={form.authString}
            onChange={e => set('authString', e.target.value)}
          />
        </label>
        <label className={styles.checkField}>
          <input type="checkbox" checked={form.ignoreSSL} onChange={e => set('ignoreSSL', e.target.checked)} />
          <span>Ignore SSL certificate errors (self-signed / dev instances)</span>
        </label>
      </div>
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          loading={isPending}
          disabled={!form.name || !form.baseUrl || !form.username || !form.password}
          onClick={() => mutate(form)}
        >
          Save connection
        </Button>
      </div>
    </div>
  );
}

function ConnectionCard({ conn }) {
  const [testStatus, setTestStatus] = useState(null);
  const [testMsg, setTestMsg] = useState('');
  const { activeConnectionId, setActiveConnection } = useAppStore();
  const qc = useQueryClient();

  const isActive = activeConnectionId === conn.id;

  const { mutate: remove } = useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => qc.invalidateQueries(['connections'])
  });

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMsg('');
    try {
      await testConnection(conn.id);
      setTestStatus('ok');
      setTestMsg('Auth successful');
    } catch (e) {
      setTestStatus('error');
      setTestMsg(e.response?.data?.error || e.message);
    }
  };

  return (
    <div className={`${styles.card} ${isActive ? styles.cardActive : ''}`}>
      <div className={styles.cardHeader}>
        <div className={styles.cardDot} />
        <div className={styles.cardMeta}>
          <div className={styles.cardName}>{conn.name}</div>
          <div className={styles.cardUrl}>{conn.baseUrl}</div>
        </div>
        <div className={styles.cardBadge}>
          <span className={styles.user}>{conn.username}</span>
        </div>
      </div>

      {testStatus && (
        <div className={`${styles.testResult} ${styles[testStatus]}`}>
          {testStatus === 'testing' && '⟳ Testing connection…'}
          {testStatus === 'ok' && `✓ ${testMsg}`}
          {testStatus === 'error' && (
            <div>
              <div>✗ {testMsg}</div>
              <div className={styles.testHint}>
                Check: URL reachable? Credentials correct? Try enabling Ignore SSL if on an internal server.
              </div>
            </div>
          )}
        </div>
      )}

      <div className={styles.cardActions}>
        <Button size="sm" onClick={handleTest} loading={testStatus === 'testing'}>
          Test auth
        </Button>
        <Button
          size="sm"
          variant={isActive ? 'ghost' : 'primary'}
          onClick={() => setActiveConnection(isActive ? null : conn.id)}
        >
          {isActive ? 'Disconnect' : 'Use this instance'}
        </Button>
        <Button size="sm" variant="danger" onClick={() => remove(conn.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  const [showForm, setShowForm] = useState(false);
  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: getConnections
  });

  return (
    <div className={styles.page}>
      <PageHeader
        title="Connections"
        subtitle="Manage Helix AR System instances"
        actions={
          !showForm && (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              + Add connection
            </Button>
          )
        }
      />
      <div className={styles.content}>
        {showForm && (
          <ConnectionForm
            onSave={() => setShowForm(false)}
            onCancel={() => setShowForm(false)}
          />
        )}
        {isLoading && <div className={styles.empty}>Loading…</div>}
        {!isLoading && connections.length === 0 && !showForm && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>⬡</div>
            <div>No connections yet</div>
            <div className={styles.emptyHint}>Add a Helix 25+ instance to get started</div>
          </div>
        )}
        <div className={styles.grid}>
          {connections.map(c => <ConnectionCard key={c.id} conn={c} />)}
        </div>
      </div>
    </div>
  );
}
