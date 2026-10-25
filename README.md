# Distribution Desk

Distribution Desk brings Instagram, YouTube, and TikTok pages into one workspace. Group a creator's official accounts, fan pages, clipping channels, or a brand's pages into collections, then compare their available public metrics side by side and as combined totals.

The application runs on Next.js with Supabase for authentication and PostgreSQL storage. It is configured for deployment on Vercel and uses the Supabase JavaScript SDK over HTTPS for backend data access.

## Features

- **Private workspaces:** email/password registration, email confirmation, password recovery, and optional Google sign-in.
- **Collections:** create, rename, duplicate, and delete groups; add pages in bulk and remove pages from individual collections.
- **Cross-platform comparison:** followers/subscribers, selected-post views, likes, comments, shares, and post counts, with separate profile lifetime totals where available.
- **Flexible selections:** choose 1-1,000 recent posts per page or a publication date range, with coverage labels and last-refresh details.
- **Manual refreshes:** refresh one page or the visible selection, with progress, error feedback, cached snapshots, and a monthly provider request cap.
- **Reporting:** search, filter by platform, sort pages, choose visible columns, and export the current view as CSV.
- **Workspace backups:** export every collection, tracked social account, post snapshot, metric and saved view as JSON, then import into another login with a preview and duplicate detection. Large backups transfer in chunks.
- **Easier navigation:** searchable collections, mobile navigation, 25-row table pagination, and a monthly API usage meter. Totals and CSV exports still cover all matching pages.
- **Manual metric entries:** edit displayed values; an asterisk (`*`) and CSV flags identify manual values. Overrides and column preferences are saved per account in that browser.
- **Admin directory:** inspect People, Collections, and Pages across registered workspaces, including ownership and collection membership.

## Tech stack

| Area | Technology |
|---|---|
| Application | Next.js 16 App Router, React 19, TypeScript |
| Styling and icons | Tailwind CSS 4, custom CSS, Lucide |
| Authentication | Supabase Auth with server-side session handling |
| Database | Supabase PostgreSQL, row-level security, and server-only RPCs |
| Data providers | TikHub, ScrapeCreators, optional YouTube Data API v3 |
| Hosting and runtime | Vercel, Node.js 22.x |
| Verification | TypeScript, Node.js test runner, PostgreSQL integration tests using PGlite |

Exact dependency versions are in [package.json](./package.json) and [package-lock.json](./package-lock.json).

## Local setup

You need Node.js **22.x**, npm, and a Supabase project. Use a separate Supabase project for development, or configure a local stack with [supabase/config.toml](./supabase/config.toml).

### 1. Install dependencies

Open PowerShell in the main workspace:

```powershell
Set-Location 'P:\VI\distribution-desk'
npm ci
```

### 2. Initialize Supabase

Apply the migrations once, in this order, through the Supabase SQL Editor or the Supabase CLI migration workflow:

| Migration | Purpose |
|---|---|
| [20261024000000_init.sql](./supabase/migrations/20261024000000_init.sql) | Tables, Auth profile trigger, and browser access policies |
| [20261024010000_sdk_operations.sql](./supabase/migrations/20261024010000_sdk_operations.sql) | Atomic collection, page, request-accounting, and refresh operations |
| [20261024015000_sdk_admin.sql](./supabase/migrations/20261024015000_sdk_admin.sql) | Admin directory queries with stored-role authorization |
| [20261024020000_sdk_legacy_import.sql](./supabase/migrations/20261024020000_sdk_legacy_import.sql) | Atomic import validation for workspace restoration and legacy imports |
| [20261025000000_workspace_transfer.sql](./supabase/migrations/20261025000000_workspace_transfer.sql) | Portable record identities and private, chunked workspace backup/import operations |

For an existing database, apply only migrations that have not already run. The application tables are `users`, `collections`, `pages`, `memberships`, `settings`, and `usage` in the `public` schema.

Enable the Email provider in Supabase Auth. For local development, set the Site URL to `http://localhost:3000` and allow `http://localhost:3000/auth/callback` as a redirect URL. Email confirmation and password recovery also use the app's Auth routes. See [DEPLOYMENT.md](./DEPLOYMENT.md) for email templates, SMTP, Google OAuth, and production Auth configuration.

### 3. Configure environment variables

Create `.env.local` in the project root, or update your existing one, with your project values. Use the template below and replace every placeholder:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
SUPABASE_SECRET_KEY=sb_secret_REPLACE_ME
APP_ENCRYPTION_KEY=YOUR_BASE64_ENCODED_32_BYTE_KEY

NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_ENABLE_GOOGLE_AUTH=false
```

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project API origin |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public key used by browser and Auth clients |
| `SUPABASE_SECRET_KEY` | Server-only key for authorized backend operations |
| `APP_ENCRYPTION_KEY` | Server-only key used to encrypt saved provider API keys with AES-256-GCM |
| `NEXT_PUBLIC_APP_URL` | Full application origin, including `http://` locally or `https://` in production; no path |
| `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH` | Set to `true` after configuring Google in Supabase Auth; otherwise `false` |

Legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are supported as fallbacks for the public and server keys respectively. **A `DATABASE_URL` is not required** by the app or importer.

Generate `APP_ENCRYPTION_KEY` once with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep this key stable and backed up across deployments. Changing it makes existing encrypted provider keys unreadable unless they are re-encrypted or entered again. Keep all server secrets out of Git and `NEXT_PUBLIC_*` variables.

Next.js also loads `.env`, but the `check:env` and `import:legacy` commands explicitly load `.env.local`. Use `.env.local` for local configuration so those commands see the same values as the application.

### 4. Validate and start

```sh
npm run check:env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The environment check validates required values and formats without printing secrets; it does not verify Supabase connectivity, migrations, or Auth provider setup.

## Using the workspace

1. Register and confirm your email, or sign in with Google if enabled.
2. Create a collection named after a creator, brand, or another group you want to track.
3. Add public profile URLs or handles. Bulk entry accepts one per line or comma-separated entries; choose the platform for bare handles.
4. Open **API settings**, select TikHub or ScrapeCreators, and save your own provider key. You can also add a YouTube Data API key for YouTube channels.
5. Choose a recent-post count or publication date range, then refresh the pages.
6. Compare totals, review coverage, customize visible columns, and export CSV when needed.

You can organize pages before connecting a provider. Fetching metrics requires the appropriate key. Provider keys are encrypted before database storage and are excluded from workspace, admin, and CSV responses.

The current limits are **100 collections**, **500 unique pages per user**, and **100 entries per bulk-add request**. The monthly request cap is configurable from **10 to 2,500** calls, with a default of **500**. It counts provider request attempts, including retries; provider charges and quotas are separate from application hosting.

## Understanding the numbers

- **Publication ranges:** dates select posts published within the chosen range, using India calendar dates. The displayed counts are those posts' lifetime counters as of the last successful refresh. For example, selecting October shows counters on October-published posts, not views gained during October.
- **Coverage:** providers may return partial data or omit counters and dates. A dash means unavailable; totals add available values, and coverage labels show whether a selection is complete.
- **Profile totals:** lifetime views and post counts are separate from selected-post totals. Automatic lifetime view totals are available for YouTube; Instagram and TikTok do not supply public account lifetime view totals through these adapters.
- **YouTube uploads:** selections can include both Shorts and other public videos. The official API does not expose public share counts. With TikHub alone, use a `/channel/UC...` URL; add a YouTube Data API key to resolve `@handles`.
- **Shared pages:** a page's saved snapshot is reused across its collections within the same user's workspace. Duplicating a collection creates a separate page list; it does not create independent snapshots. All pages counts each saved page once.
- **Audience totals:** follower/subscriber counts are added across pages; audiences can overlap, so the sum is not a count of unique people.
- **Manual entries:** overrides affect displayed totals and CSV exports, retain the `*` marker, and leave stored provider snapshots intact. They are browser-local and do not sync across devices.
- **Refresh behavior:** refreshes are initiated in the UI and run page by page. Matching snapshots less than five minutes old may be reused. Failed refreshes preserve the last successful snapshot; background scheduled collection is not implemented.

## Move a workspace to another account

1. In the source account, choose **Import / export** in the top bar, then **Download workspace**. This downloads a `.json` backup of the entire workspace, regardless of the current collection, filters or table page.
2. Sign in with the destination account, choose **Import / export → Import backup**, and select the file.
3. Choose **Preview import**. Review the collection, social-page and post counts, and see how many records already exist in the destination.
4. Choose **Keep my existing values** to add missing records, or **Use the backup's values** to update matching collection names, page snapshots and manual metric entries. Unrelated records are retained in both modes.
5. Optionally restore provider choice and refresh limits, then choose **Import workspace**.

Backups include page names, handles, native platform identities, posts, counters, coverage, last-refresh timestamps, collection memberships, browser-local manual entries, visible columns and saved post/date selections. View preferences come from the browser performing the export. Imports remap record IDs to the destination user and preserve page-to-collection and post-to-page links. Reimporting the same backup does not create duplicate collections or pages.

API keys, passwords, login sessions, roles and monthly request usage are not transferred. Provider keys must be configured in the destination account for future refreshes. Restoring a different provider choice clears the destination's old social-provider key; usage counters are never reset. Exports preserve the latest stored snapshot, not a historical series of refreshes.

Backups can be up to **100 MB**, including view preferences. The server snapshot is limited to 98 MB to reserve room for those preferences. Transfers use 512 KB binary chunks, with private staging that expires after one hour and is removed on subsequent transfer operations. Validation and final restore run on the server; applying an import is one database transaction, and retrying a committed import is safe.

For existing installations, apply **`20261025000000_workspace_transfer.sql`** before using these controls. The original four migrations must already be present. CSV exports remain available for reporting and cannot be used as workspace backups.

## Accounts and admin access

| Route | Access |
|---|---|
| `/` and `/login` | Public homepage and authentication |
| `/dashboard` | Signed-in user's own workspace |
| `/reset-password` | Authenticated password recovery |
| `/api/account`, `/api/desk`, `/api/refresh` | Authenticated backend operations with ownership checks |
| `/api/transfer` | Owner-bound workspace backups, validation, and imports |
| `/admin` and `/api/admin` | Stored `public.users.user_type = 'admin'` role |

New accounts start as `user`. To create the first admin, register, sign in, and identify your verified account's UUID in `public.users`. Then run the following in the Supabase SQL Editor, replacing the placeholder with that exact UUID:

```sql
update public.users
set user_type = 'admin'
where id = 'YOUR_VERIFIED_USER_UUID';
```

Reload the dashboard to see the Admin link. Set the role back to `user` to revoke access. Role assignment is controlled in the database; editable Auth metadata cannot grant admin access.

Browser database access is read-only and protected by row-level security. Backend writes use a separate server-only Supabase client after authentication and authorization. Atomic RPCs are restricted to the service role. Admin access does not expose saved provider keys.

## Deploy to Vercel

1. Apply all required Supabase migrations and configure Auth providers and production email delivery.
2. Import the repository into Vercel with the **Next.js** preset, **Node.js 22.x**, install command `npm ci`, and build command `npm run build`.
3. Set the application variables in Vercel. Use the complete production HTTPS origin for `NEXT_PUBLIC_APP_URL`, for example `https://your-app.vercel.app`.
4. Set Supabase's Site URL to that origin and allow its exact `/auth/callback` URL. Configure preview deployments separately when needed.
5. Validate the intended production environment with `npm run check:env -- --production`, run the checks below, and deploy. Rebuild after changing public variables.
6. Test registration, confirmation, recovery, workspace isolation with two accounts, admin access, provider refreshes, and CSV exports on the hosted app.

The refresh route declares a 300-second maximum duration; verify the deployment supports it. The full configuration and hosted smoke checks are in [DEPLOYMENT.md](./DEPLOYMENT.md). Local checks do not establish that a production deployment or external providers are configured correctly.

## Development commands

| Command | Purpose |
|---|---|
| `npm ci` | Install dependencies from the committed lockfile |
| `npm run dev` | Start the local Next.js development server |
| `npm run check:env` | Validate local environment variable formats |
| `npm run check:env -- --production` | Validate required production configuration |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run application and PostgreSQL regression tests |
| `npm run build` | Create the production build |
| `npm start` | Serve an existing production build |
| `npm run import:legacy -- --help` | Show legacy import options |

Before deploying application changes, run:

```sh
npm run typecheck
npm test
npm run build
```

The GitHub Actions workflow runs these checks after installing dependencies. See [VERIFICATION.md](./VERIFICATION.md) for the recorded verification scope and hosted checks still required.

## Import existing records

The optional [legacy importer](./scripts/import-legacy.mjs) maps old owner IDs to existing Supabase Auth user IDs and preserves collection/page IDs, memberships, cached snapshots, and refresh timestamps. Create the target accounts first and prepare an authorized export plus an owner map using the format in [DEPLOYMENT.md](./DEPLOYMENT.md).

```sh
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --validate-only
npm run import:legacy -- --file workspace-export.json --owners owner-map.json
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --apply
```

The first command validates files locally. The second checks the target through Supabase and reports a dry run. Only `--apply` writes records, in one transaction; existing records are not overwritten. Accounts, roles, provider keys, settings, usage, and browser preferences are not transferred.

## Project structure

| Path | Contents |
|---|---|
| `app/` | Homepage, dashboard, admin page, authentication routes, API routes, and styles |
| `components/` | Workspace dashboard, admin directory, and Auth forms |
| `lib/` | Identity checks, Supabase clients, encryption, provider adapters, metric display, and selection logic |
| `public/` | Static assets |
| `scripts/` | Environment validation, public-secret build guard, and legacy importer |
| `supabase/migrations/` | Versioned schema, access policies, and backend RPCs |
| `supabase/tests/` | SQL access-policy checks |
| `tests/` | Application and PostgreSQL regression tests |
| `.github/workflows/ci.yml` | Automated typecheck, test, and build workflow |
| `DEPLOYMENT.md` | Detailed setup, operations, data import, and troubleshooting |
| `vercel.json` | Vercel framework and install/build commands |
