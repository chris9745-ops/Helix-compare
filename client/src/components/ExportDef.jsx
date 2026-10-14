import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getExportFolder, setExportFolder, exportDefSave, exportDefDownload } from '../lib/api';
import Button from './Button';
import styles from './ExportDef.module.css';

const errorText = (e) => e?.response?.data?.error || e?.message || 'Something went wrong';

/**
 * Export objects as a BMC definition file (.def) or XML, either downloaded or saved to the export
 * folder together with a manifest. `endpoint` is POSTed `{ ...body, format, save }`.
 * `children` can render extra options inside the panel (they should update `body`).
 */
export default function ExportDef({ label = 'Export .def…', endpoint, body, count, disabled, children, note, align = 'right' }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState('def');
  const [dir, setDir] = useState('');
  const [result, setResult] = useState(null);

  const folder = useQuery({ queryKey: ['export-folder'], queryFn: getExportFolder, enabled: open, retry: false });
  const saveFolder = useMutation({
    mutationFn: () => setExportFolder(dir.trim()),
    onSuccess: () => { setDir(''); qc.invalidateQueries({ queryKey: ['export-folder'] }); }
  });
  const save = useMutation({ mutationFn: () => exportDefSave(endpoint, { ...body, format }), onSuccess: setResult });
  const download = useMutation({
    mutationFn: () => exportDefDownload(endpoint, { ...body, format }),
    onSuccess: (r) => setResult({ downloaded: r.name, objects: r.objects })
  });
  const err = save.error || download.error || saveFolder.error;
  const busy = save.isPending || download.isPending;
  const hasFolder = !!folder.data?.dir;

  return (
    <span className={styles.wrap}>
      <Button size="sm" onClick={() => { setOpen(v => !v); setResult(null); }} disabled={disabled}>{label}</Button>
      {open && (
        <div className={`${styles.panel} ${align === 'left' ? styles.alignLeft : ''}`} role="dialog" aria-label="Export definitions">
          <div className={styles.title}>
            Export {typeof count === 'number' ? `${count.toLocaleString()} object${count === 1 ? '' : 's'}` : 'definitions'}
            <button className={styles.close} onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>
          {note && <div className={styles.note}>{note}</div>}
          {children}

          <div className={styles.row}>
            <label><input type="radio" name="fmt" checked={format === 'def'} onChange={() => setFormat('def')} /> .def (AR System definition file)</label>
            <label><input type="radio" name="fmt" checked={format === 'xml'} onChange={() => setFormat('xml')} /> .xml</label>
          </div>

          <div className={styles.folder}>
            <div className={styles.folderLabel}>Export folder</div>
            {hasFolder
              ? <div className={styles.path}>{folder.data.dir}</div>
              : <div className={styles.muted}>Not set — choose where exports (and their manifests) are saved.</div>}
            <form className={styles.folderForm} onSubmit={e => { e.preventDefault(); if (dir.trim()) saveFolder.mutate(); }}>
              <input value={dir} onChange={e => setDir(e.target.value)} spellCheck={false}
                placeholder={hasFolder ? 'Change folder…' : 'e.g. ~/Documents/Helix exports'} />
              <Button type="submit" size="sm" loading={saveFolder.isPending} disabled={!dir.trim()}>Set</Button>
            </form>
          </div>

          <div className={styles.actions}>
            <Button variant="primary" size="sm" loading={save.isPending} disabled={!hasFolder || busy} onClick={() => save.mutate()}>
              Save to folder
            </Button>
            <Button size="sm" loading={download.isPending} disabled={busy} onClick={() => download.mutate()}>
              Download
            </Button>
          </div>

          {err && <div className={styles.error}>{errorText(err)}</div>}
          {result && result.saved && (
            <div className={styles.result}>
              <div className={styles.ok}>
                Saved {result.objects.toLocaleString()} object{result.objects === 1 ? '' : 's'}
                {result.definitions && result.definitions.total !== result.objects ? ` (${result.definitions.total.toLocaleString()} definitions incl. overlays)` : ''}
                {' '}in {result.saved.length} file{result.saved.length === 1 ? '' : 's'}.
              </div>
              <ul className={styles.files}>
                {result.saved.map(f => <li key={f.path}>{f.path}</li>)}
                <li>{result.manifestPath} <span className={styles.muted}>(manifest)</span></li>
              </ul>
              {Array.isArray(result.missingForms) && (
                result.missingForms.length > 0
                  ? <div className={styles.warn}>
                    <strong>{result.missingForms.length} form{result.missingForms.length === 1 ? '' : 's'} these objects use {result.missingForms.length === 1 ? 'is' : 'are'} not on the target</strong>
                    {' '}— see the manifest: {result.missingForms.slice(0, 4).join(', ')}{result.missingForms.length > 4 ? ' …' : ''}
                  </div>
                  : <div className={styles.okSmall}>Every form these objects use exists on the target.</div>
              )}
            </div>
          )}
          {result && result.downloaded && <div className={styles.ok}>Downloaded {result.downloaded}. Use "Save to folder" to also get the manifest.</div>}
        </div>
      )}
    </span>
  );
}
