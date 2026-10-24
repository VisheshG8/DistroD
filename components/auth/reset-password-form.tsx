"use client";
import {useState, type FormEvent} from 'react';
import {Check, Loader2, LockKeyhole} from 'lucide-react';
import {createClient} from '@/lib/supabase/client';

export default function ResetPasswordForm(){
  const [password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  async function submit(event:FormEvent){
    event.preventDefault();if(busy||done)return;setError('');if(password.length<8){setError('Use at least 8 characters for your password.');return;}if(password!==confirm){setError('The passwords do not match.');return;}setBusy(true);
    try{const supabase=createClient();const {error:updateError}=await supabase.auth.updateUser({password});if(updateError){setError(updateError.code==='weak_password'?'Choose a stronger password with at least 8 characters.':updateError.code==='same_password'?'Choose a different password from the one you used before.':'Could not update your password. Request a new reset link and try again.');return;}setPassword('');setConfirm('');setDone(true);await supabase.auth.signOut({scope:'local'});window.location.assign('/login?message=password-updated');}catch{setError('Could not update your password. Please try again.');}finally{setBusy(false);}
  }
  return <div className="login-card auth-card"><div className="login-symbol"><LockKeyhole size={25}/></div><h1>Choose a new password.</h1><p className="login-intro">Use at least 8 characters. Your new password will be used the next time you sign in.</p><form className="auth-form" onSubmit={submit}><label>New password<input type="password" required autoComplete="new-password" minLength={8} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy||done}/></label><label>Confirm new password<input type="password" required autoComplete="new-password" minLength={8} maxLength={256} value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy||done}/></label>{error&&<div className="auth-error" role="alert">{error}</div>}{done&&<div className="auth-success" role="status"><Check size={16}/>Password updated. Returning to sign in.</div>}<button type="submit" className="home-button home-button-primary" disabled={busy||done}>{busy?<Loader2 size={17} className="spin"/>:null}Update password</button></form><a className="login-back" href="/dashboard">Back to workspace</a></div>;
}
