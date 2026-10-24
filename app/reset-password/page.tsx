import {redirect} from 'next/navigation';
import {Layers3} from 'lucide-react';
import {getCurrentUser} from '@/lib/auth';
import ResetPasswordForm from '@/components/auth/reset-password-form';
import '../home.css';
import '../auth.css';
export const dynamic='force-dynamic';
export default async function ResetPasswordPage(){
  if(!(await getCurrentUser()))redirect('/login?mode=reset&error=recovery');
  return <main className="login-shell"><a className="home-brand" href="/" aria-label="Distribution Desk home"><span className="home-brand-mark"><Layers3 size={23}/></span><span>Distribution Desk.</span></a><div className="login-card-wrap"><ResetPasswordForm/></div><p className="login-footer">Distribution Desk · Your pages, together.</p></main>;
}
