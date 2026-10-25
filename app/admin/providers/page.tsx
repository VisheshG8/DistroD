import {redirect} from 'next/navigation';
import {ApiError,requireAdmin} from '@/lib/server';
import ProviderConsole from '@/components/provider-console';
export const dynamic='force-dynamic';
export default async function Page(){try{await requireAdmin();}catch(e){if(e instanceof ApiError&&e.status===401)redirect('/login');if(e instanceof ApiError&&e.status===403)redirect('/dashboard');throw e;}return <ProviderConsole/>;}
