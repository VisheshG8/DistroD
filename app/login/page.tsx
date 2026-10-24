import {redirect} from 'next/navigation';
import {Layers3} from 'lucide-react';
import {getCurrentUser} from '@/lib/auth';
import {configuredAppOrigin, safeNextPath} from '@/lib/auth-urls';
import {AUTH_CONFIGURATION_MESSAGE, publicSupabaseConfig} from '@/lib/supabase/config';
import LoginForm from '@/components/auth/login-form';
import '../home.css';
import '../auth.css';

export const dynamic = "force-dynamic";

export default async function LoginPage({searchParams}:{searchParams:Promise<{next?:string;mode?:string;error?:string;message?:string}>}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  if (await getCurrentUser()) redirect(next);
  let origin: string | null = null, configurationError = '';
  if (!publicSupabaseConfig()) configurationError = AUTH_CONFIGURATION_MESSAGE;
  else try { origin = configuredAppOrigin(); } catch (error) { configurationError = error instanceof Error ? error.message : 'Authentication is not configured.'; }
  return <main className="login-shell">
    <a className="home-brand" href="/" aria-label="Distribution Desk home"><span className="home-brand-mark"><Layers3 size={23}/></span><span>Distribution Desk.</span></a>
    <div className="login-card-wrap"><LoginForm next={next} appOrigin={origin} configurationError={configurationError} googleEnabled={process.env.NEXT_PUBLIC_ENABLE_GOOGLE_AUTH==='true'} initialMode={params.mode==='signup'?'signup':params.mode==='reset'?'reset':'signin'} initialError={params.error} initialMessage={params.message}/></div>
    <p className="login-footer">Distribution Desk · Your pages, together.</p>
  </main>;
}
