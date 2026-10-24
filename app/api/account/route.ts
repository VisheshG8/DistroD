import { currentAccount, fail, json } from '@/lib/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';

/** Signing in automatically registers a regular user; roles cannot be submitted by the client. */
export async function GET(){
  try{return json({account:await currentAccount()});}
  catch(error){return fail(error);}
}
