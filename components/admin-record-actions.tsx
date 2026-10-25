"use client";
import {useState} from 'react';
import {Plus,Settings2,Loader2,Trash2} from 'lucide-react';
import {WorkspaceDialog} from './workspace-dialog';

type Props={ownerId:string;label:string;pageId?:string;pageName?:string;onDone?:()=>void};
const empty={input:'',platform:'instagram',monthlyPay:'',editor:'',startDate:'',active:true,notes:''};
export default function AdminRecordActions({ownerId,label,pageId,pageName,onDone}:Props){
  const [open,setOpen]=useState(false),[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[remove,setRemove]=useState(false),[done,setDone]=useState(false),[loaded,setLoaded]=useState(!pageId);
  function close(){if(!busy){setOpen(false);setRemove(false);}}
  async function show(){
    setOpen(true);setError('');setNotice('');setDone(false);setRemove(false);setForm(empty);setLoaded(!pageId);
    if(!pageId)return;setBusy(true);
    try{const response=await fetch('/api/admin/operations?'+new URLSearchParams({section:'page',ownerId,pageId}),{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load page details.');const p=data.page;setForm({...empty,monthlyPay:p.monthly_pay==null?'':String(p.monthly_pay),editor:p.editor||'',startDate:p.start_date||'',active:p.active,notes:p.notes||''});setLoaded(true);}catch(e){setError(e instanceof Error?e.message:'Could not load this page.');}finally{setBusy(false);}
  }
  async function submit(action:string){
    if(!loaded)return;
    setBusy(true);setError('');setNotice('');
    try{const response=await fetch('/api/admin/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,monthlyPay:form.monthlyPay===''?null:Number(form.monthlyPay),action,ownerId,pageId})});const data=await response.json();if(!response.ok)throw new Error(data.error||'The change could not be saved.');setDone(true);setNotice(data.warning?'Saved. '+data.warning:action==='removePage'?'Page removed from this account.':action==='assignPage'?'Page added to this account.':'Page details saved.');onDone?.();}catch(e){setError(e instanceof Error?e.message:'Please retry.');}finally{setBusy(false);}
  }
  return <><button type="button" className="adm-row-link" aria-label={pageId?'Manage '+(pageName||'page'):'Add page for '+label} onClick={show}>{pageId?<Settings2 size={14}/>:<Plus size={14}/>} {pageId?'Manage':'Add page'}</button>{open&&<WorkspaceDialog title={pageId?'Manage '+(pageName||'page'):'Add a page'} onClose={close} busy={busy}>
    <p className="dialog-subtitle">Account: <strong>{label}</strong>. Changes apply to this account's records.</p>
    {error&&<div role="alert" className="form-error">{error}</div>}{notice&&<div role="status" className="inline-info">{notice}</div>}
    {done?<div className="dialog-actions"><button className="button primary" onClick={close}>Done</button></div>:!loaded?<div className="dialog-actions"><button className="button" onClick={close} disabled={busy}>Close</button><button className="button" onClick={show} disabled={busy}>{busy?'Loading details…':'Retry loading'}</button></div>:remove?<><p>Remove this page, its saved history, and its collection memberships from {label}? Other accounts are unaffected.</p><div className="dialog-actions"><button className="button" disabled={busy} onClick={()=>setRemove(false)}>Keep page</button><button className="button" disabled={busy} onClick={()=>submit('removePage')}><Trash2 size={15}/>Remove page</button></div></>:<form onSubmit={e=>{e.preventDefault();void submit(pageId?'savePage':'assignPage');}}>
      {!pageId&&<><label className="field-label">Profile URL or handle<input required value={form.input} maxLength={300} onChange={e=>setForm({...form,input:e.target.value})} placeholder="youtube.com/@creator" disabled={busy}/></label><label className="field-label">Platform for a bare handle<select value={form.platform} onChange={e=>setForm({...form,platform:e.target.value})} disabled={busy}><option value="instagram">Instagram</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option></select></label></>}
      <div className="settings-row"><label className="field-label">Monthly pay (INR)<input type="number" min="0" step="0.01" value={form.monthlyPay} onChange={e=>setForm({...form,monthlyPay:e.target.value})} placeholder="Not set" disabled={busy}/></label><label className="field-label">Start date<input type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})} disabled={busy}/></label></div>
      <label className="field-label">Editor or responsible person<input value={form.editor} maxLength={150} onChange={e=>setForm({...form,editor:e.target.value})} disabled={busy}/></label>
      <label className="field-label">Notes<textarea value={form.notes} maxLength={2000} onChange={e=>setForm({...form,notes:e.target.value})} disabled={busy}/></label>
      <label style={{display:'flex',gap:10,alignItems:'center',margin:'14px 0',fontSize:14}}><input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})} disabled={busy}/>Active page</label>
      <div className="dialog-actions">{pageId&&<button className="button" type="button" disabled={busy} onClick={()=>setRemove(true)}><Trash2 size={15}/>Remove</button>}<button className="button" type="button" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy} type="submit">{busy&&<Loader2 className="spin" size={15}/>} {pageId?'Save details':'Add and fetch page'}</button></div>
    </form>}
  </WorkspaceDialog>}</>;
}
