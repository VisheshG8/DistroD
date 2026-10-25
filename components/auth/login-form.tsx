"use client";
import {useState, type FormEvent} from 'react';
import {ArrowLeft, ArrowRight, Check, Loader2, LockKeyhole, Mail} from 'lucide-react';
import {createClient} from '@/lib/supabase/client';
import {authCallbackUrl} from '@/lib/auth-urls';

type Mode='signin'|'signup'|'reset'|'link';
type Props={next:string;appOrigin:string|null;configurationError:string;googleEnabled:boolean;initialMode:Mode;initialError?:string;initialMessage?:string};
const linkErrors:Record<string,string>={callback:'We could not complete that sign-in. The link may have expired, or it was opened in a different browser. Please try again.',confirmation:'That confirmation link is invalid or has expired. Sign in if you already confirmed your account, or request a new email.',recovery:'Open the link in your password reset email to choose a new password. You can request a fresh link below.'};
function authError(error:{message?:string;code?:string},mode:Mode){
  if(error.code==='invalid_credentials')return 'The email or password is incorrect.';
  if(error.code==='email_not_confirmed')return 'Please confirm your email before signing in. Check your inbox and spam folder.';
  if(['over_request_rate_limit','over_email_send_rate_limit','too_many_requests'].includes(error.code||''))return 'Too many attempts. Please wait a little before trying again.';
  if(error.code==='weak_password')return 'Please choose a stronger password with at least 8 characters.';
  if(error.code==='signup_disabled')return mode==='link'?'Use the email address of an existing account, or create an account first.':'New account creation is temporarily unavailable.';
  if(mode==='link'&&['otp_disabled','email_provider_disabled'].includes(error.code||''))return 'Email sign-in links are unavailable right now. You can sign in with your password.';
  if(['user_already_exists','email_exists'].includes(error.code||''))return 'If you already have an account, sign in or reset your password.';
  if(/fetch|network/i.test(error.message||''))return 'Could not reach the sign-in service. Check your connection and try again.';
  return mode==='link'?'Could not send the sign-in link. Please try again shortly, or sign in with your password.':mode==='reset'?'Could not send the reset email. Please try again shortly.':mode==='signup'?'Could not create your account. Please check your details and try again.':'Could not sign in. Please try again shortly.';
}
export default function LoginForm({next,appOrigin,configurationError,googleEnabled,initialMode,initialError,initialMessage}:Props){
  const [mode,setMode]=useState<Mode>(initialMode),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[name,setName]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(initialError?linkErrors[initialError]||'Please try signing in again.':''),[notice,setNotice]=useState(initialMessage==='password-updated'?'Your password was updated. Sign in with your new password.':'');
  const available=!configurationError&&!!appOrigin;
  function changeMode(value:Mode){setMode(value);setError('');setNotice('');setPassword('');setConfirm('');}
  async function googleSignIn(){
    if(!available||!appOrigin||busy)return;setBusy(true);setError('');setNotice('');
    try{const supabase=createClient();const {data,error:oauthError}=await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:authCallbackUrl(appOrigin,next),skipBrowserRedirect:true,queryParams:{prompt:'select_account'}}});if(oauthError||!data.url){setError('Google sign-in is not available right now. You can use email and password below.');setBusy(false);return;}window.location.assign(data.url);}catch{setError('Could not start Google sign-in. Please try again or use email below.');setBusy(false);}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(!available||!appOrigin||busy)return;setError('');setNotice('');
    if(mode==='signup'&&password!==confirm){setError('The passwords do not match.');return;}
    if(mode==='signup'&&password.length<8){setError('Use at least 8 characters for your password.');return;}
    setBusy(true);
    try{
      const supabase=createClient(),cleanEmail=email.trim();
      if(mode==='link'){const {error:linkError}=await supabase.auth.signInWithOtp({email:cleanEmail,options:{shouldCreateUser:false,emailRedirectTo:authCallbackUrl(appOrigin,next)}});if(linkError){setError(authError(linkError,mode));return;}setNotice('If an account uses this email, a sign-in link is on its way. Open the link in this browser. Check your inbox and spam folder.');return;}
      if(mode==='signin'){const {error:signError}=await supabase.auth.signInWithPassword({email:cleanEmail,password});if(signError){setError(authError(signError,mode));return;}window.location.assign(next);return;}
      if(mode==='signup'){const {data,error:signError}=await supabase.auth.signUp({email:cleanEmail,password,options:{emailRedirectTo:authCallbackUrl(appOrigin,next),data:{full_name:name.trim().slice(0,150)}}});if(signError){setError(authError(signError,mode));return;}setPassword('');setConfirm('');if(data.session){window.location.assign(next);return;}setNotice('Check your email to confirm your account. If you already have an account, sign in or reset your password.');return;}
      const {error:resetError}=await supabase.auth.resetPasswordForEmail(cleanEmail,{redirectTo:authCallbackUrl(appOrigin,'/reset-password')});if(resetError){setError(authError(resetError,mode));return;}setNotice('If an account uses this email, you will receive a password reset link. Check your inbox and spam folder.');
    }catch{setError('Could not reach the sign-in service. Please try again.');}finally{setBusy(false);}
  }
  return <div className="login-card auth-card">
    <div className="login-symbol">{mode==='reset'||mode==='link'?<Mail size={25}/>:<LockKeyhole size={25}/>}</div>
    <h1>{mode==='signup'?'Create your account.':mode==='reset'?'Reset your password.':mode==='link'?'Email a sign-in link.':'Welcome to Distribution Desk.'}</h1>
    <p className="login-intro">{mode==='signup'?'Bring your pages together in a workspace of your own.':mode==='reset'?'Enter your email and we will send you a secure reset link.':mode==='link'?'Use the email address of your existing account. We will send you a link to sign in.':'Sign in to organise your pages and see their numbers together.'}</p>
    {configurationError&&<div className="auth-error" role="alert">{configurationError}</div>}
    {googleEnabled&&(mode==='signin'||mode==='signup')&&<><button type="button" className="home-button auth-google" onClick={googleSignIn} disabled={busy||!available}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.93A6 6 0 0 1 6.1 12c0-.67.12-1.32.31-1.93V7.48H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.52l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.78.5 3.82 1.5l2.87-2.87A9.57 9.57 0 0 0 12 2a10 10 0 0 0-8.93 5.48l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"/></svg>Continue with Google</button><div className="auth-divider"><span/>or use email<span/></div></>}
    <form className="auth-form" onSubmit={submit} aria-busy={busy}>
      {mode==='signup'&&<label>Your name<input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} maxLength={150} disabled={busy||!available} placeholder="Your name"/></label>}
      <label>Email address<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} maxLength={254} disabled={busy||!available} placeholder="you@example.com"/></label>
      {(mode==='signin'||mode==='signup')&&<label>Password<input type="password" required autoComplete={mode==='signup'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} minLength={mode==='signup'?8:undefined} maxLength={256} disabled={busy||!available} placeholder={mode==='signup'?'At least 8 characters':'Your password'}/></label>}
      {mode==='signup'&&<label>Confirm password<input type="password" required autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} minLength={8} maxLength={256} disabled={busy||!available} placeholder="Enter your password again"/></label>}
      {mode==='signin'&&<button type="button" className="auth-text-button auth-forgot" disabled={busy} onClick={()=>changeMode('reset')}>Forgot password?</button>}
      {error&&<div className="auth-error" role="alert">{error}</div>}{notice&&<div className="auth-success" role="status"><Check size={16}/><span>{notice}</span></div>}
      <button className="home-button home-button-primary" type="submit" disabled={busy||!available}>{busy?<Loader2 className="spin" size={17}/>:mode==='reset'||mode==='link'?<Mail size={17}/>:null}{mode==='signup'?'Create account':mode==='reset'?'Send reset link':mode==='link'?'Send sign-in link':'Sign in'}{!busy&&(mode==='signin'||mode==='signup')&&<ArrowRight size={16}/>}</button>
      {mode==='signin'&&<button type="button" className="auth-text-button" disabled={busy||!available} onClick={()=>changeMode('link')}>Email me a sign-in link</button>}
    </form>
    <div className="auth-mode-switch">{mode==='signin'?<>New here? <button type="button" className="auth-text-button" disabled={busy} onClick={()=>changeMode('signup')}>Create an account</button></>:mode==='link'?<><button type="button" className="auth-text-button" disabled={busy} onClick={()=>changeMode('signin')}>Sign in with a password</button><br/><button type="button" className="auth-text-button" disabled={busy} onClick={()=>changeMode('signup')}>Create an account</button></>:<>Already have an account? <button type="button" className="auth-text-button" disabled={busy} onClick={()=>changeMode('signin')}>Sign in</button></>}</div>
    <a className="login-back" href="/"><ArrowLeft size={14}/>Back to homepage</a>
  </div>;
}
