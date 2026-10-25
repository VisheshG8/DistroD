"use client";

import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, Check, CircleHelp, FileJson, FolderOpen, Loader2, ShieldCheck, Upload, X } from 'lucide-react';
import { WorkspaceDialog } from './workspace-dialog';
import { base64ToBytes, bytesToBase64, collectWorkspacePreferences, downloadFile, MAX_BACKUP_BYTES, restoreWorkspacePreferences, TRANSFER_CHUNK_BYTES, transferRequest, type TransferResult, type TransferSummary } from '@/lib/workspace-transfer';

export default function WorkspaceTransfer({ ownerId, collections, pages, presentation, initialTab = 'export', onClose, onImported }: {
  ownerId: string; collections: number; pages: number; initialTab?: 'export' | 'import';
  presentation: { columns: Record<string, boolean>; overrides: Record<string, number> };
  onClose: () => void; onImported: (message: string) => Promise<void>;
}) {
  const [tab, setTab] = useState(initialTab), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [file, setFile] = useState<File | null>(null), [summary, setSummary] = useState<TransferSummary | null>(null);
  const [overwrite, setOverwrite] = useState(false), [settings, setSettings] = useState(false), [dragging, setDragging] = useState(false);
  const job = useRef<string | null>(null), abort = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null);
  const size = (bytes: number) => bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  async function cleanUp() {
    const id = job.current; job.current = null;
    if (id) { try { await transferRequest('cancel', { job: id }); } catch { /* Expiring staging is cleaned by the next transfer. */ } }
  }
  async function close() { if (!busy) { await cleanUp(); onClose(); } }
  function changeTab(next: 'export' | 'import') { if (!busy) { setTab(next); setError(''); setSuccess(''); } }
  async function chooseFile(next: File | null) {
    if (!next || busy) return;
    await cleanUp(); setSummary(null); setFile(null); setError(''); setSuccess(''); setProgress(0);
    if (!next.size || next.size > MAX_BACKUP_BYTES) { setError('Choose a JSON workspace backup smaller than 100 MB.'); return; }
    if (!next.name.toLowerCase().endsWith('.json')) { setError('Choose a .json workspace backup. CSV files are reports and cannot restore a workspace.'); return; }
    setFile(next);
  }
  async function exportBackup() {
    setBusy(true); setError(''); setSuccess(''); setProgress(0); setStatus('Preparing your complete workspace…');
    abort.current = new AbortController(); const signal = abort.current.signal;
    try {
      const start = await transferRequest<{ job: string; total: number; bytes: number }>('begin_export'); job.current = start.job; signal.throwIfAborted();
      const bytes = new Uint8Array(start.bytes);
      for (let index = 0; index < start.total; index++) {
        setStatus(`Preparing backup · ${index + 1} of ${start.total}`);
        const result = await transferRequest<{ chunk: string }>('read_export', { job: start.job, index }, signal);
        bytes.set(base64ToBytes(result.chunk), index * TRANSFER_CHUNK_BYTES); setProgress(Math.round((index + 1) / start.total * 95));
      }
      const archive = JSON.parse(new TextDecoder().decode(bytes));
      let localWarning = '';
      try { archive.preferences = { ...collectWorkspacePreferences(localStorage, ownerId), ...presentation }; }
      catch { archive.preferences = { ...presentation, scopes: {} }; localWarning = ' Browser storage was unavailable, so saved post selections were omitted.'; }
      const blob = new Blob([JSON.stringify(archive)], { type: 'application/json;charset=utf-8' });
      if (blob.size > MAX_BACKUP_BYTES) throw new Error('The backup and browser preferences exceed the 100 MB limit.');
      downloadFile(blob, `distribution-desk-workspace-${new Date().toISOString().slice(0, 10)}.json`);
      setProgress(100); setSuccess(`Backup downloaded. Sign in to the destination account, then choose Import backup.${localWarning}`);
    } catch (error) { setError(signal.aborted ? 'Transfer cancelled. You can download a new backup whenever you are ready.' : error instanceof Error ? error.message : 'The backup could not be downloaded.'); }
    finally { await cleanUp(); setBusy(false); setStatus(''); }
  }
  async function preview() {
    if (!file) return;
    setBusy(true); setError(''); setProgress(0); setStatus('Checking your backup…');
    abort.current = new AbortController(); const signal = abort.current.signal;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let archive; try { archive = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('This file is not valid JSON. Choose the original downloaded backup.'); }
      if (archive?.format !== 'distribution-desk.workspace' || archive?.version !== 1) throw new Error('Choose a Distribution Desk workspace backup (version 1).');
      await cleanUp();
      const start = await transferRequest<{ job: string; total: number }>('begin_import', { bytes: bytes.length }); job.current = start.job; signal.throwIfAborted();
      for (let index = 0; index < start.total; index++) {
        setStatus(`Uploading backup · ${index + 1} of ${start.total}`);
        await transferRequest('upload', { job: start.job, index, chunk: bytesToBase64(bytes.subarray(index * TRANSFER_CHUNK_BYTES, (index + 1) * TRANSFER_CHUNK_BYTES)) }, signal);
        setProgress(Math.round((index + 1) / start.total * 90));
      }
      setStatus('Validating accounts, metrics and collection links…');
      const result = await transferRequest<{ summary: TransferSummary }>('preview', { job: start.job }, signal);
      setSummary(result.summary); setProgress(100);
    } catch (error) { setError(signal.aborted ? 'Upload cancelled. Your workspace has not changed.' : error instanceof Error ? error.message : 'The backup could not be checked.'); await cleanUp(); }
    finally { setBusy(false); setStatus(''); }
  }
  async function apply() {
    if (!job.current || !summary) return;
    setBusy(true); setError(''); setStatus('Restoring your workspace…');
    try {
      const result = await transferRequest<TransferResult>('apply', { job: job.current, overwrite, restoreSettings: settings });
      let warning = '';
      try { restoreWorkspacePreferences(localStorage, ownerId, result, overwrite); }
      catch { warning = ' Your data was imported, but this browser could not save view preferences.'; }
      const message = `Workspace imported: ${summary.collections} collections and ${summary.pages} pages.${warning}`;
      setSummary(null); setFile(null); setSuccess(message);
      // An import has committed. A subsequent UI reload error must never be
      // presented as a failed import or cause a second write.
      await cleanUp();
      try { await onImported(message); } catch { setSuccess(`${message} Reload the dashboard to see the restored data.`); }
    } catch (error) { setError(error instanceof Error ? error.message : 'The workspace could not be imported.'); }
    finally { setBusy(false); setStatus(''); }
  }

  return <WorkspaceDialog title="Your workspace, anywhere" wide busy={busy} onClose={() => void close()}>
    <p className="dialog-subtitle">Back up the whole workspace or bring it into another account. Every collection, social page and saved post stays together.</p>
    <div className="transfer-tabs" role="tablist" aria-label="Workspace transfer" onKeyDown={event=>{if(busy || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'export':event.key==='End'?'import':tab==='export'?'import':'export';changeTab(next);document.getElementById(`transfer-${next}-tab`)?.focus();}}>
      <button role="tab" id="transfer-export-tab" aria-controls="transfer-export" aria-selected={tab === 'export'} tabIndex={tab==='export'?0:-1} disabled={busy} onClick={() => changeTab('export')}><ArrowDownToLine size={17}/>Export backup</button>
      <button role="tab" id="transfer-import-tab" aria-controls="transfer-import" aria-selected={tab === 'import'} tabIndex={tab==='import'?0:-1} disabled={busy} onClick={() => changeTab('import')}><ArrowUpFromLine size={17}/>Import backup</button>
    </div>
    {tab === 'export' ? <div role="tabpanel" id="transfer-export" aria-labelledby="transfer-export-tab">
      <div className="backup-preview"><span className="backup-icon"><FileJson size={28}/></span><div><strong>A complete workspace backup</strong><p>{collections} collections · {pages} social pages · all saved post data</p><span>JSON format · reusable in any Distribution Desk account</span></div></div>
      <div className="transfer-includes"><h3>Everything you have organised</h3>{['Collections and all their page memberships', 'Profile details, posts, metrics, coverage and refresh timestamps', 'Page pay, editors, start dates, active status and notes', 'Saved follower and post history, plus alerts', 'Manual metric entries, visible columns and saved selections', 'Workspace provider choice and refresh-limit settings'].map(text => <p key={text}><Check size={16}/>{text}</p>)}</div>
      <div className="transfer-note"><ShieldCheck size={18}/><p>API keys, passwords and login sessions stay with the original account. Request usage is not reset. Connect API keys in the destination account when you need to refresh.</p></div>
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => void close()}>Close</button><button className="button primary" disabled={busy} onClick={exportBackup}>{busy ? <Loader2 size={16} className="spin"/> : <ArrowDownToLine size={16}/>}Download workspace</button></div>
    </div> : <div role="tabpanel" id="transfer-import" aria-labelledby="transfer-import-tab">
      {!summary ? <><div className={`backup-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void chooseFile(event.dataTransfer.files[0]); }}>
        <input ref={input} type="file" accept=".json,application/json" disabled={busy} onChange={event => { void chooseFile(event.target.files?.[0] || null); event.target.value = ''; }} className="sr-only" id="workspace-backup-file"/>
        {file ? <FileJson size={32}/> : <Upload size={32}/>}<strong>{file ? file.name : 'Drop your workspace backup here'}</strong><p>{file ? `${size(file.size)} · ready to preview` : 'A .json backup, up to 100 MB. You can review it before importing.'}</p><button className="button" disabled={busy} onClick={() => input.current?.click()}>{file ? 'Choose another file' : 'Choose backup file'}</button>
      </div><div className="transfer-note"><CircleHelp size={18}/><p>Moving to another email? Sign in to that account first, then import the backup here. Your source workspace stays available.</p></div></> : <>
        <div className="transfer-ready"><Check size={18}/><div><strong>Backup checked. Ready to import.</strong><p>{file?.name}{summary.exportedAt && Number.isFinite(Date.parse(summary.exportedAt)) ? ` · exported ${new Date(summary.exportedAt).toLocaleDateString()}` : ''}</p></div></div>
        <div className="transfer-counts">{[[summary.collections, 'Collections'], [summary.pages, 'Social pages'], [Math.max(summary.posts,summary.historyPosts??0), 'Saved posts']].map(([count, label]) => <div key={label}><strong>{Number(count).toLocaleString()}</strong><span>{label}</span></div>)}</div>
        {summary.accountSnapshots!==undefined&&<div className="import-impact"><p><span>Follower history samples</span><strong>{summary.accountSnapshots.toLocaleString()}</strong></p><p><span>Post history samples</span><strong>{(summary.postSnapshots??0).toLocaleString()}</strong></p><p><span>Saved alerts</span><strong>{summary.alerts??0}</strong></p></div>}
        {!!summary.collectionNames.length && <div className="transfer-collections"><FolderOpen size={16}/><p>{summary.collectionNames.join(', ')}{summary.collections > 6 ? ` + ${summary.collections - 6} more` : ''}</p></div>}
        <div className="import-impact"><p><span>New collections</span><strong>+{summary.collectionsToAdd}</strong></p><p><span>New social pages</span><strong>+{summary.pagesToAdd}</strong></p><p><span>Already in this workspace</span><strong>{summary.existingCollections} collections · {summary.existingPages} pages</strong></p></div>
        <fieldset className="import-options"><legend>When matching data already exists</legend><label><input type="radio" name="import-mode" checked={!overwrite} onChange={() => setOverwrite(false)} disabled={busy}/><span><strong>Keep my existing values</strong><small>Add missing collections, pages and history. Keep existing page details, matching snapshots and manual entries.</small></span></label><label><input type="radio" name="import-mode" checked={overwrite} onChange={() => setOverwrite(true)} disabled={busy}/><span><strong>Use the backup's values</strong><small>Update matching page details, snapshots, alerts and manual entries with this backup. Other pages stay as they are.</small></span></label></fieldset>
        <label className="checkbox-label import-settings"><input type="checkbox" checked={settings} disabled={busy} onChange={event => setSettings(event.target.checked)}/><span>Also restore provider choice and refresh limits<small>API keys are not imported. Changing providers clears the old provider key.</small></span></label>
      </>}
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => summary ? (setSummary(null), void cleanUp()) : void close()}>{summary ? 'Back' : 'Cancel'}</button><button className="button primary" disabled={busy || !file} onClick={summary ? apply : preview}>{busy ? <Loader2 size={16} className="spin"/> : summary ? <ArrowUpFromLine size={16}/> : <ArrowRight size={16}/>} {summary ? 'Import workspace' : 'Preview import'}</button></div>
    </div>}
    {busy && <div className="transfer-progress" role="status" aria-live="polite"><div><Loader2 className="spin" size={16}/><span>{status}</span>{!status.startsWith('Restoring') && <button className="text-button" onClick={()=>abort.current?.abort()}>Cancel transfer</button>}</div>{!status.startsWith('Restoring') && <progress max={100} value={progress} aria-label="Transfer progress"/>}</div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {success && <div className="transfer-success" role="status"><Check size={19}/><span>{success}</span><button className="icon-button" onClick={() => setSuccess('')} aria-label="Dismiss transfer message"><X size={15}/></button></div>}
  </WorkspaceDialog>;
}
