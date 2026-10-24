// Fail before Next.js can inline a privileged secret into a browser bundle.
const key=(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||'').trim();
let forbidden=key.startsWith('sb_secret_');
if(key.split('.').length===3){try{forbidden ||= JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='service_role';}catch{}}
if(forbidden){console.error('Refusing to build: NEXT_PUBLIC_SUPABASE_* contains a privileged secret. Use the Supabase publishable/anon key.');process.exitCode=1;}
