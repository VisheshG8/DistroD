"use client";
import {useEffect,useState} from 'react';
import {ArrowLeft,Check,ExternalLink,KeyRound,Loader2,RefreshCw,ShieldCheck} from 'lucide-react';
import {PRODUCT_NAME} from '@/lib/product';
import './provider-console.css';

type Settings={provider_order:Record<string,string[]>;monthly_request_cap:number;monthly_budget_usd:number;request_costs:Record<string,number>;refresh_enabled:boolean;refresh_interval_hours:number};
type Data={settings:Settings;keys:Record<string,boolean>;schedulerConfigured:boolean;usage:{totals:{requests:number;estimatedCostUsd:number;month:string};providers:{provider:string;funding:string;requests:number;succeeded:number;failed:number;pending:number;estimated_cost_usd:number;latency_ms:number|null}[]};requests:{id:string;provider:string;platform:string;endpoint:string;funding:string;success:boolean|null;latency_ms:number|null;estimated_cost_usd:number;created_at:string}[];failed:{id:string;owner:string;name:string;handle:string;platform:string;last_synced_at:string|null}[]};
const names:Record<string,string>={'instagram-looter':'Instagram Looter (RapidAPI)','youtube-official':'YouTube official',hikerapi:'HikerAPI',lamatok:'LamaTok',tikhub:'TikHub',scrapecreators:'ScrapeCreators'};
const allowed:Record<string,string[]>={instagram:['instagram-looter','hikerapi','tikhub','scrapecreators'],youtube:['youtube-official','tikhub','scrapecreators'],tiktok:['lamatok','tikhub','scrapecreators']};
const count=(v:number)=>new Intl.NumberFormat('en-IN').format(v);
const usd=(v:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(v);

export default function ProviderConsole(){
  const [data,setData]=useState<Data|null>(null),[settings,setSettings]=useState<Settings|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0);
  const [rapidApiKey,setRapidApiKey]=useState(''),[confirmRemoveKey,setConfirmRemoveKey]=useState(false);
  const working=loading||busy!==null;

  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    fetch('/api/admin/operations',{cache:'no-store',signal:controller.signal}).then(async r=>{
      const value=await r.json();if(!r.ok)throw new Error(value.error||'Could not load provider settings.');
      if(!controller.signal.aborted){setData(value);setSettings(value.settings);}
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[revision]);

  async function save(){
    if(!settings||working)return;
    setBusy('settings');setError('');setNotice('');
    try{
      const r=await fetch('/api/admin/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'saveProviderSettings',providerOrder:settings.provider_order,monthlyRequestCap:Number(settings.monthly_request_cap),monthlyBudgetUsd:Number(settings.monthly_budget_usd),requestCosts:settings.request_costs,refreshEnabled:settings.refresh_enabled,refreshIntervalHours:Number(settings.refresh_interval_hours)})});
      const value=await r.json();if(!r.ok)throw new Error(value.error||'Could not save these settings.');
      setNotice('Provider settings saved.');setRevision(v=>v+1);
    }catch(e){setError(e instanceof Error?e.message:'Please retry.');}finally{setBusy(null);}
  }

  async function saveKey(clear=false){
    if(working)return;
    const key=rapidApiKey.trim();
    if(!clear&&!key){setNotice(data?.keys['instagram-looter']?'Your saved RapidAPI key has been kept.':'Enter your RapidAPI key first.');return;}
    setBusy(clear?'removeKey':'key');setError('');setNotice('');
    try{
      const r=await fetch('/api/admin/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'saveRapidApiKey',rapidApiKey:clear?'':key,clearRapidApiKey:clear})});
      const value=await r.json();if(!r.ok)throw new Error(value.error||'Could not save your RapidAPI key.');
      const configured=typeof value.hasRapidApiKey==='boolean'?value.hasRapidApiKey:!clear;
      setData(current=>current?{...current,keys:{...current.keys,'instagram-looter':configured}}:current);
      setRapidApiKey('');setConfirmRemoveKey(false);
      setNotice(clear?'Saved RapidAPI key removed.':'RapidAPI key saved securely. Select Instagram Looter in the Instagram provider order, then save settings.');
    }catch(e){setError(e instanceof Error?e.message:'Please retry.');}finally{setBusy(null);}
  }

  function choose(platform:string,index:number,id:string){
    if(!settings)return;
    const order=[...(settings.provider_order[platform]||[])],previous=order[index],existing=order.indexOf(id);
    order[index]=id;
    // Move a selected provider by swapping instead of silently removing the previous choice.
    if(id&&existing>=0&&existing!==index)order[existing]=previous||'';
    setSettings({...settings,provider_order:{...settings.provider_order,[platform]:order.filter(Boolean)}});
  }

  async function retry(page:{id:string;owner:string}){
    if(working)return;
    setBusy('refresh');setError('');setNotice('');
    try{
      const r=await fetch('/api/admin/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refreshPage',pageId:page.id,ownerId:page.owner})});
      const value=await r.json();if(!r.ok)throw new Error(value.error||'Refresh failed.');
      setNotice('Page refreshed.');setRevision(v=>v+1);
    }catch(e){setError(e instanceof Error?e.message:'Please retry.');}finally{setBusy(null);}
  }

  return <main className="provider-console">
    <header><a href="/admin"><ArrowLeft size={16}/>Workspace directory</a><span><ShieldCheck size={16}/>Administration</span></header>
    <div className="pc-heading"><div><p>{PRODUCT_NAME}</p><h1>Data sources & refreshes</h1><p>Choose sources, control estimated spend, and check delivery.</p></div><button className="pc-button" disabled={working} onClick={()=>setRevision(v=>v+1)} aria-label="Reload provider settings"><RefreshCw size={16}/>Reload</button></div>
    {error&&<div className="pc-alert" role="alert">{error}</div>}
    {notice&&<div className="pc-success" role="status"><Check size={16}/>{notice}</div>}
    {loading&&!data?<p role="status"><Loader2 className="spin" size={18}/>Loading provider settings.</p>:data&&settings?<>
      <div className="pc-kpis">
        <article><span>Platform requests this month</span><strong>{count(data.usage.totals.requests)}</strong><small>of {count(Number(settings.monthly_request_cap))} requests</small></article>
        <article><span>Estimated platform spend</span><strong>{usd(Number(data.usage.totals.estimatedCostUsd))}</strong><small>{usd(Number(settings.monthly_budget_usd))} configured ceiling · {data.usage.totals.month} UTC</small></article>
        <article><span>Scheduled refreshes</span><strong>{settings.refresh_enabled?'Enabled':'Paused'}</strong><small>{data.schedulerConfigured?'Scheduler secret configured':'Set CRON_SECRET before scheduling'}</small></article>
      </div>

      <section className="pc-panel pc-credentials" aria-labelledby="rapidapi-heading">
        <div className="pc-credential-heading"><h2 id="rapidapi-heading"><KeyRound size={21}/>Instagram Looter</h2><span className={'pc-key-status '+(data.keys['instagram-looter']?'ready':'')}>{data.keys['instagram-looter']?'Key saved securely':'Key not configured'}</span></div>
        <p>Subscribe to Instagram Looter on RapidAPI, save your key here, then select it in the Instagram provider order below. The saved key is shared by manual and scheduled refreshes.</p>
        <div className="pc-provider-links"><a href="https://rapidapi.com/irrors-apis/api/instagram-looter2/" target="_blank" rel="noopener noreferrer">Open Instagram Looter<ExternalLink size={14}/></a><a href="https://rapidapi.com/irrors-apis/api/instagram-looter2/pricing" target="_blank" rel="noopener noreferrer">View plans<ExternalLink size={14}/></a></div>
        <form aria-label="RapidAPI key settings" onSubmit={e=>{e.preventDefault();void saveKey();}}>
          <label className="pc-key-label" htmlFor="rapidapi-key">{data.keys['instagram-looter']?'Replace RapidAPI key':'RapidAPI key'}</label>
          <div className="pc-key-entry"><input id="rapidapi-key" name="rapidapiKey" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={2000} value={rapidApiKey} disabled={working} onChange={e=>setRapidApiKey(e.target.value)} placeholder={data.keys['instagram-looter']?'Leave blank to keep the saved key':'Paste your RapidAPI key'} aria-describedby="rapidapi-key-help"/><button className="pc-button primary" type="submit" disabled={working||!rapidApiKey.trim()}>{busy==='key'&&<Loader2 size={16} className="spin"/>}{data.keys['instagram-looter']?'Replace key':'Save key'}</button></div>
          <p id="rapidapi-key-help" className="pc-help">Stored encrypted. The saved value is never displayed. A blank field keeps the existing key.</p>
          {data.keys['instagram-looter']&&(confirmRemoveKey?<div className="pc-key-remove" role="group" aria-label="Confirm RapidAPI key removal"><p>Remove the saved key? Instagram Looter refreshes will need a new key.</p><div><button type="button" className="pc-button danger" disabled={working} onClick={()=>void saveKey(true)}>{busy==='removeKey'&&<Loader2 size={16} className="spin"/>}Remove key</button><button type="button" className="pc-button" disabled={working} onClick={()=>setConfirmRemoveKey(false)}>Cancel</button></div></div>:<button type="button" className="pc-text-button" disabled={working} onClick={()=>setConfirmRemoveKey(true)}>Remove saved key</button>)}
        </form>
        <p className="pc-billing-note">RapidAPI subscriptions, overages and bandwidth fees are billed separately. The estimated budget below does not cap your RapidAPI bill.</p>
      </section>

      <form aria-label="Provider settings" onSubmit={e=>{e.preventDefault();void save();}}>
        <section className="pc-panel"><h2>Provider order</h2><p>The first configured source is used first. If it fails, the next source is tried. Instagram Looter uses the key saved above; other shared provider keys use server settings.</p>
          {Object.entries(allowed).map(([platform,ids])=><fieldset className="pc-order" key={platform}><legend>{platform==='youtube'?'YouTube':platform==='tiktok'?'TikTok':'Instagram'}</legend><div className="pc-order-fields">{ids.map((_,i)=><label key={i}>{i===0?'Primary':'Fallback '+i}<select disabled={working} aria-label={(platform==='youtube'?'YouTube':platform==='tiktok'?'TikTok':'Instagram')+' '+(i===0?'primary provider':'fallback '+i)} value={settings.provider_order[platform]?.[i]||''} onChange={e=>choose(platform,i,e.target.value)}><option value="">None</option>{ids.map(id=><option key={id} value={id}>{names[id]}{data.keys[id]?'':' · key missing'}</option>)}</select></label>)}</div></fieldset>)}
          <div className="pc-keys">{Object.entries(names).map(([id,name])=><span key={id} className={data.keys[id]?'ready':''}>{name}: {data.keys[id]?'key configured':'key needed'}</span>)}</div>
        </section>
        <section className="pc-panel"><h2>Limits and schedule</h2>
          <div className="pc-fields"><label>Monthly request cap<input type="number" min="1" max="1000000" required value={settings.monthly_request_cap} disabled={working} onChange={e=>setSettings({...settings,monthly_request_cap:Number(e.target.value)})}/></label><label>Estimated monthly budget (USD)<input type="number" min="0" max="25" step="0.01" required value={settings.monthly_budget_usd} disabled={working} onChange={e=>setSettings({...settings,monthly_budget_usd:Number(e.target.value)})}/></label><label>Normal refresh interval (hours)<input type="number" min="1" max="168" required value={settings.refresh_interval_hours} disabled={working} onChange={e=>setSettings({...settings,refresh_interval_hours:Number(e.target.value)})}/></label></div>
          <label className="pc-checkbox"><input type="checkbox" checked={settings.refresh_enabled} disabled={working} onChange={e=>setSettings({...settings,refresh_enabled:e.target.checked})}/>Enable scheduled refreshes</label>
          <p>The default schedule runs once daily. Each run attempts up to 50 shared accounts within roughly 220 seconds, so larger queues may take several days. Manual refresh remains available. Refreshes slow near the limits and requests stop at the cap.</p>
          <details><summary>Estimated cost per request</summary><p>Set estimates from your actual provider plan. Profile lookups, pagination, retries and fallback calls all use requests. Subscription fees and other provider charges are separate from this estimate.</p><div className="pc-fields">{Object.entries(names).map(([id,name])=><label key={id}>{name} (USD)<input type="number" min={id==='youtube-official'?0:0.000001} max="25" step="0.000001" required disabled={working} value={settings.request_costs[id]??(id==='instagram-looter'?0.000660:0)} onChange={e=>setSettings({...settings,request_costs:{...settings.request_costs,[id]:Number(e.target.value)}})}/></label>)}</div></details>
          <button className="pc-button primary" disabled={working} type="submit">{busy==='settings'&&<Loader2 size={16} className="spin"/>}Save settings</button>
        </section>
      </form>
      <section className="pc-panel"><h2>Provider reliability this month</h2><div className="pc-scroll"><table><thead><tr><th>Provider</th><th>Paid by</th><th>Requests</th><th>Success rate</th><th>Failed</th><th>Average latency</th><th>Estimated cost</th></tr></thead><tbody>{data.usage.providers.map(r=><tr key={r.provider+r.funding}><td>{names[r.provider]||r.provider}</td><td>{r.funding==='platform'?'Platform':'User workspace'}</td><td>{count(r.requests)}</td><td>{r.succeeded+r.failed?Math.round(100*r.succeeded/(r.succeeded+r.failed))+'%':'-'}</td><td>{count(r.failed)}</td><td>{r.latency_ms==null?'-':count(r.latency_ms)+' ms'}</td><td>{usd(Number(r.estimated_cost_usd))}</td></tr>)}</tbody></table></div>{!data.usage.providers.length&&<p>No requests recorded this month.</p>}</section>
      <section className="pc-panel"><h2>Pages needing a retry</h2><p>Up to 100 failed page records across all accounts.</p>{data.failed.length?<div className="pc-scroll"><table><thead><tr><th>Page</th><th>Platform</th><th>Account ID</th><th>Action</th></tr></thead><tbody>{data.failed.map(p=><tr key={p.id}><td>{p.name||p.handle}<small>@{p.handle}</small></td><td>{p.platform}</td><td><code>{p.owner}</code></td><td><button className="pc-button" disabled={working} onClick={()=>retry(p)}>Retry refresh</button></td></tr>)}</tbody></table></div>:<p>No failed refreshes.</p>}</section>
      <section className="pc-panel"><h2>Latest requests</h2><p>Latest 100 attempts. Raw responses and credentials are never shown here.</p><div className="pc-scroll"><table><thead><tr><th>Time (IST)</th><th>Provider</th><th>Endpoint</th><th>Result</th><th>Estimated cost</th></tr></thead><tbody>{data.requests.map(r=><tr key={r.id}><td>{new Date(r.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</td><td>{names[r.provider]||r.provider}</td><td><code>{r.endpoint}</code></td><td>{r.success===null?'Pending':r.success?'Success':'Failed'}</td><td>{usd(Number(r.estimated_cost_usd))}</td></tr>)}</tbody></table></div>{!data.requests.length&&<p>No requests yet.</p>}</section>
    </>:null}
  </main>;
}
