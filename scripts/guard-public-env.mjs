// Fail before Next.js can inline a privileged secret into a browser bundle.
import nextEnv from '@next/env';
import { validatePublicSecrets } from './verify-env.mjs';
const event = process.env.npm_lifecycle_event;
const development = ['predev', 'dev'].includes(event) || (!['prebuild', 'build'].includes(event) && process.env.NODE_ENV === 'development');
let loadFailed = false;
try {
  // Use Next's file order and expansion rules, including existing process overrides.
  // Its default logger may include file contents on errors, so keep diagnostics generic.
  nextEnv.loadEnvConfig(process.cwd(), development, { info() {}, error() { loadFailed = true; } });
} catch { loadFailed = true; }
if (loadFailed) {
  console.error('Refusing to build: environment files could not be safely loaded. Check their format and permissions.');
  process.exitCode = 1;
}
const errors = validatePublicSecrets(process.env);
if (errors.length) {
  console.error('Refusing to build: server credentials would be exposed to the browser.');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
