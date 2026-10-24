// Fail before Next.js can inline a privileged secret into a browser bundle.
import { validatePublicSecrets } from './verify-env.mjs';
const errors = validatePublicSecrets(process.env);
if (errors.length) {
  console.error('Refusing to build: privileged Supabase credentials would be exposed to the browser.');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
