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

  const run = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch('/api/helix/diagnostic', {
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
        subtitle="Probe which internal AR System forms are accessible on your instance"
        actions={
          <Button variant="primary" onClick={run} loading={loading} disabled={!activeConnectionId}>
            Run diagnostic
          </Button>
        }
      />
      <div className={styles.content}>
        {!activeConnectionId && (
          <div className={styles.warn}>Select a connection first</div>
        )}
        {error && <div className={styles.error}>✗ {error}</div>}
        {results && (
          <div className={styles.results}>
            <div className={styles.hint}>
              Forms with status <span className={styles.ok}>200</span> are accessible.
              These are the ones we can use to read workflow objects.
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
