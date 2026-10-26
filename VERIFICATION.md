# Verification

## Instagram Looter live endpoint correction — 2026-10-26

Hosted request logs showed HTTP 500 from `/user-feeds`, plus HTTP 200 `/web-profile` responses containing `{status:false,errorMessage:"This account does not exist."}`. Those HTTP 200 failures had been incorrectly recorded as successful requests.

The signed-in RapidAPI playground was used to verify the replacement contract, without changing credentials or purchasing a plan:

- `/profile?username=theunscripted.bharat` returned HTTP 200, `status:true`, the matching username, stable ID `15629622050`, and public profile counters. The adapter now uses User Info V1 rather than `/web-profile`.
- `/user-feeds2?id=38276910342&count=12` returned HTTP 200 with twelve media nodes under `data.user.edge_owner_to_timeline_media.edges`. Its feed `page_info` supplies `has_next_page` and `end_cursor`; per-post comments have a separate `page_info` and must not drive feed pagination.
- A continuation using the exact returned cursor failed with `count=50` (HTTP 500/Internal Error) and succeeded with `count=12`, returning different posts and a new cursor. The adapter now requests 12 per page and uses `end_cursor` rather than the V1 `max_id` parameter.
- A returned GraphVideo retained 4,121 views, three likes and zero comments despite `like_and_view_counts_disabled:true`. Tests cover this exact minimal observed shape rather than assuming the presentation flag hides all counters.
- `status:false` is rejected inside the request boundary before success logging. The confirmed account-not-found and private-account messages produce safe fixed errors; arbitrary upstream text and credentials remain excluded.
- `podbh_arat` remained unavailable in both alternate Looter lookups. Opening that exact profile in the signed-in Instagram browser also displayed “Sorry, this page isn't available.” Its saved handle needs correction or confirmation independently of the adapter fix; it was not silently remapped or deleted.

The public GraphQL fixture contains selected response fields only, without credentials, biography/contact details, signed media URLs or video manifests. This is an application fix; **no additional database migration or new environment variable is needed**. Existing historical failed/success log rows are retained unchanged. The older fixture-only validation notes below describe the preceding implementation.

Local validation for this correction: **50 tests passed, zero failures**, using `node --test tests/instagram-looter.test.mjs tests/provider-adapters.test.mjs tests/refresh-service.test.mjs`. TypeScript, the public-env guard and the production webpack build also passed. This targeted run covers the changed adapter/error boundary and shared manual/cron service; the unrelated full suite was not rerun.

## Instagram Looter and performance update — 2026-10-26

`node --test tests/*.test.mjs` passed **232 tests, zero failures, zero skipped**. The full run includes the existing authentication, tenant isolation, backup/import, admin and provider regressions alongside:

- Instagram-only Looter registration, exact HTTPS host/header handling, native ID precision, missing/rounded counters, pinned-post ordering, date ranges, private/wrong accounts, malformed responses and incomplete pagination.
- Real AES-GCM admin save/replace/blank-preserve/remove, CSRF and stored-role checks, no plaintext/ciphertext in returned settings, and no automatic provider switch or scheduling change.
- Manual and cron use of the dashboard key through the shared request service, cross-owner public cache reuse, request/cost caps, credential removal, corrupt fallback isolation, and preserved personal-provider behavior.
- The tenth migration's historical usage backfill, UTC month/funding/cost corrections, deletions, rollback, browser-role denials and cap reservation. PGlite serializes queued calls; this is not a multi-session production contention benchmark.
- Seeded query plans with 16,000 posts, 24,000 account snapshots, 48,000 post snapshots, 2,000 alerts, 1,600 memberships, 5,000 shared accounts and 15,000 logs. Ordered queries select the matching indexes without an additional Sort; retention finds only the ten retained raw-response rows in its fixture.
- Parallel analytics loads retain all 1,001 posts, reduce sequential network wait rounds from seven to three, cap concurrency at three, abort sibling requests on failure/cancellation and reject inconsistent continuation/cutoff data. Legacy cursor clients remain compatible.
- Calculator caches preserve full report equality, owner-dataset isolation, clock changes, filtered alerts, full-workspace health scores and long-range chart alignment.

The synthetic calculation benchmark used 48 pages, 8,640 posts, 75,792 post snapshots and 9,648 account snapshots. Median of three runs with the same native-module loading: **2,351.5 ms before → 713.6 ms after** (about 70% less calculation time), with exact full-report equality. Filtering the prepared history to 24 pages took 171.9 ms. These are local calculation measurements, not hosted page-load guarantees. Run `node scripts/benchmark-analytics.mjs` for current-code timings; pass a saved earlier `metrics.ts` as the optional first argument for before/after comparison.

The public-env guard and TypeScript checks pass. `node node_modules/next/dist/bin/next build --webpack` passed compilation, TypeScript, route generation and tracing. A fresh production server rendered `/demo`; Instagram filtering, page search, date comparisons and monthly reports worked with no browser warning/error logs. Desktop and 390-pixel mobile checks of a synthetic server-rendered provider console verified readable key/provider forms, no document horizontal overflow, a 16px mobile password input and clear removal controls. The four interaction tests cover success/failure behavior; the static preview does not claim a live authenticated browser save. Temporary preview servers/tabs were closed.

Request URLs and parameters were verified in the [provider's public playground](https://rapidapi.com/irrors-apis/api/instagram-looter2/playground): `/web-profile?username=...` and `/user-feeds?id=...&count=...&max_id=...`. It exposes **no example responses** for these endpoints. Tests use explicitly synthetic native Instagram response fixtures, not captured live Looter responses. A subscribed live smoke test remains required to verify those response envelopes and available counters. Wait for the existing five-minute workspace cache to expire, or use a newly tracked public account; confirm new Looter entries appear in the admin request log.

No hosted migration, provider subscription, paid request or production deployment was performed. Apply `20261026030000_instagram_looter_performance.sql` before deploying, then save/select Looter and perform the live checks in [DEPLOYMENT.md](./DEPLOYMENT.md). The migration takes write locks while creating indexes/backfilling; use a quiet window.

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

- Applying only missing migrations from the ten-file sequence in [DEPLOYMENT.md](./DEPLOYMENT.md).
- Supabase Data API connectivity, email confirmation/recovery delivery, and optional Google sign-in.
- Real vendor credentials, purchased price tiers, public/private/not-found responses, endpoint coverage, and invoices.
- The configured daily cron (supported on Hobby), a valid `CRON_SECRET`, and real queue throughput within function limits; a more frequent scheduler requires appropriate hosting.
- Two-account isolation and SQL-designated admin access on the deployed services, including role revocation.
- A hosted full-backup round trip between accounts, including browser preferences, after all migrations are applied.

Use the explicit smoke checklist in [DEPLOYMENT.md](./DEPLOYMENT.md). The demo is synthetic and does not prove that a provider or production database is configured.

## Expected limits, not fabricated results

Actual tracking history starts with saved observations. Imported old posts do not acquire invented earlier views or follower history. Day-seven performance needs an observation at 7–8 days of post age; health scores require enough comparable matured posts and component data. Partial coverage remains labelled.

Pay reports prorate the current rate using calendar days; they do not reconstruct past pay changes or active periods. Provider dollar values are configurable estimates. The default $25 budget does not guarantee every account can refresh daily at every vendor tier.

Payments, plans, pricing, View users, and impersonation are intentionally omitted. Optional daily email summaries, WhatsApp delivery, cross-page source-video matching, a separate pre-save profile preview, and exhaustive historical backfill are not implemented.

## Earlier baseline

Earlier release notes recorded successful SDK/RLS/import regression suites, type checks, production compilation, and local browser checks for collections and the admin directory. Those baseline checks covered the earlier six migrations and do not substitute for the new V2 integration and hosted checks.
