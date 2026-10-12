import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getConnections, getWorkflowStatus, getRecentChanges, recentExportUrl } from '../lib/api';
import { useAppStore } from '../lib/store';
import { useAuthUser } from '../components/AuthGate';
import PageHeader from '../components/PageHeader';
import { Notice, Badge, Detail } from './WorkflowPage';
import shared from './WorkflowPage.module.css';
import styles from './RecentChangesPage.module.css';

const KINDS = [
  { key: 'activeLink', label: 'Active Links', short: 'AL' },
  { key: 'filter', label: 'Filters', short: 'FLT' },
  { key: 'escalation', label: 'Escalations', short: 'ESC' }
];
const WINDOWS = [
  { key: '1', label: 'Last 24 hours' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'custom', label: 'Since a date…' }
];
const PAGE = 300;
const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export default function RecentChangesPage() {
  const hosted = useAuthUser()?.hosted;
  const { activeConnectionId } = useAppStore();
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });
  const conn = connections.find(c => c.id === activeConnectionId);
  const { data: status } = useQuery({ queryKey: ['wf-status'], queryFn: getWorkflowStatus, enabled: !hosted, retry: false });

  const [windowKey, setWindowKey] = useState('7');
  const [customDate, setCustomDate] = useState('');
  const [kinds, setKinds] = useState({ activeLink: true, filter: true, escalation: true });
  const [form, setForm] = useState('');
  const [submittedForm, setSubmittedForm] = useState('');
  const [person, setPerson] = useState('');
  const [text, setText] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState(null);

  const usable = !hosted && conn?.arPort && status?.ready;
  const kindList = KINDS.map(k => k.key).filter(k => kinds[k]);
  const dateOk = windowKey !== 'custom' || /^\d{4}-\d{2}-\d{2}$/.test(customDate);
  // a date picked here means the start of that day in the user's own time zone
  const params = useMemo(() => {
    const base = { kinds: kindList.join(','), form: submittedForm || undefined };
    if (windowKey === 'custom') return { ...base, since: customDate ? new Date(`${customDate}T00:00:00`).toISOString() : undefined };
    return { ...base, days: windowKey };
  }, [windowKey, customDate, kindList.join(','), submittedForm]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = useQuery({
    queryKey: ['wf-recent', activeConnectionId, params],
    queryFn: () => getRecentChanges(activeConnectionId, params),
    enabled: !!usable && dateOk && kindList.length > 0,
    staleTime: 60 * 1000, retry: false
  });

  useEffect(() => { setSelected(null); setShown(PAGE); }, [activeConnectionId, params, person, text]);

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (q.data?.rows || []).filter(r =>
      (!person || r.changedBy === person) && (!t || r.name.toLowerCase().includes(t) || (r.primaryForm || '').toLowerCase().includes(t)));
  }, [q.data, person, text]);
  const people = useMemo(() => Object.entries(q.data?.byUser || {}).sort((a, b) => b[1] - a[1]), [q.data]);

  const header = <PageHeader title="Recent changes" subtitle="What changed on this instance, and who changed it — read-only" />;
  if (hosted) {
    return <div className={shared.page}>{header}<div className={shared.body}><Notice title="Desktop app only">Workflow is read through your own BMC Client Gateway, which this site can't reach.</Notice></div></div>;
  }
  if (!conn) return <div className={shared.page}>{header}<div className={shared.body}><Notice title="Pick an instance">Choose an instance in the sidebar first.</Notice></div></div>;
  if (!conn.arPort) return <div className={shared.page}>{header}<div className={shared.body}><Notice title="AR server port needed">Set this instance's AR server host/port on the Workflow page first.</Notice></div></div>;
  if (status && !status.ready) return <div className={shared.page}>{header}<div className={shared.body}><Notice tone="error" title="The workflow helper isn't set up yet">Open the Workflow page to finish setup.</Notice></div></div>;

  const exportParams = { ...params, user: person || undefined };

  return (
    <div className={shared.page}>
      {header}
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>Changed since</span>
          <select value={windowKey} onChange={e => setWindowKey(e.target.value)}>
            {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        {windowKey === 'custom' && (
          <label className={styles.field}>
            <span>Date</span>
            <input type="date" value={customDate} max={new Date().toISOString().slice(0, 10)} onChange={e => setCustomDate(e.target.value)} />
          </label>
        )}
        <div className={styles.kinds}>
          {KINDS.map(k => (
            <label key={k.key} className={styles.check}>
              <input type="checkbox" checked={kinds[k.key]} onChange={e => setKinds(s => ({ ...s, [k.key]: e.target.checked }))} />
              {k.label}
            </label>
          ))}
        </div>
        <form className={styles.formBox} onSubmit={e => { e.preventDefault(); setSubmittedForm(form.trim()); }}>
          <input
            value={form} onChange={e => { setForm(e.target.value); if (!e.target.value.trim()) setSubmittedForm(''); }}
            placeholder="Limit to a form (optional)" spellCheck={false}
          />
          <button type="submit" disabled={!form.trim() || form.trim() === submittedForm}>Apply</button>
        </form>
        {q.data && (
          <span className={styles.exports}>
            <a className={styles.exportBtn} download href={recentExportUrl(activeConnectionId, exportParams, 'md')}>Report (.md)</a>
            <a className={styles.exportBtn} download href={recentExportUrl(activeConnectionId, exportParams, 'csv')}>CSV</a>
          </span>
        )}
      </div>

      {q.error && <Notice tone="error" title="Could not read recent changes">{errorText(q.error)}</Notice>}
      {q.isFetching && <div className={shared.placeholder}>Reading changes from {conn.name}… (this reads each changed object once)</div>}

      {q.data && !q.isFetching && (
        <>
          <div className={styles.people}>
            <button className={!person ? styles.chipOn : styles.chip} onClick={() => setPerson('')}>
              Everyone ({q.data.rows.length})
            </button>
            {people.map(([u, n]) => (
              <button key={u} className={person === u ? styles.chipOn : styles.chip} onClick={() => setPerson(person === u ? '' : u)}>
                {u} ({n})
              </button>
            ))}
            <input className={styles.filter} placeholder="Filter by name or form…" value={text} onChange={e => setText(e.target.value)} />
          </div>

          <div className={styles.split}>
            <aside className={`${shared.listPane} ${styles.listWide}`}>
              <div className={shared.names}>
                {rows.length === 0 && <div className={shared.placeholder}>Nothing changed in this window.</div>}
                {rows.slice(0, shown).map(r => {
                  const k = KINDS.find(x => x.key === r.kind);
                  const on = selected && selected.kind === r.kind && selected.name === r.name;
                  return (
                    <button key={`${r.kind}:${r.name}`} className={`${styles.row} ${on ? styles.rowOn : ''}`} onClick={() => setSelected(r)} title={r.name}>
                      <span className={styles.when} title={r.changedAt ? new Date(r.changedAt).toLocaleString() : ''}>{ago(r.changedAt)}</span>
                      <span className={styles.who}>{r.changedBy || '—'}</span>
                      <span className={styles.kindTag}>{k.short}</span>
                      <span className={styles.name}>{r.name}</span>
                      {!r.enabled && <span className={styles.off}>off</span>}
                    </button>
                  );
                })}
                {rows.length > shown && (
                  <button className={styles.more} onClick={() => setShown(n => n + PAGE)}>
                    Show {Math.min(PAGE, rows.length - shown)} more ({(rows.length - shown).toLocaleString()} left)
                  </button>
                )}
              </div>
            </aside>
            <section className={shared.detailPane}>
              {selected ? (
                <>
                  <div className={styles.metaBar}>
                    <Badge>{selected.changedBy || 'unknown'}</Badge>
                    <span>{selected.changedAt ? new Date(selected.changedAt).toLocaleString() : ''}</span>
                    {selected.primaryForm && <span className={styles.mono}>{selected.primaryForm}{selected.formCount > 1 ? ` (+${selected.formCount - 1})` : ''}</span>}
                  </div>
                  <Detail connId={activeConnectionId} kind={selected.kind} name={selected.name} />
                </>
              ) : (
                <div className={shared.placeholder}>Select a change to read the object as it is now.</div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
