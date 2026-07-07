import { useState } from 'react';
import { useAppStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import styles from './DiagnosticPage.module.css';

export default function DiagnosticPage() {
  const { activeConnectionId } = useAppStore();
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [customForms, setCustomForms] = useState('');

  const run = async (forms) => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const url = forms
        ? `/api/helix/diagnostic?forms=${encodeURIComponent(forms)}`
        : '/api/helix/diagnostic';
      const res = await fetch(url, {
        headers: { 'X-Connection-Id': activeConnectionId }
      });
      const data = await res.json();
      setResults(data.results);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Diagnostics"
        subtitle="Probe which forms are accessible on your instance via the REST entry API"
        actions={
          <Button variant="primary" onClick={() => run()} loading={loading} disabled={!activeConnectionId}>
            Run default probe
          </Button>
        }
      />
      <div className={styles.content}>
        {!activeConnectionId && (
          <div className={styles.warn}>Select a connection first</div>
        )}

        <div className={styles.customProbe}>
          <div className={styles.hint}>
            Not sure of a form's exact name (e.g. an SRM catalog form or a DWP admin config form)?
            Type one or more candidate names below (comma-separated) and test them directly, instead of guessing in Compare.
          </div>
          <div className={styles.customProbeRow}>
            <input
              className={styles.customProbeInput}
              placeholder="e.g. SRD:Request, SRM:Request Catalog, DWP:Branding…"
              value={customForms}
              onChange={e => setCustomForms(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && customForms.trim() && run(customForms)}
            />
            <Button onClick={() => run(customForms)} loading={loading} disabled={!activeConnectionId || !customForms.trim()}>
              Test these
            </Button>
          </div>
        </div>

        {error && <div className={styles.error}>✗ {error}</div>}
        {results && (
          <div className={styles.results}>
            <div className={styles.hint}>
              Forms with status <span className={styles.ok}>200</span> are accessible.
              These are the ones you can use in Compare.
            </div>
            <div className={styles.table}>
              <div className={styles.thead}>
                <span>Form name</span><span>Status</span><span>Detail</span>
              </div>
              {Object.entries(results).map(([form, result]) => (
                <div key={form} className={`${styles.trow} ${result.status === 200 ? styles.success : styles.fail}`}>
                  <span className={styles.formName}>{form}</span>
                  <span className={styles.status}>{result.status}</span>
                  <span className={styles.detail}>
                    {result.status === 200
                      ? `✓ accessible`
                      : result.error || '—'}
                    {result.contentType && (
                      <div className={styles.rawDetail}>
                        content-type: {result.contentType}
                        {result.raw && <><br />{typeof result.raw === 'string' ? result.raw : JSON.stringify(result.raw)}</>}
                      </div>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
