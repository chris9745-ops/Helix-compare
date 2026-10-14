import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getConnections, updateConnection, getWorkflowStatus, getWorkflowForms,
  getFormWorkflow, searchWorkflow, getWorkflowObject, saveWorkflowSettings
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { useAuthUser } from '../components/AuthGate';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import { GatewayPanel } from '../components/GatewayStatus';
import ExportDef from '../components/ExportDef';
import styles from './WorkflowPage.module.css';

const KINDS = [
  { key: 'activeLink', label: 'Active Links', listKey: 'activeLinks' },
  { key: 'filter', label: 'Filters', listKey: 'filters' },
  { key: 'escalation', label: 'Escalations', listKey: 'escalations' }
];
const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

// ── pieces ───────────────────────────────────────────────────────────────────

export function Notice({ tone = 'info', title, children }) {
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

/** Where the AR API jars and Java are. Used when setup is incomplete, and as a collapsed section otherwise. */
export function SetupPanel({ status, defaultOpen }) {
  const qc = useQueryClient();
  const [libDir, setLibDir] = useState(status.libDir || '');
  const [javaPath, setJavaPath] = useState('');
  const save = useMutation({
    mutationFn: () => saveWorkflowSettings({ libDir, ...(javaPath.trim() ? { javaPath } : {}) }),
    onSuccess: (s) => { setLibDir(s.libDir || ''); qc.invalidateQueries({ queryKey: ['wf-status'] }); }
  });
  const envLocked = status.source === 'environment';
  const checks = [
    { ok: status.javaMajor !== null && status.javaMajor <= 14, label: status.javaMajor !== null ? `Java ${status.javaMajor} found (needs 8–14)` : 'Java not found' },
    { ok: !!status.libDir && status.problems.every(p => !/arapi|jar folder/i.test(p)), label: status.libDir ? `AR API jars: ${status.libDir}` : 'AR API jars not set' }
  ];
  return (
    <details className={styles.setup} open={defaultOpen}>
      <summary>{status.ready ? 'Setup' : 'Setup needed'}</summary>
      <ul className={styles.checks}>
        {checks.map(c => <li key={c.label} className={c.ok ? styles.checkOk : styles.checkBad}>{c.ok ? '✓' : '✗'} {c.label}</li>)}
      </ul>
      {envLocked && (
        <div className={styles.noticeSmall}>
          <code>HELIX_AR_LIB</code> is set in this app's environment and takes priority over anything saved here.
        </div>
      )}
      <label className={styles.setupField}>
        <span>Folder containing <code>arapi*.jar</code></span>
        <input
          value={libDir}
          onChange={e => setLibDir(e.target.value)}
          placeholder="e.g. /Users/you/Documents/HMS/DeveloperStudio/x64 — the kit folder, or its lib folder"
          spellCheck={false}
        />
        <small>Any folder at or above the jars works; it is searched for you. These are BMC's files from your Developer Studio kit.</small>
      </label>
      <label className={styles.setupField}>
        <span>Java (optional)</span>
        <input
          value={javaPath}
          onChange={e => setJavaPath(e.target.value)}
          placeholder={`Leave blank to use "${status.java}"; must be Java 8–14`}
          spellCheck={false}
        />
      </label>
      <div className={styles.setupActions}>
        <Button variant="primary" loading={save.isPending} disabled={!libDir.trim() && !javaPath.trim()} onClick={() => save.mutate()}>
          Save and check
        </Button>
        {save.isError && <span className={styles.inlineError}>{errorText(save.error)}</span>}
        {save.isSuccess && <span className={styles.saved}>Saved.</span>}
      </div>
      <p className={styles.setupHint}>
        You also need the BMC Client Gateway running on this computer, and your Dev Studio login's port on the connection
        (Dev <code>46000</code>, QA <code>47000</code>, Prod <code>48000</code>).
      </p>
    </details>
  );
}

export function Badge({ tone = 'gray', children }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

export function ActionBlock({ title, actions }) {
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

export function Detail({ connId, kind, name }) {
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
        <div className={styles.detailTop}>
          <div className={styles.detailName}>{d.name}</div>
          <ExportDef
            endpoint={`/workflow/${connId}/export`}
            body={{ items: [{ kind, name }] }}
            count={1}
            note="Exports this object in the server's own definition format. Overlaid objects come with their overlay."
          />
        </div>
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
  const [exportKinds, setExportKinds] = useState({ activeLink: true, filter: true, escalation: true });
  const [includeForm, setIncludeForm] = useState(false);

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

  const header = (
    <>
      <PageHeader title="Workflow" subtitle="Active Links, Filters and Escalations — read-only, via the native AR API" />
      <GatewayPanel />
    </>
  );

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
          </Notice>
          <SetupPanel status={status} defaultOpen />
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

      {status && status.ready && (
        <div className={styles.setupBar}><SetupPanel status={status} /></div>
      )}

      {listError && (
        <Notice tone="error" title="Could not reach the AR server">
          {errorText(listError)}
        </Notice>
      )}

      <div className={styles.split}>
        <aside className={styles.listPane}>
          {mode === 'form' && byForm.data && (
            <div className={styles.listExport}>
              <ExportDef
                label="Export this form's workflow…"
                align="left"
                endpoint={`/workflow/${activeConnectionId}/export`}
                body={{
                  scope: {
                    type: 'form', form: submittedForm,
                    kinds: KINDS.map(k => k.key).filter(k => exportKinds[k]), includeForm
                  }
                }}
                count={
                  KINDS.filter(k => exportKinds[k.key]).reduce((n, k) => n + (byForm.data[k.listKey]?.length || 0), 0)
                  + (includeForm ? 1 : 0)
                }
                disabled={!KINDS.some(k => exportKinds[k.key]) && !includeForm}
                note="Everything attached to this form, as one definition file (several if there are more than 500)."
              >
                <div className={styles.exportOpts}>
                  {KINDS.map(k => (
                    <label key={k.key}>
                      <input type="checkbox" checked={exportKinds[k.key]} onChange={e => setExportKinds(x => ({ ...x, [k.key]: e.target.checked }))} />
                      {k.label} ({byForm.data[k.listKey]?.length || 0})
                    </label>
                  ))}
                  <label>
                    <input type="checkbox" checked={includeForm} onChange={e => setIncludeForm(e.target.checked)} />
                    The form definition itself (fields and views — large)
                  </label>
                </div>
              </ExportDef>
            </div>
          )}
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
