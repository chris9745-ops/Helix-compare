import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getActiveLinks, getActiveLink, deleteActiveLink } from '../lib/api';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import ActiveLinkDrawer from '../components/ActiveLinkDrawer';
import styles from './WorkflowPage.module.css';

const TRIGGER_COLORS = {
  Button: 'purple', 'Field Change': 'blue', Submit: 'green',
  Modify: 'amber', Display: 'teal', Return: 'coral', Default: 'gray'
};

const ACTION_COLORS = {
  'Set Fields': 'green', Message: 'amber', 'Push Fields': 'coral',
  'Open Window': 'blue', 'Run Process': 'purple', 'Call Guide': 'teal',
  Default: 'gray'
};

function Badge({ label, type }) {
  const color = TRIGGER_COLORS[label] || TRIGGER_COLORS.Default;
  return <span className={`${styles.badge} ${styles[`badge_${color}`]}`}>{label}</span>;
}

function ActionBadge({ label }) {
  const color = ACTION_COLORS[label] || ACTION_COLORS.Default;
  return <span className={`${styles.badge} ${styles[`badge_${color}`]}`}>{label}</span>;
}

function ALRow({ al, onSelect, onDelete }) {
  const actions = al.actions || [];
  const actionTypes = [...new Set(actions.map(a => a.actionType || a.type || '?'))];

  return (
    <div className={styles.row} onClick={() => onSelect(al)}>
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{al.name}</span>
        <div className={styles.rowBadges}>
          {al.executionOrder != null && (
            <span className={styles.order}>#{al.executionOrder}</span>
          )}
          {al.triggerType && <Badge label={al.triggerType} />}
          {actionTypes.slice(0, 3).map(t => <ActionBadge key={t} label={t} />)}
        </div>
      </div>
      <div className={styles.rowMeta}>
        {al.schemaName && <span className={styles.form}>{al.schemaName}</span>}
        {al.enabled === false && <span className={styles.disabled}>Disabled</span>}
      </div>
      <div className={styles.rowActions} onClick={e => e.stopPropagation()}>
        <Button size="sm" variant="ghost" onClick={() => onSelect(al)}>View</Button>
        <Button size="sm" variant="danger" onClick={() => onDelete(al.name)}>Del</Button>
      </div>
    </div>
  );
}

export default function ActiveLinksPage() {
  const { activeConnectionId } = useAppStore();
  const [search, setSearch] = useState('');
  const [formFilter, setFormFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['activelinks', activeConnectionId, formFilter],
    queryFn: () => getActiveLinks(formFilter || undefined),
    enabled: !!activeConnectionId
  });

  const { mutate: remove } = useMutation({
    mutationFn: deleteActiveLink,
    onSuccess: () => qc.invalidateQueries(['activelinks'])
  });

  const items = (data?.items || data || []);
  const filtered = items.filter(al =>
    !search || al.name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = async (al) => {
    setSelected(al);
    setDrawerOpen(true);
  };

  if (!activeConnectionId) {
    return (
      <div className={styles.noConn}>
        <div className={styles.noConnIcon}>⬡</div>
        <div>No instance selected</div>
        <div className={styles.noConnHint}>Choose a connection from the sidebar to browse active links</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Active Links"
        subtitle={`${filtered.length} of ${items.length} shown`}
        actions={
          <Button variant="primary" onClick={() => { setSelected(null); setDrawerOpen(true); }}>
            + New Active Link
          </Button>
        }
      />

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          placeholder="Search by name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <input
          className={styles.formInput}
          placeholder="Filter by form…"
          value={formFilter}
          onChange={e => setFormFilter(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && qc.invalidateQueries(['activelinks'])}
        />
      </div>

      <div className={styles.list}>
        {isLoading && <div className={styles.loading}>Loading active links…</div>}
        {error && (
          <div className={styles.errorBox}>
            ✗ {error.response?.data?.error || error.message}
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className={styles.empty}>No active links found</div>
        )}
        {filtered.map(al => (
          <ALRow key={al.name} al={al} onSelect={handleSelect} onDelete={remove} />
        ))}
      </div>

      {drawerOpen && (
        <ActiveLinkDrawer
          name={selected?.name}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
