import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getConnections, updateConnection, getWorkflowStatus, getWorkflowForms,
  getFormWorkflow, searchWorkflow, getWorkflowObject
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { useAuthUser } from '../components/AuthGate';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './WorkflowPage.module.css';

const KINDS = [
  { key: 'activeLink', label: 'Active Links', listKey: 'activeLinks' },
  { key: 'filter', label: 'Filters', listKey: 'filters' },
  { key: 'escalation', label: 'Escalations', listKey: 'escalations' }
];
const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

// ── pieces ───────────────────────────────────────────────────────────────────

function Notice({ tone = 'info', title, children }) {
  return (
    <div className={`${styles.notice} ${styles[`notice_${tone}`]}`}>
      {title && <div className={styles.noticeTitle}>{title}</div>}
      <div>{children}</div>
    </div>
  );
}

function EndpointEditor({ conn, compact }) {
  const qc = useQueryClient();
  const [host, setHost] = useState(conn.arHost || '');
  const [port, setPort] = useState(conn.arPort ? String(conn.arPort) : '');
  useEffect(() => { setHost(conn.arHost || ''); setPort(conn.arPort ? String(conn.arPort) : ''); }, [conn.id, conn.arHost, conn.arPort]);
  const save = useMutation({
    mutationFn: () => updateConnection(conn.id, { arHost: host.trim(), arPort: port.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] })
  });
  const form = (
    <div className={styles.endpoint}>
      <label>
        <span>Host</span>
        <input value={host} placeholder="127.0.0.1" onChange={e => setHost(e.target.value)} />
      </label>
      <label>
        <span>Port</span>
        <input value={port} placeholder="46000" inputMode="numeric" onChange={e => setPort(e.target.value)} />
      </label>
      <Button variant="primary" size="sm" loading={save.isPending} disabled={!port.trim()} onClick={() => save.mutate()}>
        Save
      </Button>
      {save.isError && <span className={styles.inlineError}>{errorText(save.error)}</span>}
    </div>
  );
  if (!compact) return form;
  return (
    <details className={styles.endpointDetails}>
      <summary>AR server: {conn.arHost || '127.0.0.1'}:{conn.arPort}</summary>
      {form}
    </details>
  );
}

function Badge({ tone = 'gray', children }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

function ActionBlock({ title, actions }) {
  if (!actions?.length) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <ol className={styles.actions}>
        {actions.map((a, i) => (
          <li key={i} className={styles.action}>
            <div className={styles.actionLabel}>{a.label}</div>
            {a.lines.map((l, j) => <div key={j} className={styles.actionLine}>{l}</div>)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Detail({ connId, kind, name }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['wf-object', connId, kind, name],
    queryFn: () => getWorkflowObject(connId, kind, name),
    staleTime: 5 * 60 * 1000,
    retry: false
  });
  if (isLoading) return <div className={styles.placeholder}>Loading {name}…</div>;
  if (error) return <Notice tone="error" title="Could not read this object">{errorText(error)}</Notice>;
  const d = data;
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <div className={styles.detailName}>{d.name}</div>
        <div className={styles.detailBadges}>
          <Badge tone="purple">{d.kindLabel}</Badge>
          <Badge tone={d.enabled ? 'green' : 'red'}>{d.enabled ? 'Enabled' : 'Disabled'}</Badge>
          {d.order !== null && <Badge>Order {d.order}</Badge>}
          {d.application && <Badge tone="teal">{d.application}</Badge>}
        </div>
      </div>

      <dl className={styles.meta}>
        <dt>{d.forms.length > 1 ? `Forms (${d.forms.length})` : 'Form'}</dt>
        <dd className={styles.mono}>
          {d.forms.slice(0, 6).join(', ') || d.primaryForm || '—'}
          {d.forms.length > 6 && <span className={styles.muted}> … +{d.forms.length - 6} more</span>}
        </dd>
        {d.executeOn.length > 0 && (<><dt>Execute on</dt><dd>{d.executeOn.join(' · ')}</dd></>)}
        {d.schedule && (<><dt>Schedule</dt><dd>{d.schedule}</dd></>)}
        {d.lastChanged && (
          <><dt>Last changed</dt><dd>{new Date(d.lastChanged).toLocaleString()}{d.lastChangedBy ? ` by ${d.lastChangedBy}` : ''}</dd></>
        )}
        {d.owner && (<><dt>Owner</dt><dd>{d.owner}</dd></>)}
      </dl>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{d.kind === 'escalation' ? 'Qualification' : 'Run If'}</h3>
        <pre className={styles.code}>{d.runIf || '(always)'}</pre>
      </section>

      <ActionBlock title="If Actions" actions={d.actions} />
      <ActionBlock title="Else Actions" actions={d.elseActions} />
      {d.helpText && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Help text</h3>
          <pre className={styles.code}>{d.helpText}</pre>
        </section>
      )}
      <details className={styles.raw}>
        <summary>Raw definition</summary>
        <pre className={styles.code}>{JSON.stringify(d.raw, null, 2)}</pre>
      </details>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  const hosted = useAuthUser()?.hosted;
  const { activeConnectionId } = useAppStore();
  const [mode, setMode] = useState('form');          // 'form' | 'search'
  const [form, setForm] = useState('');
  const [submittedForm, setSubmittedForm] = useState('');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [kind, setKind] = useState('activeLink');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);   // { kind, name }

  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });
  const conn = connections.find(c => c.id === activeConnectionId);
  const ready = !hosted && conn && conn.arPort;

  const { data: status } = useQuery({
    queryKey: ['wf-status'], queryFn: getWorkflowStatus, enabled: !hosted, retry: false, staleTime: 60 * 1000
  });
  const usable = ready && status?.ready;

  const forms = useQuery({
    queryKey: ['wf-forms', activeConnectionId],
    queryFn: () => getWorkflowForms(activeConnectionId),
    enabled: !!usable, staleTime: 10 * 60 * 1000, retry: false
  });

  const byForm = useQuery({
    queryKey: ['wf-form', activeConnectionId, submittedForm],
    queryFn: () => getFormWorkflow(activeConnectionId, submittedForm),
    enabled: !!usable && mode === 'form' && !!submittedForm, staleTime: 60 * 1000, retry: false
  });

  const search = useQuery({
    queryKey: ['wf-search', activeConnectionId, kind, submittedQuery],
    queryFn: () => searchWorkflow(activeConnectionId, kind, submittedQuery),
    enabled: !!usable && mode === 'search' && submittedQuery.trim().length >= 2, staleTime: 60 * 1000, retry: false
  });

  const names = useMemo(() => {
    const all = mode === 'form'
      ? (byForm.data?.[KINDS.find(k => k.key === kind).listKey] || [])
      : (search.data?.names || []);
    const f = filter.trim().toLowerCase();
    return f ? all.filter(n => n.toLowerCase().includes(f)) : all;
  }, [mode, byForm.data, search.data, kind, filter]);

  useEffect(() => { setSelected(null); setFilter(''); }, [activeConnectionId, kind, submittedForm, submittedQuery, mode]);

  if (hosted) {
    return (
      <div className={styles.page}>
        <PageHeader title="Workflow" subtitle="Active Links, Filters and Escalations" />
        <div className={styles.body}>
          <Notice tone="info" title="Desktop app only">
            Workflow lives behind the native AR API, which this site cannot reach: it talks to your BMC Client
            Gateway on your own computer. Open the desktop app on a machine with the gateway running.
          </Notice>
        </div>
      </div>
    );
  }

  const header = <PageHeader title="Workflow" subtitle="Active Links, Filters and Escalations — read-only, via the native AR API" />;

  if (!conn) {
    return (
      <div className={styles.page}>{header}
        <div className={styles.body}><Notice title="Pick an instance">Choose an instance in the sidebar first.</Notice></div>
      </div>
    );
  }
  if (!conn.arPort) {
    return (
      <div className={styles.page}>{header}
        <div className={styles.body}>
          <Notice title={`Where is ${conn.name}'s AR server?`}>
            Workflow is read through the BMC Client Gateway running on this computer. Enter its address for this
            instance — Dev Studio used <code>127.0.0.1</code> and a port such as <code>46000</code> (Dev),
            <code> 47000</code> (QA), <code>48000</code> (Prod). Your Helix username and password from this
            connection are used to log in.
          </Notice>
          <EndpointEditor conn={conn} />
        </div>
      </div>
    );
  }
  if (status && !status.ready) {
    return (
      <div className={styles.page}>{header}
        <div className={styles.body}>
          <Notice tone="error" title="The workflow helper isn't set up yet">
            <ul className={styles.problems}>{status.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
            <p>
              Set <code>HELIX_AR_LIB</code> to the folder containing <code>arapi*.jar</code> (from your Developer
              Studio kit) and, if needed, <code>HELIX_JAVA</code> to a Java 8–14 runtime, then restart the app.
            </p>
          </Notice>
        </div>
      </div>
    );
  }

  const listError = forms.error || byForm.error || search.error;
  const loading = byForm.isFetching || search.isFetching;
  const kindMeta = KINDS.find(k => k.key === kind);

  return (
    <div className={styles.page}>
      {header}
      <div className={styles.toolbar}>
        <div className={styles.modes} role="tablist">
          <button className={mode === 'form' ? styles.modeOn : ''} onClick={() => setMode('form')}>By form</button>
          <button className={mode === 'search' ? styles.modeOn : ''} onClick={() => setMode('search')}>Search by name</button>
        </div>

        {mode === 'form' ? (
          <form className={styles.lookup} onSubmit={e => { e.preventDefault(); setSubmittedForm(form.trim()); }}>
            <input
              className={styles.formInput}
              list="wf-form-names"
              placeholder={forms.isLoading ? 'Loading forms…' : `Form name (${(forms.data || []).length.toLocaleString()} on server)`}
              value={form}
              onChange={e => setForm(e.target.value)}
            />
            <datalist id="wf-form-names">
              {(forms.data || []).map(f => <option key={f} value={f} />)}
            </datalist>
            <Button type="submit" variant="primary" loading={byForm.isFetching} disabled={!form.trim()}>Show workflow</Button>
          </form>
        ) : (
          <form className={styles.lookup} onSubmit={e => { e.preventDefault(); setSubmittedQuery(query.trim()); }}>
            <input
              className={styles.formInput}
              placeholder={`Part of a ${kindMeta.label.toLowerCase().replace(/s$/, '')} name (2+ characters)`}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <Button type="submit" variant="primary" loading={search.isFetching} disabled={query.trim().length < 2}>Search</Button>
          </form>
        )}
        <EndpointEditor conn={conn} compact />
      </div>

      {listError && (
        <Notice tone="error" title="Could not reach the AR server">
          {errorText(listError)}
        </Notice>
      )}

      <div className={styles.split}>
        <aside className={styles.listPane}>
          <div className={styles.kindTabs}>
            {KINDS.map(k => (
              <button key={k.key} className={kind === k.key ? styles.kindOn : ''} onClick={() => setKind(k.key)}>
                {k.label}
                {mode === 'form' && byForm.data && <span className={styles.count}>{byForm.data[k.listKey].length}</span>}
              </button>
            ))}
          </div>
          <input
            className={styles.filterInput}
            placeholder="Filter this list…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <div className={styles.names}>
            {loading && <div className={styles.placeholder}>Loading…</div>}
            {!loading && mode === 'form' && !submittedForm && (
              <div className={styles.placeholder}>Pick a form to see what runs on it.</div>
            )}
            {!loading && mode === 'search' && !submittedQuery && (
              <div className={styles.placeholder}>Search across every {kindMeta.label.toLowerCase()} on the server.</div>
            )}
            {!loading && (byForm.data || search.data) && names.length === 0 && (
              <div className={styles.placeholder}>Nothing matches.</div>
            )}
            {names.map(n => (
              <button
                key={n}
                className={`${styles.nameRow} ${selected?.name === n && selected.kind === kind ? styles.nameOn : ''}`}
                onClick={() => setSelected({ kind, name: n })}
                title={n}
              >
                {n}
              </button>
            ))}
            {mode === 'search' && search.data && search.data.matched > search.data.names.length && (
              <div className={styles.placeholder}>
                Showing {search.data.names.length.toLocaleString()} of {search.data.matched.toLocaleString()} — narrow the search.
              </div>
            )}
          </div>
        </aside>

        <section className={styles.detailPane}>
          {selected && selected.kind === kind
            ? <Detail connId={activeConnectionId} kind={selected.kind} name={selected.name} />
            : <div className={styles.placeholder}>Select an object to read its qualification and actions.</div>}
        </section>
      </div>
    </div>
  );
}
