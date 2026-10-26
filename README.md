# Distribution Desk V2

Distribution Desk tracks public Instagram, TikTok, and YouTube pages in private workspaces. Add a handle or profile URL, record who manages the page and its monthly pay, and compare performance and cost. Social account passwords or account linking are not required.

This release has two roles: **user** and **admin**. Users manage their own pages and collections. Admins inspect all workspaces, assign and manage customer pages, and configure shared data providers. Admin access is assigned only in the database; login and signup do not offer an admin option. Payments, subscriptions, pricing, and the proposed View tier are excluded from the current scope.

The main workspace is `P:\VI\distribution-desk`. Start with [START_HERE.md](./START_HERE.md), use [DEPLOYMENT.md](./DEPLOYMENT.md) for Supabase and Vercel setup, and see [VERIFICATION.md](./VERIFICATION.md) for the validation record.

## What is included

| Route | Purpose |
|---|---|
| `/demo` | Synthetic demonstration data; no provider keys or real workspace changes |
| `/dashboard` | Overview, page management/detail, performance, posts, economics, monthly reports, and alerts |
| `/collections` | Collections, bulk page entry, manual metric entries, saved views, and full workspace import/export |
| `/admin` | People, their collections and pages, customer page assignment, and page management |
| `/admin/providers` | Provider/fallback order, request limits, estimated spend, scheduling, and failed fetches |
| `/login` | Email/password registration, password or emailed-link sign-in, recovery, and optional Google |

- Date presets cover Today, 7/30/90 days, This month, Last month, and custom dates. Compare a range with a previous or custom range.
- Page details include monthly pay, editor/responsible person, start date, active status, and notes. Pausing keeps history and stops scheduled refreshes.
- Analytics show recorded view gains, followers and growth, posts published, typical performance, platform-specific rankings, health score breakdowns, and prorated costs.
- Reports export to CSV. The monthly report can be printed or saved as PDF through the browser print dialog.
- Shared provider caching avoids fetching the same public account separately for each customer. Owner-specific metadata and imported history remain private.
- Full backups move collections, details, cumulative posts, recorded history, alerts, and browser preferences between accounts. Existing version-1 backups still work.

## How to read the numbers

**History begins when observations are saved.** A first fetch imports available posts and their current counts; it cannot recover past follower counts or a post's earlier views. The first fetch asks for up to 100 posts. Larger selections can be fetched from Collections, subject to provider pagination, scope, and request limits. This is not an unlimited historical backfill.

The default **views gained** metric measures changes between actual observations in the selected range. **Views of posts published in range** uses the latest saved counts of those posts. Missing boundaries and incomplete coverage are labelled. Daily chart points describe changes between observations ending on that date; gaps are not filled with invented values.

Typical views, engagement, hit rate, consistency, performance alerts, and health use a saved observation at **7–8 days of post age**. Younger posts are marked maturing. Older posts imported today may never have a comparable day-seven observation. Health scores need at least eight comparable matured posts and enough data for their components. Expect a warm-up period after tracking starts. Rankings and engagement comparisons stay within each platform.

Account samples keep the first observation per UTC day. Post samples are captured daily through day 30, then at least seven days apart through day 90; older posts retain an initial observation. Capture occurs when the post is returned by a successful fetch, so posts outside the fetched recent-post window can have gaps. Display ranges use India time.

Unavailable metrics remain unavailable, including public Instagram saves and reach. A real zero is shown as zero. Alerts require a condition on two distinct daily checks and suppress rapid repeats.

Page pay is a reporting field in INR. The **current monthly rate** is prorated using each month's actual calendar days, the configured start date, and dates no later than today. Past rate changes and historical active/inactive periods are not reconstructed. Pausing tracking does not create a historical pay stop date. The app does not collect or pay money.

## Local setup

Use Node.js **22.x**, npm, and a separate Supabase development project. Backend data access uses the Supabase SDK over HTTPS; a PostgreSQL connection string is not needed.

```powershell
Set-Location 'P:\VI\distribution-desk'
npm ci
# New installation only; preserve an existing .env.local.
Copy-Item .env.example .env.local
```

For an existing installation, keep `.env.local` and its current keys, especially `APP_ENCRYPTION_KEY`; add only missing variables from the example. Fill in configuration and apply the migration sequence in [DEPLOYMENT.md](./DEPLOYMENT.md). Existing databases need **only missing migrations, once, in filename order**. If the first six are applied, add only `20261026010000_analytics_history.sql`, `20261026015000_analytics_operations.sql`, and `20261026020000_analytics_transfer.sql`. A fresh database needs all nine. Do not rerun the initial schema or edit an already-applied migration.

```powershell
npm run check:env
npm run dev
```

Open `http://localhost:3000/demo` for the demonstration or `/login` for a real workspace. Configure Supabase Auth callback URLs before testing confirmation and recovery. The development server binds to `127.0.0.1`; use the configured `localhost` origin for Auth callbacks.

Existing users can choose **Email me a sign-in link**. Open that email in the same browser that requested it so the PKCE flow can complete; new users register first. Password and Google sign-in remain available when configured.

## Environment variables

Copy [.env.example](./.env.example). Only variables beginning with `NEXT_PUBLIC_` may be exposed to the browser.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project API origin |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key; legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is supported |
| `NEXT_PUBLIC_APP_URL` | Application origin; HTTPS in production |
| `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH` | `false` unless Google is configured in Supabase |
| `SUPABASE_SECRET_KEY` | Server-only secret; legacy `SUPABASE_SERVICE_ROLE_KEY` is supported |
| `APP_ENCRYPTION_KEY` | Stable 32-byte base64 key for encrypted workspace provider keys |
| `HIKERAPI_KEY` | Shared Instagram provider key |
| `LAMATOK_KEY` | Shared TikTok provider key |
| `YOUTUBE_API_KEY` | Official YouTube Data API v3 key |
| `TIKHUB_KEY` / `SCRAPECREATORS_KEY` | Optional fallback keys |
| `CRON_SECRET` | Random server-only token, at least 32 characters, for scheduled refresh |

All provider keys are server-only. Admin settings change order and limits, not secret values. If shared providers are unavailable, Collections retains encrypted personal provider settings for manual refresh. Those requests are labelled workspace-funded and do not consume the shared estimated-dollar budget. Scheduled refresh requires shared keys.

There is no `ADMIN_EMAILS` role bootstrap or payment-provider configuration. Sign up normally, verify the account, then change that exact `public.users` row as described in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Providers, refreshes, and costs

Fetches use `lib/social-provider.ts` and the shared refresh service. Adapters cover official YouTube, HikerAPI, LamaTok, TikHub, and ScrapeCreators. The database chooses the ordered provider list; unconfigured adapters are skipped. The request boundary handles timeouts, one retry with backoff, pacing, response limits, request reservations, and logs. Official YouTube uses uploads playlists and video endpoints rather than search queries.

The default shared budget is **$25/month estimated**, with a 25,000-request cap. HikerAPI and LamaTok default to **$0.02/request** conservatively. Set the actual rates for your purchased tier in `/admin/providers`. Reserved attempts count toward the estimate; it is not a vendor invoice or a guarantee of the final bill. Hosting, Supabase, taxes, prepaid deposits, and personal provider keys are separate.

Assuming two requests per unique paid-provider account per day for 30 days:

| Unique accounts | Requests/month | At $0.001/request | At $0.02/request |
|---:|---:|---:|---:|
| 50 | 3,000 | $3 | $60 |
| 150 | 9,000 | $9 | $180 |
| 300 | 18,000 | $18 | $360 |

Initial imports, pagination, retries, and fallback calls add requests. Two requests daily is a planning assumption. The $25 budget cannot sustain these workloads at the entry rate: scheduling slows near the caps and stops spending at the cap. Confirm your tier before enabling it. Vendor references checked for this release: [HikerAPI tier rates](https://hikerapi.com/help/affiliate) and [LamaTok pricing](https://lamatok.com/tiktok-api).

**Scheduled refresh is paused by default in the database.** `vercel.json` invokes `/api/cron/refresh` once daily with `17 0 * * *` (00:17 UTC), which supports Vercel Hobby. The exact execution time is not guaranteed on Hobby. Each run attempts at most 50 shared accounts within roughly 220 seconds, so the daily schedule does not guarantee that every account refreshes each day. Manual refresh remains available. For a larger queue, use an authenticated external scheduler or change to hourly cron on a supporting Vercel plan. See [DEPLOYMENT.md](./DEPLOYMENT.md) for setup and [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Move a workspace to another account

1. In the source account, open **Collections & backups → Import / export** and download the JSON backup.
2. Sign into the destination account, upload it, and review page, collection, history, and alert counts.
3. Keep existing values or overwrite matching values. Both choices add missing records and retain unrelated destination data.

Imports remap owners and references. Portable identities make retries and repeated imports safe. Apply is one database transaction, including metadata and history. The format stays `distribution-desk.workspace`, version `1`, with an optional versioned analytics section.

Backups exclude Auth accounts, roles, keys, global provider settings, request logs, usage counters, and the shared cache. Re-enter personal keys separately. Browser preferences and manual values restore in the importing browser; they do not replace the saved observations used by analytics.

Transfers use 512 KB chunks, a 100 MB upload limit, and a 98 MB server snapshot limit. Temporary jobs expire after one hour. Keep downloaded backups securely; transfer staging is not permanent storage. The older owner-mapped CLI importer remains available; use the full workspace backup flow for V2 history and preferences.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

The stack is Next.js App Router, React, strict TypeScript, Tailwind/custom CSS, Lucide, Supabase Auth/PostgreSQL, and SVG charts. Tests use Node's runner and PGlite with actual migrations and the Supabase SDK. Dependencies and scripts are in [package.json](./package.json).

The V2 verification record includes 202 passing integrated tests, four additional passing rendering/CSV regressions, and a successful production webpack build. See [VERIFICATION.md](./VERIFICATION.md) for the exact runs and hosted checks still needed.

For a repeatable developer fixture, run `node scripts/seed-demo.mjs --output ./demo-data.json --now 2026-10-25T12:00:00Z`. Omitting `--output` prints JSON. Existing output files are rejected. This generates a synthetic `AnalyticsDataset` locally without keys, network calls, or database writes; it is **not an importable workspace backup**. `/demo` uses the same generator automatically without a seed step. Keep generated fixtures outside commits unless they are intentional test assets.

To add a provider, implement `SocialDataProvider` in `lib/providers/types.ts`, normalize unsupported fields to `null`, and send every request through the supplied request function. Register platform support, server key mapping, allowed host, and admin order/cost options. Add fixture contract tests for pagination, missing metrics, failures, and limits. Features and jobs continue to use the shared service.

**No live Supabase migration or Vercel deployment was performed for these local changes.** Real provider requests, Auth delivery, and hosted jobs still need smoke tests with the owner's services.

## Deliberate limits

- No payments, plan gating, View tier, pricing page, or user impersonation.
- Optional daily email summaries, WhatsApp delivery, and matching source videos across pages are not implemented. `source_asset_id` is reserved and preserved for later matching.
- Adding a page saves it and attempts an immediate fetch; there is no separate profile-confirmation preview before saving.
- The demo is an isolated synthetic dataset, not a script that seeds customers into production.
