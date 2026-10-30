# Deploy Distribution Desk V2

The app uses Next.js, Supabase Auth/PostgreSQL, and the Supabase SDK over HTTPS. No direct database connection string is needed by the app or importer. This guide describes setup to perform in your own accounts; **the local implementation work has not applied production SQL or deployed to Vercel**.

## 1. Apply database migrations

For a new Supabase project, run all eleven files once, in this order. For an existing installation, run only the files that have not already been applied.

**If you already ran the three V2 migrations:** apply `20261026030000_instagram_looter_performance.sql` (if not yet applied) and then `20261029000000_content_dashboard.sql`. If only the first six are applied, run files 7–11 below in order.

| Order | Migration | Purpose |
|---:|---|---|
| 1 | [20261024000000_init.sql](./supabase/migrations/20261024000000_init.sql) | Users, workspaces, Auth trigger, and row-level security |
| 2 | [20261024010000_sdk_operations.sql](./supabase/migrations/20261024010000_sdk_operations.sql) | Atomic collection/page operations and request accounting |
| 3 | [20261024015000_sdk_admin.sql](./supabase/migrations/20261024015000_sdk_admin.sql) | Stored-role admin directory queries |
| 4 | [20261024020000_sdk_legacy_import.sql](./supabase/migrations/20261024020000_sdk_legacy_import.sql) | Atomic legacy import validation and apply |
| 5 | [20261025000000_workspace_transfer.sql](./supabase/migrations/20261025000000_workspace_transfer.sql) | Portable identities and chunked workspace backups |
| 6 | [20261026000000_admin_directory.sql](./supabase/migrations/20261026000000_admin_directory.sql) | Collection membership names and admin metric availability |
| 7 | [20261026010000_analytics_history.sql](./supabase/migrations/20261026010000_analytics_history.sql) | Page metadata, history, alerts, shared cache, and provider operations |
| 8 | [20261026015000_analytics_operations.sql](./supabase/migrations/20261026015000_analytics_operations.sql) | Owner-safe page creation/assignment and metadata operations |
| 9 | [20261026020000_analytics_transfer.sql](./supabase/migrations/20261026020000_analytics_transfer.sql) | Metadata/history/alert backup and restore, compatible with old backups |
| 10 | [20261026030000_instagram_looter_performance.sql](./supabase/migrations/20261026030000_instagram_looter_performance.sql) | Encrypted RapidAPI key, ordered query indexes and transactional monthly provider counters |
| 11 | [20261029000000_content_dashboard.sql](./supabase/migrations/20261029000000_content_dashboard.sql) | Page Master display name, pay end date and quiet-day alert setting; start dates default to the day a page is added; content links; alerts keep unchecked pages open and name their post |

Apply file 10 before deploying this version. It preserves existing provider selections and scheduling. Run it during a quiet period: index creation and counter backfill take write locks. It is a transaction, so a failure rolls back its changes. Let it complete before retrying; inspect the error first. It does not delete customer records or old migration history.

Use the SQL Editor, or a consistently tracked Supabase CLI migration workflow:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

If earlier files were applied manually, reconcile that history before switching to CLI pushes. Back up an existing project first. Do not rerun the initial schema, drop existing tables to fix an upgrade, or edit applied migration files. A `relation already exists` or renamed-function error commonly means a file is being reapplied; inspect the migration history and the complete error before proceeding.

The SQL Editor can flag function definitions containing `DELETE` as potentially destructive. Review the actual statement. Transfer cleanup removes expired temporary jobs when invoked; it does not remove customer pages during migration. Later migrations are forward extensions of the earlier schema.

Browser access is read-only and protected by owner/admin RLS. Mutations use verified server routes and fixed-purpose service-role RPCs. `tracked_accounts` is a shared public-data cache; customer metadata, `page_posts`, snapshots, and alerts remain owner-scoped. Provider settings, request logs, and transfer staging are unavailable to browser roles.

## 2. Configure environment variables

Use Node.js 22.x. For a new installation, copy [.env.example](./.env.example) to `.env.local`. For an existing installation, preserve the current file and keys and add only missing values from the example; do not replace `APP_ENCRYPTION_KEY`. In Vercel, add missing variables to the appropriate project environment while retaining existing credentials. Keep preview and production configurations separate.

Required:

- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase API origin.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: publishable key, or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `NEXT_PUBLIC_APP_URL`: application origin, such as `https://desk.example.com`; no path or trailing query.
- `SUPABASE_SECRET_KEY`: server secret, or legacy `SUPABASE_SERVICE_ROLE_KEY`. Never use a public/anon key here.
- `APP_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64, retained across deployments.
- `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH=false` until Google is configured.

Generate the encryption key once and store it securely:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Changing it makes saved personal provider keys and the shared RapidAPI key unreadable unless they are re-encrypted or entered again. This is separate from Supabase and provider credentials.

Instagram Looter uses the **RapidAPI key saved in `/admin/providers`**; no new environment variable is required. Other shared fetches use server-only `YOUTUBE_API_KEY`, `HIKERAPI_KEY`, `LAMATOK_KEY`, and optional `TIKHUB_KEY`/`SCRAPECREATORS_KEY`. Add only the keys you intend to use. Admin pages show whether a key is configured, never its value. No provider key, Supabase server secret, encryption key, or cron token belongs in a `NEXT_PUBLIC_*` variable.

```sh
npm ci
npm run check:env -- --production
```

The checker validates core variable formats without displaying secret values. It does not verify credentials, provider balances, SMTP, database connectivity, or the optional provider/cron configuration. Public variables are compiled into the app, so rebuild after changing them.

## 3. Configure authentication

In Supabase Auth, set the Site URL to the final application origin. Allow its exact `/auth/callback` URL and, for development, `http://localhost:3000/auth/callback`. Set `NEXT_PUBLIC_APP_URL` to the matching origin. Avoid unrestricted production redirect wildcards.

Enable Email authentication, email confirmation, a suitable password policy, and production SMTP with a verified sender. Test delivery to a non-team email address. Standard signup and recovery use the app callback. If you customize token-hash templates, these routes are supported:

```html
<!-- Confirm signup -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard">Confirm email</a>
<!-- Password recovery -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
```

Recovery continues at `/reset-password`. Do not put access tokens, passwords, or keys into templates or custom application URLs. See [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).

The login form also offers **Email me a sign-in link** for existing accounts. It uses Supabase email OTP with PKCE and does not create new users. Use the configured Supabase magic-link template and open the resulting email in the same browser that requested it. Keep the standard confirmation link flow when customizing that template; test the full callback before sharing it. Users can use their password if a sign-in link expires or is opened in another browser.

For Google, create an OAuth web client, enter the exact Supabase provider callback in Google Cloud, and configure the client ID/secret in Supabase Auth. The provider callback is normally `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`; it differs from the application's `/auth/callback`. Set `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH=true` and rebuild. Follow [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

## 4. Build and deploy

```sh
npm run typecheck
npm test
npm run build
```

Import the repository into Vercel as a Next.js project, select Node.js 22.x, and use `npm ci` with `npm run build`. The default daily cron supports Vercel Hobby; review its setup and batch limits below before enabling scheduled refresh. An environment-free build can show the demo and setup screens; it does not mean authentication or live data is configured.

Refresh/cron routes declare a 300-second maximum duration and use shorter internal deadlines. Confirm the [function limits of your Vercel plan](https://vercel.com/docs/functions/configuring-functions/duration). Keep the function region near Supabase. For a local production smoke check after building, use `npm start`.

## 5. Designate the admin in the database

Sign up normally and verify the intended account. Find its exact UUID:

```sql
select id, email, user_type
from public.users
where email = 'YOUR_VERIFIED_EMAIL';
```

Then change only that record:

```sql
update public.users
set user_type = 'admin'
where id = 'YOUR_VERIFIED_USER_UUID';
```

Reload the app. `/admin` shows people, collections, and pages, with page assignment/management; `/admin/providers` shows provider operations. The admin's own dashboard still loads their own workspace. Revoke admin access by setting the same row to `user`; subsequent protected requests recheck the stored role.

Signup, login, editable Auth metadata, and backup files cannot grant admin. There is no email-list bootstrap, role editor, View tier, subscription gating, or impersonation.

## 6. Review provider rates and enable scheduling

For Instagram Looter:

1. Open [the selected API](https://rapidapi.com/irrors-apis/api/instagram-looter2/) in your own RapidAPI account and choose a plan. Review the subscription, request limit, overage and bandwidth terms there.
2. In `/admin/providers`, paste the RapidAPI key into **Instagram Looter** and save it. It is encrypted using your existing `APP_ENCRYPTION_KEY`. A blank field leaves the saved key unchanged; **Remove saved key** clears it explicitly.
3. Choose **Instagram Looter (RapidAPI)** as the Instagram primary provider and save settings. Keep only fallbacks you intend to pay for. Saving the key alone does not change the order or enable scheduling.
4. Set the monthly request cap to fit your plan. The seeded `$0.000660` request estimate is a planning allocation, not a per-call invoice or a cap on subscription/overage/bandwidth fees. App and provider billing-month boundaries can differ.
5. Refresh one public Instagram account with a small post limit. Check the profile, publication order, pinned posts, counts, coverage label and request logs. New Looter calls use `/profile` and `/user-feeds2`. The media feed requests 12 posts per page and sends `end_cursor` for the next page. These contracts were verified live; compare with Instagram and test a private/nonexistent handle in your account before enabling scheduled collection.
6. Confirm a second user sees only their own saved data and that neither API responses nor workspace backups contain the key. Then configure scheduling below if wanted.

Before the first paid refresh, visit `/admin/providers` and set provider order, fallback order, request prices, the monthly request cap, and estimated budget. Defaults are 25,000 attempts/month, a $25 estimated budget, 24-hour refresh intervals, and scheduling **paused**. HikerAPI/LamaTok default to $0.02/request; verify your purchased tier before changing them. Cost examples and vendor links are in [README.md](./README.md).

Create a separate random cron secret of at least 32 characters:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set it as `CRON_SECRET` in Vercel. The endpoint requires `Authorization: Bearer <CRON_SECRET>`; cookies or query-string tokens are not accepted. Vercel supplies this header for configured cron invocations.

`vercel.json` schedules `/api/cron/refresh` once daily at `17 0 * * *` (00:17 UTC). **This default schedule supports Vercel Hobby.** The exact execution time is not guaranteed on Hobby. Scheduling remains paused in the database until you enable it after configuring keys, the cron secret, and provider prices. Manual refresh remains available while it is paused.

Each invocation uses an internal roughly 220-second deadline and at most 50 attempted shared accounts, selecting oldest attempts first. Each account normally becomes due after 24 hours. Work beyond the batch/deadline remains for a later run. **The daily default does not guarantee that every account refreshes each day**; larger queues may take several days, and recent-post fetching, paging costs, or slow providers can reduce throughput. Inactive pages do not refresh automatically. Shared cached results are copied to each owner's history without copying their private details into the shared cache.

If the queue needs more frequent processing, use an authenticated external scheduler or a Vercel plan supporting hourly cron. On a supporting Vercel plan, change the expression to `17 * * * *`; with an external scheduler on Hobby, remove the built-in cron entry instead. Hobby rejects expressions that run more than once per day, even when the database refresh switch is off. See [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

At 75% of either cap, the interval doubles; at 90%, it quadruples. At the cap, paid requests stop and saved data stays available. Every attempt, including retry/fallback, reserves its request and estimated cost atomically. Provider invoices may differ from these configured estimates.

Test one real page with a small allowance, inspect the request log, then enable **Scheduled refresh**. Raw debug samples are redacted and bounded. Cleanup removes samples older than seven days during scheduled invocations or subsequent provider activity; an idle deployment does not run cleanup by itself. Request metadata remains for reporting.

## 7. Hosted smoke checks

Use two accounts or separate browser profiles:

1. Signed out, open `/demo`; protected dashboard, collections, and admin routes must require login. Protected APIs must reject anonymous requests.
2. Test signup, email confirmation, password sign-in, same-browser emailed-link sign-in for an existing account, sign-out, recovery, and Google if enabled. Confirm login/signup expose no admin choice.
3. Account A: add a page, edit its pay/editor/status, create collections, and reload. Account B must not read or change A's records through either UI or API.
4. Promote A through SQL. Inspect B's collections/pages and assign/edit a page for B. Confirm the admin's own dashboard remains owner-scoped. Revoke A and verify the next admin request fails.
5. Refresh a real public account. Check request counts/cost, unknown versus zero metrics, coverage, failed refresh preservation, and last-updated time. Repeat from a second owner to check shared caching.
6. Verify signed cron authentication and a bounded run. Check paused scheduling, inactive pages, queue progress, and cap behavior using small test limits.
7. Check range comparisons, maturing/history-needed labels, platform-specific rankings, CSV, and browser Print/Save as PDF. New live data will not immediately have day-seven scores.
8. Export A's workspace and import into B with preview. Check metadata, history, alerts, memberships, and browser preferences. Repeat with keep/overwrite; unrelated data must remain. Keys/roles/global provider configuration must not transfer.
9. Test mobile layouts, keyboard dialogs, empty/error states, and large lists.

## Backups and legacy imports

Use **Import / export** in `/collections` for full current backups. The authenticated transfer API stages 512 KB chunks, caps uploads at 100 MB, and applies the whole import transactionally. Jobs expire after one hour. Downloaded files contain private page/business data; keep them securely. Schema migrations and backups serve different purposes.

The separate legacy CLI accepts a sanitized export of `collections`, `pages`, and `memberships` plus an explicit old-owner-to-Supabase-UUID JSON map. Create each target Auth account and sign in first. Keep exports and maps outside Git. This CLI preserves old record IDs, inserts missing rows, and never overwrites conflicting records; it does not import V2 analytics history, roles, keys, settings, or browser preferences.

```sh
# Validate local files only.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --validate-only
# Check target users/collisions/limits through Supabase without writing rows.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json
# Apply after reviewing the dry run.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --apply
```

## Operations and troubleshooting

- Enable Supabase backups appropriate to your project and test a restore into a separate environment. A Vercel code rollback does not roll back database migrations.
- Retain `APP_ENCRYPTION_KEY`. Revoke exposed provider credentials at the provider, then replace them in server configuration or personal settings.
- A missing relation/RPC usually indicates unapplied migrations or the wrong Supabase project. `already exists` usually means a migration is being reapplied; inspect before changing anything.
- Auth redirects depend on the exact app origin, callback allowlist, and a rebuild after public-variable changes. Email delivery depends on SMTP/provider settings.
- Provider failures can mean missing keys, an incorrect adapter order, provider balance/availability, or a request/budget limit. Saved data should remain available.
- Scores showing insufficient data are expected until enough real day-seven observations exist. Historical follower values cannot be recovered by rerunning a fetch.
- No optional email summary or WhatsApp delivery is configured in this release. Cross-page content matching runs in the browser and only suggests links; the owner confirms each one.
