import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGatewayStatus, startGateway, stopGateway, getGatewayLog, saveGatewaySettings
} from '../lib/api';
import Button from './Button';
import styles from './GatewayStatus.module.css';

const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

const LABEL = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  external: 'Running (started elsewhere)',
  unconfigured: 'Not set up'
};
const TONE = { running: 'ok', starting: 'warn', stopping: 'warn', stopped: 'off', external: 'ok', unconfigured: 'off' };

/** Gateway state, polled; faster while it is changing. */
export function useGatewayStatus({ enabled = true } = {}) {
  return useQuery({
    queryKey: ['gateway-status'],
    queryFn: getGatewayStatus,
    enabled,
    retry: false,
    refetchInterval: (q) => (['starting', 'stopping'].includes(q.state.data?.state) ? 1500 : 6000)
  });
}

/** A one-line indicator for the sidebar. */
export function GatewayPill({ onClick }) {
  const { data } = useGatewayStatus();
  if (!data) return null;
  return (
    <button className={styles.pill} onClick={onClick} title="Client Gateway — click for details">
      <span className={`${styles.dot} ${styles[`dot_${TONE[data.state]}`]}`} />
      Gateway: {LABEL[data.state]}
    </button>
  );
}

/** Full control: start/stop, ports, auto-start, folder and log. */
export function GatewayPanel() {
  const qc = useQueryClient();
  const { data: g, error: statusError } = useGatewayStatus();
  const [showLog, setShowLog] = useState(false);
  const [dir, setDir] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['gateway-status'] });

  const start = useMutation({ mutationFn: startGateway, onSettled: refresh });
  const stop = useMutation({ mutationFn: stopGateway, onSettled: refresh });
  const save = useMutation({
    mutationFn: (s) => saveGatewaySettings(s),
    onSuccess: () => { setDir(''); refresh(); }
  });
  const log = useQuery({
    queryKey: ['gateway-log'], queryFn: () => getGatewayLog(80),
    enabled: showLog, refetchInterval: showLog ? 3000 : false, retry: false
  });

  if (statusError) return null;                       // hosted site, or server unreachable: nothing to show
  if (!g) return <div className={styles.panel}><span className={styles.muted}>Checking the gateway…</span></div>;

  const busy = start.isPending || stop.isPending || ['starting', 'stopping'].includes(g.state);
  const err = start.error || stop.error || save.error;
  const upCount = g.services.filter(s => s.listening).length;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={`${styles.dot} ${styles[`dot_${TONE[g.state]}`]}`} />
        <strong>Client Gateway</strong>
        <span className={styles.state}>{LABEL[g.state]}</span>
        {g.services.length > 0 && <span className={styles.muted}>{upCount} of {g.services.length} ports open</span>}
        <div className={styles.spacer} />
        {g.state === 'stopped' && (
          <Button size="sm" variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Start gateway</Button>
        )}
        {(g.state === 'running' || g.state === 'starting') && (
          <Button size="sm" loading={stop.isPending} disabled={g.state === 'starting' && !stop.isPending} onClick={() => stop.mutate()}>Stop</Button>
        )}
      </div>

      {g.state === 'external' && (
        <div className={styles.note}>
          A gateway is already running on this computer, started outside the app (probably in a terminal).
          You can use it as it is. To have the app manage it instead, press Ctrl-C in the window that started it, then
          choose <em>Start gateway</em> here.
        </div>
      )}
      {g.state === 'unconfigured' && (
        <div className={styles.note}>
          The app doesn't know where the BMC Client Gateway is. Enter the folder that contains
          <code> conf/kwic-config.xml </code> and <code>lib</code> below.
        </div>
      )}
      {g.problems.filter(() => g.state !== 'unconfigured').map((p, i) => <div key={i} className={styles.warn}>{p}</div>)}
      {err && <div className={styles.error}>{errorText(err)}</div>}

      {g.services.length > 0 && (
        <ul className={styles.services}>
          {g.services.map(s => (
            <li key={`${s.name}:${s.port}`}>
              <span className={`${styles.dot} ${s.listening ? styles.dot_ok : styles.dot_off}`} />
              <span className={styles.svcName}>{s.name}</span>
              <span className={styles.port}>127.0.0.1:{s.port}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.foot}>
        <label className={styles.check}>
          <input
            type="checkbox" checked={g.autoStart} disabled={g.state === 'unconfigured' || save.isPending}
            onChange={e => save.mutate({ autoStart: e.target.checked })}
          />
          Start the gateway when the app opens
        </label>
        <button className={styles.link} onClick={() => setShowLog(v => !v)}>{showLog ? 'Hide log' : 'Show log'}</button>
      </div>

      {showLog && (
        <pre className={styles.log}>{(log.data || []).join('\n') || 'No output yet.'}</pre>
      )}

      <details className={styles.where} open={g.state === 'unconfigured'}>
        <summary>{g.dir ? 'Gateway folder' : 'Choose the gateway folder'}</summary>
        {g.dir && <div className={styles.path}>{g.dir}{g.source ? <span className={styles.muted}> ({g.source})</span> : null}</div>}
        <form className={styles.dirForm} onSubmit={e => { e.preventDefault(); if (dir.trim()) save.mutate({ gatewayDir: dir.trim() }); }}>
          <input
            value={dir} onChange={e => setDir(e.target.value)} spellCheck={false}
            placeholder="Folder containing conf/kwic-config.xml and lib"
          />
          <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!dir.trim()}>Use this folder</Button>
        </form>
      </details>
    </div>
  );
}
