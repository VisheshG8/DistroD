# Verification

## V2 local validation

The V2 work adds provider adapters and scheduling, owner-scoped historical analytics, page metadata and admin operations, a new analytics interface, and extended workspace backups. Validation uses synthetic fixtures, the real Supabase SDK, and PGlite running the actual SQL migrations. These checks do not touch a hosted database.

Confirmed transfer regression command:

```sh
node --test tests/analytics-transfer.test.mjs tests/workspace-transfer.test.mjs
```

Result: **23 tests passed, zero failures**. Coverage includes:

- Atomic export of metadata, cumulative posts, real account/post observations, and alerts.
- Owner/page reference remapping and exclusion of roles, keys, global provider settings, shared cache payloads, and request logs.
- Preservation of the first daily observation, old version-1 backup compatibility, keep/overwrite choices, repeated imports, and network retries.
- Alert identity through later resolution and recreation of a page removed between preview and apply.
- Strict rejection of malformed counters, dates without timezones, duplicate daily samples, invalid metadata, and foreign references.
- Injected failure proving all workspace/history changes roll back together; private transfer functions remain inaccessible to browser roles.
- Existing Unicode chunking, bounded request streams, refresh-lease checks, quota preservation, manual-value/view remapping, and route authentication regressions.

The integrated `node --test tests/*.test.mjs` run passed **202 tests, zero failures, zero skipped**. Four additional server-rendering/CSV regressions then passed in a six-test targeted run that also included two existing admin UI tests. This gives **206 unique passing tests** across those runs; the complete 206-test suite was not rerun as one command.

The Next.js production webpack build passed compilation, TypeScript validation, route generation, and build tracing. The project's default build command remains `npm run build`; the verified build used the webpack option. Core environment validation passed. The current local configuration has no shared provider keys and no `CRON_SECRET`, so shared live fetches and authenticated scheduled refresh still require those values.

Local desktop and 390-pixel mobile browser checks covered all seven analytics sections, page detail, comparisons, same-platform post rankings, page/monthly CSV downloads, and mobile layouts without horizontal overflow. Password and emailed-link forms showed no admin hints. An initial development-server render exposed an SVG title/hydration warning; that issue was fixed, with actual server-rendering regression tests passing. A fresh production-server browser check then verified the overview, interactive page detail and health breakdown, and economics chart. Browser warning/error logs were empty and the production server emitted no render warnings. Preview tabs and servers were closed after verification.

## Checks that require hosted services

No live Supabase migration, paid provider request, or Vercel deployment was performed by the local build work. There is no new live deployment URL to report. The following still require the owner's configured projects:

- Applying only missing migrations from the nine-file sequence in [DEPLOYMENT.md](./DEPLOYMENT.md).
- Supabase Data API connectivity, email confirmation/recovery delivery, and optional Google sign-in.
- Real vendor credentials, purchased price tiers, public/private/not-found responses, endpoint coverage, and invoices.
- A Vercel plan supporting the configured hourly cron, a valid `CRON_SECRET`, and real queue throughput within function limits.
- Two-account isolation and SQL-designated admin access on the deployed services, including role revocation.
- A hosted full-backup round trip between accounts, including browser preferences, after all migrations are applied.

Use the explicit smoke checklist in [DEPLOYMENT.md](./DEPLOYMENT.md). The demo is synthetic and does not prove that a provider or production database is configured.

## Expected limits, not fabricated results

Actual tracking history starts with saved observations. Imported old posts do not acquire invented earlier views or follower history. Day-seven performance needs an observation at 7–8 days of post age; health scores require enough comparable matured posts and component data. Partial coverage remains labelled.

Pay reports prorate the current rate using calendar days; they do not reconstruct past pay changes or active periods. Provider dollar values are configurable estimates. The default $25 budget does not guarantee every account can refresh daily at every vendor tier.

Payments, plans, pricing, View users, and impersonation are intentionally omitted. Optional daily email summaries, WhatsApp delivery, cross-page source-video matching, a separate pre-save profile preview, and exhaustive historical backfill are not implemented.

## Earlier baseline

Earlier release notes recorded successful SDK/RLS/import regression suites, type checks, production compilation, and local browser checks for collections and the admin directory. Those baseline checks covered the earlier six migrations and do not substitute for the new V2 integration and hosted checks.
