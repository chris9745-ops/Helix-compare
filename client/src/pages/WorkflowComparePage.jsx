import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  getConnections, startWorkflowCompare, getWorkflowCompare, getWorkflowCompareObject, getWorkflowStatus,
  compareExportUrl
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { useAuthUser } from '../components/AuthGate';
import PageHeader from '../components/PageHeader';
import ExportDef from '../components/ExportDef';
import Button from '../components/Button';
import { Notice, Badge, ActionBlock } from './WorkflowPage';
import shared from './WorkflowPage.module.css';
import styles from './WorkflowComparePage.module.css';

const KINDS = [
  { key: 'activeLink', label: 'Active Links' },
  { key: 'filter', label: 'Filters' },
  { key: 'escalation', label: 'Escalations' }
];
const KIND_SHORT = { activeLink: 'AL', filter: 'FLT', escalation: 'ESC' };
const EXCLUDE_KEY = 'helix-wf-compare-exclude';
const readExclude = () => { try { return localStorage.getItem(EXCLUDE_KEY) || ''; } catch { return ''; } };
const saveExclude = (v) => { try { localStorage.setItem(EXCLUDE_KEY, v); } catch { /* private mode etc. */ } };
const SUGGESTED_EXCLUDES = ['zSLMGen:*'];

const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

// ── detail: one object, both sides ──────────────────────────────────────────

function SideSummary({ title, d }) {
  if (!d) return <div className={styles.sideMissing}><strong>{title}</strong><span>Not on this server</span></div>;
  return (
    <div className={styles.side}>
      <div className={styles.sideTitle}>{title}</div>
      <div className={shared.detailBadges}>
        <Badge tone={d.enabled ? 'green' : 'red'}>{d.enabled ? 'Enabled' : 'Disabled'}</Badge>
        {d.order !== null && <Badge>Order {d.order}</Badge>}
        {d.executeOn.map(x => <Badge key={x} tone="purple">{x}</Badge>)}
        {d.schedule && <Badge tone="teal">{d.schedule}</Badge>}
      </div>
      <h3 className={shared.sectionTitle}>{d.kind === 'escalation' ? 'Qualification' : 'Run If'}</h3>
      <pre className={shared.code}>{d.runIf || '(always)'}</pre>
      <ActionBlock title="If Actions" actions={d.actions} />
      <ActionBlock title="Else Actions" actions={d.elseActions} />
    </div>
  );
}

function ChangeRow({ c, leftName, rightName }) {
  return (
    <div className={styles.change}>
      <div className={styles.changeHead}>
        <span>{c.aspect}</span>
        <span className={`${styles.changeKind} ${styles[`k_${c.kind}`]}`}>{c.kind}</span>
      </div>
      <div className={styles.changeCols}>
        <div className={`${styles.col} ${c.left === null ? styles.colEmpty : styles.colOld}`}>
          <div className={styles.colTitle}>{leftName}</div>
          <pre>{c.left === null ? '— not present —' : c.left}</pre>
        </div>
        <div className={`${styles.col} ${c.right === null ? styles.colEmpty : styles.colNew}`}>
          <div className={styles.colTitle}>{rightName}</div>
          <pre>{c.right === null ? '— not present —' : c.right}</pre>
        </div>
      </div>
    </div>
  );
}

function CompareDetail({ jobId, item, leftName, rightName }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['wf-compare-object', jobId, item.kind, item.name],
    queryFn: () => getWorkflowCompareObject(jobId, item.kind, item.name),
    staleTime: 5 * 60 * 1000, retry: false
  });
  if (isLoading) return <div className={shared.placeholder}>Loading {item.name}…</div>;
  if (error) return <Notice tone="error" title="Could not read this object">{errorText(error)}</Notice>;
  const both = data.left && data.right;
  return (
    <div className={shared.detail}>
      <div className={shared.detailHead}>
        <div className={shared.detailName}>{item.name}</div>
        <div className={shared.detailBadges}>
          <Badge tone="purple">{KINDS.find(k => k.key === item.kind).label.replace(/s$/, '')}</Badge>
          {item.status === 'modified' && item.aspects.map(a => <Badge key={a} tone="amber">{a}</Badge>)}
        </div>
      </div>

      {both && data.changes.length === 0 && (
        <Notice title="Differences not visible in the readable view">
          The definitions differ ({(item.aspects || []).join(', ') || 'metadata'}) in properties this view doesn't
          render — for example permissions, or field-level settings — so there is nothing to show side by side yet.
        </Notice>
      )}
      {both && data.changes.map((c, i) => <ChangeRow key={i} c={c} leftName={leftName} rightName={rightName} />)}

      {!both && (
        <div className={styles.sides}>
          <SideSummary title={leftName} d={data.left} />
          <SideSummary title={rightName} d={data.right} />
        </div>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function WorkflowComparePage() {
  const hosted = useAuthUser()?.hosted;
  const { activeConnectionId } = useAppStore();
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });
  const { data: status } = useQuery({ queryKey: ['wf-status'], queryFn: getWorkflowStatus, enabled: !hosted, retry: false });

  const usable = useMemo(() => connections.filter(c => c.arPort), [connections]);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [scopeType, setScopeType] = useState('form');
  const [form, setForm] = useState('');
  const [pattern, setPattern] = useState('');
  const [kinds, setKinds] = useState({ activeLink: true, filter: true, escalation: true });
  const [exclude, setExclude] = useState(readExclude);
  const [jobId, setJobId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(null);
  const [exportInclude, setExportInclude] = useState({ onlyLeft: true, modified: true });

  // sensible defaults: the sidebar's instance on the left, the next one on the right
  useEffect(() => {
    if (!usable.length) return;
    setLeftId(l => (usable.some(c => c.id === l) ? l : (usable.find(c => c.id === activeConnectionId) || usable[0]).id));
  }, [usable, activeConnectionId]);
  useEffect(() => {
    if (!usable.length) return;
    setRightId(r => {
      if (usable.some(c => c.id === r) && r !== leftId) return r;
      return (usable.find(c => c.id !== leftId) || {}).id || '';
    });
  }, [usable, leftId]);

  const start = useMutation({
    mutationFn: () => startWorkflowCompare({
      leftConnId: leftId, rightConnId: rightId,
      kinds: KINDS.map(k => k.key).filter(k => kinds[k]),
      scope: {
        ...(scopeType === 'form' ? { type: 'form', form: form.trim() } : { type: 'pattern', pattern: pattern.trim() }),
        exclude: exclude.split(/[\n,]+/).map(x => x.trim()).filter(Boolean)
      }
    }),
    onSuccess: (r) => { saveExclude(exclude); setJobId(r.jobId); setSelected(null); setStatusFilter('all'); setText(''); }
  });

  const job = useQuery({
    queryKey: ['wf-compare', jobId],
    queryFn: () => getWorkflowCompare(jobId),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' || !q.state.data ? 1000 : false),
    retry: false
  });
  const j = job.data;
  const done = j?.status === 'done';

  const items = useMemo(() => {
    if (!done) return [];
    const t = text.trim().toLowerCase();
    return j.result.items.filter(i =>
      (statusFilter === 'all' || i.status === statusFilter) && (!t || i.name.toLowerCase().includes(t)));
  }, [done, j, statusFilter, text]);

  const totals = useMemo(() => {
    const out = { onlyLeft: 0, onlyRight: 0, modified: 0, same: 0 };
    if (done) for (const s of Object.values(j.result.summary)) for (const k of Object.keys(out)) out[k] += s[k];
    return out;
  }, [done, j]);

  if (hosted) {
    return (
      <div className={shared.page}>
        <PageHeader title="Workflow compare" subtitle="Dev vs Prod" />
        <div className={shared.body}>
          <Notice title="Desktop app only">
            Workflow is read through your own BMC Client Gateway, which this site can't reach. Use the desktop app.
          </Notice>
        </div>
      </div>
    );
  }

  const leftName = j?.left.name || connections.find(c => c.id === leftId)?.name || 'Left';
  const rightName = j?.right.name || connections.find(c => c.id === rightId)?.name || 'Right';
  const noneChosen = !KINDS.some(k => kinds[k.key]);
  const scopeReady = scopeType === 'form' ? form.trim().length > 0 : pattern.replace(/\*/g, '').trim().length >= 2;
  const canRun = leftId && rightId && leftId !== rightId && !noneChosen && scopeReady && status?.ready && !start.isPending
    && j?.status !== 'running';

  return (
    <div className={shared.page}>
      <PageHeader title="Workflow compare" subtitle="Active Links, Filters and Escalations between two instances — read-only" />

      <div className={styles.config}>
        {usable.length < 2 && (
          <Notice title="Two instances with an AR server port are needed">
            Open <strong>Workflow</strong> and set the AR server host/port (Client Gateway) for each instance you want
            to compare — for example Dev on 46000 and Prod on 48000.
          </Notice>
        )}
        {status && !status.ready && (
          <Notice tone="error" title="The workflow helper isn't set up yet">{status.problems.join(' ')}</Notice>
        )}

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Left (e.g. Dev)</span>
            <select value={leftId} onChange={e => setLeftId(e.target.value)}>
              {usable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <span className={styles.vs}>vs</span>
          <label className={styles.field}>
            <span>Right (e.g. Prod)</span>
            <select value={rightId} onChange={e => setRightId(e.target.value)}>
              {usable.filter(c => c.id !== leftId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        <div className={styles.row}>
          <div className={styles.modes} role="tablist">
            <button className={scopeType === 'form' ? styles.modeOn : ''} onClick={() => setScopeType('form')}>One form</button>
            <button className={scopeType === 'pattern' ? styles.modeOn : ''} onClick={() => setScopeType('pattern')}>Names matching</button>
          </div>
          {scopeType === 'form' ? (
            <input
              className={styles.scopeInput} placeholder="Form name, e.g. HPD:Help Desk — everything attached to it"
              value={form} onChange={e => setForm(e.target.value)}
            />
          ) : (
            <input
              className={styles.scopeInput} placeholder="Name or wildcard, e.g. HPD:INC:*  or  *_Resolve*"
              value={pattern} onChange={e => setPattern(e.target.value)}
            />
          )}
        </div>

        <div className={styles.row}>
          <label className={`${styles.field} ${styles.grow}`}>
            <span>
              Exclude names <span className={styles.hintInline}>(optional; one per line or comma-separated, * is a wildcard)</span>
            </span>
            <input
              className={styles.scopeInput} value={exclude} spellCheck={false}
              placeholder="e.g. zSLMGen:*  — generated objects that legitimately differ between environments"
              onChange={e => setExclude(e.target.value)}
            />
          </label>
          {SUGGESTED_EXCLUDES.filter(x => !exclude.split(/[\n,]+/).map(p => p.trim()).includes(x)).map(x => (
            <button key={x} type="button" className={styles.suggest} onClick={() => setExclude(e => (e.trim() ? `${e.trim()}, ${x}` : x))}>
              + {x}
            </button>
          ))}
        </div>

        <div className={styles.row}>
          {KINDS.map(k => (
            <label key={k.key} className={styles.check}>
              <input type="checkbox" checked={kinds[k.key]} onChange={e => setKinds(s => ({ ...s, [k.key]: e.target.checked }))} />
              {k.label}
            </label>
          ))}
          <div className={styles.spacer} />
          <Button variant="primary" loading={start.isPending || j?.status === 'running'} disabled={!canRun} onClick={() => start.mutate()}>
            Compare
          </Button>
        </div>
        {start.isError && <div className={styles.inlineError}>{errorText(start.error)}</div>}
      </div>

      {j?.status === 'running' && (
        <div className={styles.progress}>
          <div className={styles.bar}><div style={{ width: `${Math.round((j.progress.step / j.progress.steps) * 100)}%` }} /></div>
          <span>{j.progress.label}</span>
        </div>
      )}
      {j?.status === 'error' && <Notice tone="error" title="Compare failed">{j.error}</Notice>}
      {job.error && <Notice tone="error" title="Lost the compare job">{errorText(job.error)}</Notice>}

      {done && (
        <>
          <div className={styles.summary}>
            {KINDS.filter(k => j.result.summary[k.key]).map(k => {
              const s = j.result.summary[k.key];
              return (
                <div key={k.key} className={styles.summaryCard}>
                  <div className={styles.summaryTitle}>{k.label}</div>
                  <div className={styles.summaryNums}>
                    <span title={`Only in ${leftName}`} className={styles.nLeft}>{s.onlyLeft} only {leftName}</span>
                    <span title={`Only in ${rightName}`} className={styles.nRight}>{s.onlyRight} only {rightName}</span>
                    <span title="Different" className={styles.nMod}>{s.modified} different</span>
                    <span className={styles.nSame}>{s.same} identical</span>
                    {s.excluded > 0 && <span className={styles.nSame} title="Matched an exclude pattern and were left out">{s.excluded} excluded</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.toolbar}>
            {[
              ['all', `All differences (${totals.onlyLeft + totals.onlyRight + totals.modified})`],
              ['modified', `Different (${totals.modified})`],
              ['onlyLeft', `Only in ${leftName} (${totals.onlyLeft})`],
              ['onlyRight', `Only in ${rightName} (${totals.onlyRight})`]
            ].map(([key, label]) => (
              <button key={key} className={statusFilter === key ? styles.chipOn : styles.chip} onClick={() => { setStatusFilter(key); setSelected(null); }}>
                {label}
              </button>
            ))}
            <input className={styles.filter} placeholder="Filter by name…" value={text} onChange={e => setText(e.target.value)} />
            <ExportDef
              label="Export .def…"
              endpoint={`/workflow/compare/${jobId}/export-def`}
              body={{ include: Object.keys(exportInclude).filter(k => exportInclude[k]) }}
              count={(exportInclude.onlyLeft ? totals.onlyLeft : 0) + (exportInclude.modified ? totals.modified : 0)}
              disabled={!exportInclude.onlyLeft && !exportInclude.modified}
              note={`Definitions taken from ${leftName}, ready to import into ${rightName} with your usual BMC process. The manifest lists the forms they need that ${rightName} doesn't have.`}
            >
              <div className={styles.exportOpts}>
                <label>
                  <input type="checkbox" checked={exportInclude.onlyLeft} onChange={e => setExportInclude(x => ({ ...x, onlyLeft: e.target.checked }))} />
                  Only on {leftName} ({totals.onlyLeft})
                </label>
                <label>
                  <input type="checkbox" checked={exportInclude.modified} onChange={e => setExportInclude(x => ({ ...x, modified: e.target.checked }))} />
                  Different — {leftName}'s version ({totals.modified})
                </label>
              </div>
            </ExportDef>
            <span className={styles.exports}>
              <a className={styles.exportBtn} href={compareExportUrl(jobId, { format: 'md', details: true })} download
                 title="Markdown report including what changed in each different object">Report (.md)</a>
              <a className={styles.exportBtn} href={compareExportUrl(jobId, { format: 'csv' })} download
                 title="One row per object, for a spreadsheet">CSV</a>
            </span>
          </div>

          <div className={shared.split}>
            <aside className={shared.listPane}>
              <div className={shared.names}>
                {items.length === 0 && (
                  <div className={shared.placeholder}>
                    {totals.onlyLeft + totals.onlyRight + totals.modified === 0
                      ? `No differences — ${totals.same} identical object${totals.same === 1 ? '' : 's'}.`
                      : 'Nothing matches.'}
                  </div>
                )}
                {items.map(i => (
                  <button
                    key={`${i.kind}:${i.name}`}
                    className={`${shared.nameRow} ${selected && selected.kind === i.kind && selected.name === i.name ? shared.nameOn : ''}`}
                    onClick={() => setSelected(i)}
                    title={i.name}
                  >
                    <span className={`${styles.dot} ${styles[`s_${i.status}`]}`} />
                    <span className={styles.kindTag}>{KIND_SHORT[i.kind]}</span>
                    {i.name}
                  </button>
                ))}
              </div>
            </aside>
            <section className={shared.detailPane}>
              {selected
                ? <CompareDetail jobId={jobId} item={selected} leftName={leftName} rightName={rightName} />
                : <div className={shared.placeholder}>Select an object to see what differs.</div>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
