import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getConnections, getWorkflowStatus, getWorkflowForms, getLayoutViews, getLayoutFields, getLayoutCompare,
  layoutExportUrl
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { useAuthUser } from '../components/AuthGate';
import PageHeader from '../components/PageHeader';
import { Notice, Badge } from './WorkflowPage';
import shared from './WorkflowPage.module.css';
import styles from './FormLayoutPage.module.css';

const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';
const FONT_UNITS = 1000;            // text height in the server's coordinate units (a field is ~2100 high)

const STATUS_COLOR = { modified: '#fbbf24', onlyLeft: '#f87171', onlyRight: '#4ade80' };

// ── geometry ─────────────────────────────────────────────────────────────────

/** children by parent id, with the page (tab) selection resolved per page holder */
function buildTree(fields) {
  const byId = new Map(fields.map(f => [f.id, f]));
  const kids = new Map();
  for (const f of fields) {
    if (f.parent === null) continue;
    if (!kids.has(f.parent)) kids.set(f.parent, []);
    kids.get(f.parent).push(f);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0) || a.id - b.id);
  return { byId, kids, roots: (kids.get(0) || []) };
}

/** Flatten into drawable rectangles in absolute coordinates. */
function layoutRects(fields, pageChoice, showHidden) {
  const { kids, roots } = buildTree(fields);
  const out = [];
  const walk = (f, origin, depth) => {
    if (!f.box || f.box.w <= 0 || f.box.h <= 0) return;
    if (f.visible === false && !showHidden) return;
    const x = origin.x + f.box.x, y = origin.y + f.box.y;
    out.push({ f, x, y, w: f.box.w, h: f.box.h, depth });
    const children = kids.get(f.id) || [];
    if (f.type === 'Page Holder') {
      const pages = children.filter(c => c.type === 'Page');
      const chosen = pageChoice[f.id] !== undefined ? pageChoice[f.id] : (pages[0] && pages[0].id);
      for (const p of pages) {
        if (p.id !== chosen) continue;
        // a page's own box is where its body sits; its children are in the holder's space
        if (p.box && p.box.w > 0) out.push({ f: p, x: x + p.box.x, y: y + p.box.y, w: p.box.w, h: p.box.h, depth: depth + 1 });
        for (const c of kids.get(p.id) || []) walk(c, { x, y }, depth + 2);
      }
      for (const c of children) if (c.type !== 'Page') walk(c, { x, y }, depth + 1);
    } else {
      for (const c of children) walk(c, { x, y }, depth + 1);
    }
  };
  for (const r of roots) walk(r, { x: 0, y: 0 }, 0);
  return out;
}

function pageHolders(fields) {
  const { kids } = buildTree(fields);
  return fields
    .filter(f => f.type === 'Page Holder')
    .map(h => ({ holder: h, pages: (kids.get(h.id) || []).filter(c => c.type === 'Page') }))
    .filter(h => h.pages.length > 0);
}

// ── wireframe ────────────────────────────────────────────────────────────────

function Wireframe({ fields, statusById, selectedId, onSelect, pageChoice, showHidden }) {
  const rects = useMemo(() => layoutRects(fields, pageChoice, showHidden), [fields, pageChoice, showHidden]);
  if (rects.length === 0) {
    return <div className={shared.placeholder}>Nothing placed on this view (it may use a progressive/responsive layout).</div>;
  }
  const maxX = Math.max(...rects.map(r => r.x + r.w)) + 400;
  const maxY = Math.max(...rects.map(r => r.y + r.h)) + 400;
  return (
    <svg className={styles.svg} viewBox={`0 0 ${maxX} ${maxY}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label="Form layout wireframe">
      {rects.map(({ f, x, y, w, h, depth }) => {
        const status = statusById && statusById.get(f.id);
        const stroke = status ? STATUS_COLOR[status] : f.container ? '#6a6a88' : '#4a4a62';
        const isSel = selectedId === f.id;
        const label = f.label || f.name;
        return (
          <g key={`${f.id}-${depth}`} onClick={(e) => { e.stopPropagation(); onSelect(f.id); }} className={styles.field}>
            <title>{`${f.name} (${f.type}) #${f.id}${f.label ? ` — ${f.label}` : ''}`}</title>
            <rect
              x={x} y={y} width={w} height={h}
              fill={f.container ? 'rgba(123,110,246,0.05)' : status ? `${STATUS_COLOR[status]}22` : 'rgba(255,255,255,0.03)'}
              stroke={isSel ? '#ffffff' : stroke}
              strokeWidth={isSel ? 3 : status ? 2.5 : 1.2}
              strokeDasharray={f.visible === false ? '6 4' : undefined}
              vectorEffect="non-scaling-stroke"
              rx={60}
            />
            {!f.container && h >= FONT_UNITS && (
              <text x={x + 120} y={y + h / 2 + FONT_UNITS * 0.33} fontSize={FONT_UNITS} className={styles.svgText}>
                {String(label).slice(0, Math.max(3, Math.floor(w / (FONT_UNITS * 0.62))))}
              </text>
            )}
            {f.container && (
              <text x={x + 120} y={y + FONT_UNITS * 1.05} fontSize={FONT_UNITS * 0.85} className={styles.svgContainerText}>
                {f.type}: {String(label).slice(0, 40)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── field table ──────────────────────────────────────────────────────────────

const fmtBox = (b) => (b ? `${b.x}, ${b.y}  ·  ${b.w} × ${b.h}` : '—');

function FieldTable({ fields, statusById, selectedId, onSelect, text }) {
  const names = useMemo(() => new Map(fields.map(f => [f.id, f.label || f.name])), [fields]);
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return [...fields]
      .filter(f => !t || f.name.toLowerCase().includes(t) || (f.label || '').toLowerCase().includes(t) || String(f.id) === t)
      .sort((a, b) => (a.tabOrder ?? 1e9) - (b.tabOrder ?? 1e9) || a.name.localeCompare(b.name));
  }, [fields, text]);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr><th>Label</th><th>Field</th><th>ID</th><th>Type</th><th>Visible</th><th>Access</th><th>Tab</th><th>Position · Size</th><th>Container</th></tr>
        </thead>
        <tbody>
          {rows.map(f => {
            const st = statusById && statusById.get(f.id);
            return (
              <tr key={f.id} className={`${selectedId === f.id ? styles.rowOn : ''}`} onClick={() => onSelect(f.id)}>
                <td>{st && <span className={styles.dot} style={{ background: STATUS_COLOR[st] }} />}{f.label || <span className={styles.nil}>—</span>}</td>
                <td className={styles.mono}>{f.name}</td>
                <td className={styles.mono}>{f.id}</td>
                <td>{f.type}</td>
                <td>{f.visible === null ? '—' : f.visible ? 'Yes' : <span className={styles.hidden}>Hidden</span>}</td>
                <td>{f.access || '—'}</td>
                <td>{f.tabOrder ?? '—'}</td>
                <td className={styles.mono}>{fmtBox(f.box)}</td>
                <td>{f.parent ? names.get(f.parent) || `#${f.parent}` : f.parent === 0 ? <span className={styles.nil}>top level</span> : <span className={styles.nil}>not placed</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className={shared.placeholder}>No fields match.</div>}
    </div>
  );
}

// ── compare list ─────────────────────────────────────────────────────────────

function describeChange(item, aspect) {
  const l = item.left, r = item.right;
  switch (aspect) {
    case 'Name': return [l.name, r.name];
    case 'Label': return [l.label || '—', r.label || '—'];
    case 'Visibility': return [l.visible ? 'Visible' : 'Hidden', r.visible ? 'Visible' : 'Hidden'];
    case 'Access': return [l.access || '—', r.access || '—'];
    case 'Container': return [l.parent === null ? 'not placed' : `#${l.parent}`, r.parent === null ? 'not placed' : `#${r.parent}`];
    case 'Position': return [l.box ? `${l.box.x}, ${l.box.y}` : '—', r.box ? `${r.box.x}, ${r.box.y}` : '—'];
    case 'Size': return [l.box ? `${l.box.w} × ${l.box.h}` : '—', r.box ? `${r.box.w} × ${r.box.h}` : '—'];
    case 'Label placement': return [fmtBox(l.labelBox), fmtBox(r.labelBox)];
    case 'Tab order': return [l.tabOrder ?? '—', r.tabOrder ?? '—'];
    case 'Stacking order': return [l.zOrder ?? '—', r.zOrder ?? '—'];
    default: return ['', ''];
  }
}

function CompareList({ items, leftName, rightName, selectedId, onSelect, filter }) {
  const rows = items.filter(i => filter === 'all' || i.status === filter);
  if (rows.length === 0) return <div className={shared.placeholder}>No differences of this kind.</div>;
  return (
    <div className={styles.cmpList}>
      {rows.map(i => (
        <div key={i.id} className={`${styles.cmpItem} ${selectedId === i.id ? styles.rowOn : ''}`} onClick={() => onSelect(i.id)}>
          <div className={styles.cmpHead}>
            <span className={styles.dot} style={{ background: STATUS_COLOR[i.status] }} />
            <strong>{i.label || i.name}</strong>
            <span className={styles.mono}>{i.name} · #{i.id}</span>
            <span className={styles.cmpType}>{i.type}</span>
          </div>
          {i.status === 'onlyLeft' && <div className={styles.cmpNote}>Only on {leftName}</div>}
          {i.status === 'onlyRight' && <div className={styles.cmpNote}>Only on {rightName}</div>}
          {i.status === 'modified' && (
            <table className={styles.cmpTable}>
              <thead><tr><th /><th>{leftName}</th><th>{rightName}</th></tr></thead>
              <tbody>
                {i.aspects.map(a => {
                  const [lv, rv] = describeChange(i, a);
                  return <tr key={a}><td>{a}</td><td className={styles.mono}>{String(lv)}</td><td className={styles.mono}>{String(rv)}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function FormLayoutPage() {
  const hosted = useAuthUser()?.hosted;
  const { activeConnectionId } = useAppStore();
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: getConnections });
  const conn = connections.find(c => c.id === activeConnectionId);
  const others = connections.filter(c => c.arPort && c.id !== activeConnectionId);

  const [formInput, setFormInput] = useState('');
  const [form, setForm] = useState('');
  const [viewId, setViewId] = useState('');
  const [tab, setTab] = useState('wireframe');
  const [text, setText] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [pageChoice, setPageChoice] = useState({});
  const [compareWith, setCompareWith] = useState('');
  const [cmpFilter, setCmpFilter] = useState('all');
  const [showBaseOnly, setShowBaseOnly] = useState(true);

  const { data: status } = useQuery({ queryKey: ['wf-status'], queryFn: getWorkflowStatus, enabled: !hosted, retry: false });
  const usable = !hosted && conn?.arPort && status?.ready;

  const forms = useQuery({
    queryKey: ['wf-forms', activeConnectionId], queryFn: () => getWorkflowForms(activeConnectionId),
    enabled: !!usable, staleTime: 10 * 60 * 1000, retry: false
  });
  const views = useQuery({
    queryKey: ['layout-views', activeConnectionId, form], queryFn: () => getLayoutViews(activeConnectionId, form),
    enabled: !!usable && !!form, staleTime: 10 * 60 * 1000, retry: false
  });
  const visibleViews = useMemo(
    () => (views.data || []).filter(v => !showBaseOnly || v.isBase), [views.data, showBaseOnly]);

  // default to the first base view whenever a form's views arrive
  useEffect(() => {
    if (!views.data) return;
    // prefer the form's main view ("Default User View" / "Default Administrator View") over small
    // special-purpose ones, which would otherwise win alphabetically
    const preferred = views.data.find(x => x.isBase && /^default/i.test(x.label))
      || views.data.find(x => x.isBase) || views.data[0];
    setViewId(v => (views.data.some(x => String(x.id) === String(v)) ? v : String(preferred?.id ?? '')));
  }, [views.data]);

  const fieldsQ = useQuery({
    queryKey: ['layout-fields', activeConnectionId, form, viewId],
    queryFn: () => getLayoutFields(activeConnectionId, form, Number(viewId)),
    enabled: !!usable && !!form && !!viewId, staleTime: 10 * 60 * 1000, retry: false
  });
  const view = (views.data || []).find(v => String(v.id) === String(viewId));

  const cmp = useQuery({
    queryKey: ['layout-compare', activeConnectionId, compareWith, form, view?.name],
    queryFn: () => getLayoutCompare({ leftConnId: activeConnectionId, rightConnId: compareWith, form, view: view.name }),
    enabled: !!usable && !!compareWith && !!form && !!view, staleTime: 5 * 60 * 1000, retry: false
  });

  useEffect(() => { setSelectedId(null); setPageChoice({}); }, [activeConnectionId, form, viewId]);

  const fields = fieldsQ.data || [];
  const statusById = useMemo(() => {
    if (!cmp.data || !compareWith) return null;
    return new Map(cmp.data.items.map(i => [i.id, i.status]));
  }, [cmp.data, compareWith]);
  // fields only on the right are drawn from the right's data so they show up in the picture too
  const drawFields = useMemo(() => {
    if (!cmp.data || !compareWith) return fields;
    const extra = cmp.data.items.filter(i => i.status === 'onlyRight').map(i => i.right);
    return [...fields, ...extra];
  }, [fields, cmp.data, compareWith]);
  const selected = drawFields.find(f => f.id === selectedId);
  const holders = useMemo(() => pageHolders(drawFields), [drawFields]);

  const header = <PageHeader title="Form layout" subtitle="Views and field placement — read-only, via the native AR API" />;
  if (hosted) {
    return <div className={shared.page}>{header}<div className={shared.body}><Notice title="Desktop app only">Layout is read through your own BMC Client Gateway, which this site can't reach.</Notice></div></div>;
  }
  if (!conn) return <div className={shared.page}>{header}<div className={shared.body}><Notice title="Pick an instance">Choose an instance in the sidebar first.</Notice></div></div>;
  if (!conn.arPort) {
    return <div className={shared.page}>{header}<div className={shared.body}><Notice title="AR server port needed">Set this instance's AR server host/port on the Workflow page first.</Notice></div></div>;
  }
  if (status && !status.ready) {
    return <div className={shared.page}>{header}<div className={shared.body}><Notice tone="error" title="The workflow helper isn't set up yet">Open the Workflow page to finish setup.</Notice></div></div>;
  }

  const leftName = conn.name;
  const rightName = connections.find(c => c.id === compareWith)?.name || 'Right';
  const error = forms.error || views.error || fieldsQ.error || cmp.error;

  return (
    <div className={shared.page}>
      {header}
      <div className={styles.toolbar}>
        <form className={styles.lookup} onSubmit={e => { e.preventDefault(); setForm(formInput.trim()); setViewId(''); }}>
          <input
            className={styles.formInput} list="layout-forms" value={formInput} onChange={e => setFormInput(e.target.value)}
            placeholder={forms.isLoading ? 'Loading forms…' : `Form name (${(forms.data || []).length.toLocaleString()} on server)`}
          />
          <datalist id="layout-forms">{(forms.data || []).map(f => <option key={f} value={f} />)}</datalist>
          <button className={styles.go} type="submit" disabled={!formInput.trim()}>Show layout</button>
        </form>

        <label className={styles.inline}>
          <span>View</span>
          <select value={viewId} onChange={e => setViewId(e.target.value)} disabled={!visibleViews.length}>
            {visibleViews.map(v => (
              <option key={v.id} value={v.id}>{v.label}{v.locale ? ` (${v.locale})` : ''}</option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={showBaseOnly} onChange={e => setShowBaseOnly(e.target.checked)} />
          Base views only
        </label>
        <label className={styles.inline}>
          <span>Compare with</span>
          <select value={compareWith} onChange={e => { setCompareWith(e.target.value); setCmpFilter('all'); }}>
            <option value="">— none —</option>
            {others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      {error && <Notice tone="error" title="Could not read the layout">{errorText(error)}</Notice>}

      {compareWith && cmp.data && (
        <div className={styles.cmpSummary}>
          <span className={styles.nMod}>{cmp.data.summary.modified} changed</span>
          <span className={styles.nLeft}>{cmp.data.summary.onlyLeft} only on {leftName}</span>
          <span className={styles.nRight}>{cmp.data.summary.onlyRight} only on {rightName}</span>
          <span className={styles.nSame}>{cmp.data.summary.same} identical</span>
          {cmp.data.summary.reordered > 0 && (
            <span className={styles.nSame} title="Only their stacking order differs, which has no visible effect on its own">
              {cmp.data.summary.reordered} reordered only
            </span>
          )}
          <div className={styles.spacer} />
          {view && (
            <span className={styles.exports}>
              <a className={styles.exportBtn} download
                 href={layoutExportUrl({ leftConnId: activeConnectionId, rightConnId: compareWith, form, view: view.name, format: 'md' })}>Report (.md)</a>
              <a className={styles.exportBtn} download
                 href={layoutExportUrl({ leftConnId: activeConnectionId, rightConnId: compareWith, form, view: view.name, format: 'csv' })}>CSV</a>
            </span>
          )}
          {[['all', 'All'], ['modified', 'Changed'], ['onlyLeft', `Only ${leftName}`], ['onlyRight', `Only ${rightName}`]].map(([k, l]) => (
            <button key={k} className={cmpFilter === k ? styles.chipOn : styles.chip} onClick={() => setCmpFilter(k)}>{l}</button>
          ))}
        </div>
      )}
      {compareWith && cmp.data && (cmp.data.views.onlyLeft.length > 0 || cmp.data.views.onlyRight.length > 0) && (
        <div className={styles.viewsNote}>
          {cmp.data.views.onlyLeft.length > 0 && (
            <div><strong>Views only on {leftName}:</strong> {cmp.data.views.onlyLeft.map(v => v.label || v.name).join(', ')}</div>
          )}
          {cmp.data.views.onlyRight.length > 0 && (
            <div><strong>Views only on {rightName}:</strong> {cmp.data.views.onlyRight.map(v => v.label || v.name).join(', ')}</div>
          )}
        </div>
      )}
      {compareWith && cmp.isFetching && <div className={shared.placeholder}>Comparing…</div>}

      {!form && <div className={shared.placeholder}>Enter a form name to see its views and layout.</div>}
      {form && (views.isFetching || fieldsQ.isFetching) && <div className={shared.placeholder}>Reading {form}…</div>}

      {form && fieldsQ.data && (
        <div className={styles.body}>
          <div className={styles.main}>
            <div className={styles.tabs}>
              <button className={tab === 'wireframe' ? styles.tabOn : ''} onClick={() => setTab('wireframe')}>Wireframe</button>
              <button className={tab === 'fields' ? styles.tabOn : ''} onClick={() => setTab('fields')}>Fields ({fields.length})</button>
              {compareWith && <button className={tab === 'changes' ? styles.tabOn : ''} onClick={() => setTab('changes')}>
                Differences ({cmp.data ? cmp.data.items.length : '…'})</button>}
              <div className={styles.spacer} />
              {tab === 'wireframe' && (
                <label className={styles.check}>
                  <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
                  Show hidden fields
                </label>
              )}
              {tab === 'fields' && (
                <input className={styles.filter} placeholder="Filter by name, label or id…" value={text} onChange={e => setText(e.target.value)} />
              )}
            </div>

            {tab === 'wireframe' && (
              <>
                {holders.length > 0 && (
                  <div className={styles.holders}>
                    {holders.map(({ holder, pages }) => {
                      const chosen = pageChoice[holder.id] !== undefined ? pageChoice[holder.id] : pages[0].id;
                      return (
                        <div key={holder.id} className={styles.holder}>
                          <span className={styles.holderName} title={holder.name}>{holder.label || holder.name}</span>
                          {pages.map(p => (
                            <button
                              key={p.id}
                              className={chosen === p.id ? styles.pageOn : styles.page}
                              onClick={() => setPageChoice(c => ({ ...c, [holder.id]: p.id }))}
                              title={p.name}
                            >{p.label || p.name}</button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className={styles.canvas} onClick={() => setSelectedId(null)}>
                  <Wireframe
                    fields={drawFields} statusById={statusById} selectedId={selectedId}
                    onSelect={setSelectedId} pageChoice={pageChoice} showHidden={showHidden}
                  />
                </div>
              </>
            )}
            {tab === 'fields' && (
              <FieldTable fields={drawFields} statusById={statusById} selectedId={selectedId} onSelect={setSelectedId} text={text} />
            )}
            {tab === 'changes' && cmp.data && (
              <CompareList
                items={cmp.data.items} leftName={leftName} rightName={rightName}
                selectedId={selectedId} onSelect={setSelectedId} filter={cmpFilter}
              />
            )}
          </div>

          <aside className={styles.side}>
            {selected ? (
              <div className={styles.card}>
                <div className={styles.cardTitle}>{selected.label || selected.name}</div>
                <div className={shared.detailBadges}>
                  <Badge tone="purple">{selected.type}</Badge>
                  {selected.visible === false && <Badge tone="red">Hidden</Badge>}
                  {selected.access && <Badge>{selected.access}</Badge>}
                </div>
                <dl className={shared.meta}>
                  <dt>Field</dt><dd className={shared.mono}>{selected.name}</dd>
                  <dt>ID</dt><dd className={shared.mono}>{selected.id}</dd>
                  <dt>Position</dt><dd className={shared.mono}>{selected.box ? `${selected.box.x}, ${selected.box.y}` : '—'}</dd>
                  <dt>Size</dt><dd className={shared.mono}>{selected.box ? `${selected.box.w} × ${selected.box.h}` : '—'}</dd>
                  <dt>Tab order</dt><dd>{selected.tabOrder ?? '—'}</dd>
                  <dt>Container</dt>
                  <dd>{selected.parent ? (drawFields.find(f => f.id === selected.parent)?.label || `#${selected.parent}`) : selected.parent === 0 ? 'Top level' : 'Not placed'}</dd>
                </dl>
              </div>
            ) : (
              <div className={shared.placeholder}>Click a field to see its details.</div>
            )}
            {statusById && (
              <div className={styles.legend}>
                <div><span className={styles.dot} style={{ background: STATUS_COLOR.modified }} />Changed</div>
                <div><span className={styles.dot} style={{ background: STATUS_COLOR.onlyLeft }} />Only on {leftName}</div>
                <div><span className={styles.dot} style={{ background: STATUS_COLOR.onlyRight }} />Only on {rightName}</div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
