import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const help = `Create fictional Distribution Desk analytics data without connecting to a database.

Usage:
  node scripts/seed-demo.mjs [--output ./demo-data.json] [--now 2026-10-25T12:00:00Z]

Without --output, JSON is written to stdout. An output file must not already exist.
The result is an AnalyticsDataset fixture for local development, not an importable
workspace backup. The public /demo route uses the same generator automatically.
`;

try {
  let output = null;
  let now = new Date();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
  } else {
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      if (option !== '--output' && option !== '--now') throw new Error(`Unknown option: ${option}. Use --help for usage.`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${option}.`);
      if (option === '--output') output = resolve(value);
      else {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('--now must be an ISO timestamp with an explicit timezone.');
        now = new Date(value);
        if (!Number.isFinite(now.getTime())) throw new Error('--now must be a valid timestamp.');
      }
    }

    // Compile the two local modules in memory. No generated source files,
    // environment credentials, provider requests, or database writes are needed.
    const asModule = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText).toString('base64');
    const metrics = asModule(await readFile(new URL('../lib/analytics/metrics.ts', import.meta.url), 'utf8'));
    const demoSource = await readFile(new URL('../lib/analytics/demo.ts', import.meta.url), 'utf8');
    const source = demoSource.replace(/from ['"]\.\/metrics['"]/, 'from ' + JSON.stringify(metrics));
    if (source === demoSource) throw new Error('The demo module dependency changed. Update this script before generating a fixture.');
    const { createDemoDataset } = await import(asModule(source));
    const dataset = createDemoDataset(now);
    const json = JSON.stringify(dataset, null, 2) + '\n';
    if (output) {
      await writeFile(output, json, { encoding: 'utf8', flag: 'wx' });
      process.stderr.write(`Created ${output} with ${dataset.pages.length} fictional pages. No workspace was changed.\n`);
    } else process.stdout.write(json);
  }
} catch (error) {
  const message = error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
    ? 'The output file already exists. Choose a new filename; existing files are never overwritten.'
    : error instanceof Error ? error.message : 'The demo data could not be generated.';
  process.stderr.write(`Demo seed: ${message}\n`);
  process.exitCode = 1;
}
