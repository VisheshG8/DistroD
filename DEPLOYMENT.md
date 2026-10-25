# Deploy Distribution Desk on Supabase and Vercel

This application uses standard Next.js, Supabase Auth, and Supabase PostgreSQL through the JavaScript SDK and HTTPS APIs. The source includes the schema and deployment configuration. The hosting accounts, project credentials, Auth providers, and production email service must be configured in your own accounts. The application and import script do not require a direct PostgreSQL connection string.

## 1. Create the Supabase database

Create a fresh Supabase project, preferably in a region close to your expected users and Vercel function region.

Apply these files from `supabase/migrations/` once, in this order, using the Supabase SQL Editor:

1. `20261024000000_init.sql` — tables, identity trigger, and browser access policies.
2. `20261024010000_sdk_operations.sql` — atomic workspace and refresh operations for the SDK.
3. `20261024015000_sdk_admin.sql` — authorized admin queries for the SDK.
4. `20261024020000_sdk_legacy_import.sql` — the optional import RPC.
5. `20261025000000_workspace_transfer.sql` - portable record IDs and full workspace export/import with private chunk staging.

The SQL Editor may show a potential-issues confirmation for the transfer migration because it defines temporary-transfer cleanup functions containing `DELETE`. This is a query-review warning, not an execution error. The migration backfills only empty portable IDs and enables RLS on both private staging tables, with browser access revoked. Applying it does not delete existing collections or social pages; cleanup functions remove temporary transfer records when invoked.

For an existing project that already has the initial schema, apply only the later migrations that have not been applied. Alternatively, install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), link this directory to your project, and use its migration workflow:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Use one migration workflow consistently. Do not rerun the initial SQL against an already initialized database or edit an applied migration. Add a new migration for later schema changes. If using an existing project, review its current tables before applying this schema; `public.users`, `collections`, `pages`, `memberships`, `settings`, and `usage` are application-owned names.

The initial migration creates:

| Table | Purpose |
|---|---|
| `public.users` | Supabase Auth identity, contact details, and `user_type` |
| `public.collections` | Groups owned by a user |
| `public.pages` | Tracked social profiles and saved snapshots |
| `public.memberships` | Page-to-collection links with same-owner foreign keys |
| `public.settings` | Provider preferences, request cap, and encrypted keys |
| `public.usage` | Monthly provider request accounting |

Supabase Auth registration creates a normal user profile. Browser Data API access is read-only and protected by row-level security. Browser clients cannot read settings or usage, write counters, or promote themselves. The backend verifies the authenticated owner or stored admin role, then uses a separate server-only Supabase client for privileged operations. Named RPCs handle operations that must be atomic; their execution is restricted to `service_role`. No generic SQL execution endpoint is exposed.

## 2. Configure Auth URLs

In **Supabase → Authentication → URL Configuration**, set:

- **Site URL:** your final production origin, for example `https://desk.example.com`.
- **Redirect URLs:** `https://desk.example.com/auth/callback` and `http://localhost:3000/auth/callback`.

If you use a Vercel-assigned domain, use that exact domain instead. Set `NEXT_PUBLIC_APP_URL` to the same production origin. It must contain no path, query, credentials, or fragment.

For a preview deployment, add only the preview origins you intend to use and configure that deployment's `NEXT_PUBLIC_APP_URL` accordingly. Production should use an exact allowlist rather than an unrestricted wildcard. Public variables are compiled into the Next.js build, so rebuild after changing them.

The callback exchanges the Supabase PKCE code and accepts only a safe relative destination. Password recovery returns to the protected `/reset-password` page. Session refresh runs through `proxy.ts`; server authorization verifies the user with Supabase rather than trusting a cookie's unverified contents.

## 3. Configure email registration and recovery

Enable the Email provider in Supabase Auth. Keep email confirmation enabled for production, set a suitable password policy, and configure [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) with a verified sender. Supabase's development email delivery is not a production mail service; test delivery to an address that is not a project team member.

The app passes its callback URL for the normal PKCE confirmation flow. If customizing templates for server-side token-hash confirmation, use:

**Confirm signup**

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard">Confirm your email</a>
```

**Reset password**

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Reset your password</a>
```

The `/auth/confirm` route verifies the token hash. A recovery token is routed to `/reset-password`. Do not place access tokens, database passwords, or provider keys in email templates or application URLs. Test signup, confirmation, sign-out, sign-in, recovery, and changing a password before inviting users.

See [Supabase SSR Auth](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs) and [email templates](https://supabase.com/docs/guides/auth/auth-email-templates).

## 4. Enable Google sign-in, if wanted

Email/password authentication works without Google configuration. To show the Google option:

1. Create a Google OAuth web client and configure its consent screen and authorized users or production publishing status.
2. In Google Cloud, set the authorized redirect URI to the **Supabase provider callback**, usually `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`. Copy the exact URL shown by Supabase if using a custom Auth domain.
3. Enable Google under **Supabase → Authentication → Providers** and enter the Google client ID and secret there.
4. Set `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH=true` in the app and rebuild.

The Google client secret belongs in Supabase's provider configuration, not a `NEXT_PUBLIC_*` application variable. The Google callback and the application's `/auth/callback` URL are different parts of the flow. Follow [Supabase's Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google) for current console steps.

## 5. Set application variables

Create `.env.local` in the project root for development, using the variable names below and the placeholder template in [README.md](./README.md). In Vercel, add the same variable names under Project Settings, Environment Variables, with values appropriate to each environment.

| Variable | Visibility | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project API origin |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Supabase publishable key; the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is also supported |
| `NEXT_PUBLIC_APP_URL` | Public | Application origin; HTTPS is required in production |
| `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH` | Public | `true` after Google is configured; otherwise `false` |
| `SUPABASE_SECRET_KEY` | Server only | Supabase secret key beginning `sb_secret_`; legacy `SUPABASE_SERVICE_ROLE_KEY` is supported as a fallback |
| `APP_ENCRYPTION_KEY` | Server only | Exactly 32 random bytes encoded as base64 |

Copy the public URL and publishable key from your Supabase project. Add its server secret key as `SUPABASE_SECRET_KEY` in Vercel and your local environment file. For projects using legacy API keys, use the `service_role` JWT as `SUPABASE_SERVICE_ROLE_KEY` instead. Do not use a publishable or `anon` key for server operations. The privileged client uses HTTPS and is isolated from browser and Auth-session clients; it must never be sent to the browser or included in responses.

Generate the encryption key once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the result as a server secret and retain it in a password manager. The encrypted provider key format is versioned AES-256-GCM. Changing `APP_ENCRYPTION_KEY` without re-encrypting existing values makes those saved provider keys unreadable; users would need to re-enter them. This is a separate secret from the Supabase API key.

Never put `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY`, or a provider key in a `NEXT_PUBLIC_*` variable. A Supabase server secret or legacy service-role key is required for the backend and remote import checks. Browser code must use only the publishable or legacy anon key.

Validate without printing values:

```sh
npm run check:env
npm run check:env -- --production
```

This validates formats and required fields. It does not prove that the keys belong to the intended project, the APIs are reachable, or the OAuth provider, SMTP service, and database migrations are correctly configured.

The pre-build guard also rejects a Supabase secret/service-role key placed in public configuration before it can be bundled. An environment-free build can render the setup screen; it is not a configured production deployment. Run the full production environment check with your intended production values, then complete the hosted smoke checks below.

## 6. Build and deploy

Use Node.js 22 and the committed lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

For local use:

```sh
npm run dev
```

For a local production run after building:

```sh
npm start
```

Push the source to your own Git repository and import it into Vercel. Select the **Next.js** framework preset, Node.js **22.x**, install command `npm ci`, and build command `npm run build`. Use the project's root directory and the default Next.js output settings. Add the environment variables before building, deploy, and make sure Supabase's Site URL and callback allowlist match the resulting domain.

Use Vercel Fluid Compute for the refresh route. It declares a 300-second maximum and bounds provider work below that duration. Refreshes run page by page from the UI; they are not background jobs or a scheduled scraper. See [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration) for the limits of your plan. Keep the Vercel function region close to the Supabase project when choosing deployment regions.

## 7. Create the first admin

Sign up and sign into the deployed application. This creates your `public.users` profile with `user_type = 'user'`.

In the Supabase SQL Editor, locate your **verified** profile:

```sql
select id, email, user_type
from public.users
where email = 'YOUR_VERIFIED_EMAIL';
```

Copy its exact UUID, then promote that account:

```sql
update public.users
set user_type = 'admin'
where id = 'YOUR_VERIFIED_USER_UUID';
```

Reload `/dashboard`; the admin link appears. `/admin` has People, Collections, and Pages sections with owner details. To revoke access, set the same row's `user_type` to `user`. The server checks the stored role on subsequent requests, and later sign-ins do not overwrite manual role changes. Never assign roles from editable Auth user metadata.

## 8. Check the real deployment

Use two separate accounts or browser profiles:

1. Signed out: the homepage and login work; `/dashboard` and `/admin` lead to login. `/api/account`, `/api/desk`, and `/api/admin` must reject anonymous requests.
2. Account A: create a collection, add pages, duplicate it, remove a page from the copy, and reload. Confirm the original remains intact.
3. Account B: confirm A's pages and collections are absent. A regular user must not open admin data or mutate another user's collection by guessing its ID.
4. Promote A using SQL: admin lists must show both registered people and the correct owners of their collections/pages. Returning to My workspace must still show only A's own records.
5. Add a small test provider key and refresh a real page. Confirm views and coverage, missing metrics, a failed refresh preserving prior data, and request-cap feedback. Provider charges may apply.
6. Hide columns and enter a manual metric. Reload and confirm the preferences and `*` marker persist in that browser. Export CSV and confirm manual flags are present.
7. Test phone layout, email confirmation, recovery, Google if enabled, and POST sign-out.

Automated checks validate application logic and database policies in the test environment. A hosted Supabase/Vercel smoke test is still needed with your real credentials and provider configuration.

## Data portability: import an existing workspace

### Move between Distribution Desk accounts

Apply the fifth migration above to enable **Import / export** in the dashboard. An existing installation with the original four migrations only needs `20261025000000_workspace_transfer.sql` for this release.

In the source account, download a JSON workspace backup. Sign in to the destination account, upload it under **Import backup**, preview the record counts and choose whether to keep existing values or use the backup's values for matching records. Both modes add missing memberships and retain unrelated destination data. Repeated imports use portable identities to prevent duplicate records, and native platform identities allow matching social-page aliases.

The authenticated `/api/transfer` endpoint binds every operation to the verified owner. The `desk_workspace_transfer` RPC and its private staging tables are accessible only to the backend service role. Uploads/downloads use 512 KB binary chunks to stay below hosting payload limits. Backups are capped at 100 MB, with a 98 MB server snapshot limit to leave room for browser preferences. Jobs expire after one hour; a subsequent transfer operation purges expired staging. Keep the Supabase database function timeout and Vercel function duration suitable for the workspaces you operate.

Imports validate counters, timestamps, profile URLs, snapshots, memberships and record caps. Preview writes only private staging data. Apply rechecks current limits and active refresh leases, then restores records in one transaction. A network retry of an already committed job returns its previous result. A failed apply rolls back all workspace changes. Transfer jobs are not intended as long-term backup storage: keep the downloaded JSON yourself.

Collections, social profiles, post snapshots, coverage, native platform identities, refresh timestamps and errors, and browser view preferences are portable. API keys, Auth accounts, roles and usage counters are excluded. Optional settings restoration copies provider choice and request/post limits; switching providers clears the previous social-provider key. Re-enter provider keys in the destination account. Manual values and saved selections are remapped and restored in the importing browser; if browser storage is blocked, database records still import and the UI reports the preference limitation.

### Import an older workspace export using the CLI

Old ChatGPT-hosted user IDs are not Supabase Auth UUIDs. Create each target Supabase account first, sign in once, and map every old owner to the correct verified `public.users.id`.

The importer accepts an authorized, sanitized JSON export of collections, pages, and memberships. It accepts database-style snake_case or workspace-style camelCase keys. Every record needs `owner` or `ownerId`; a single-user export can provide a top-level `owner` as a default. It does not fetch old data or log into another system for you.

Example export structure, with synthetic IDs:

```json
{
  "owner": "old-owner-id",
  "collections": [
    {"id":"22222222-2222-4222-8222-222222222222","name":"Example collection","createdAt":"2026-10-24T00:00:00Z"}
  ],
  "pages": [
    {"id":"33333333-3333-4333-8333-333333333333","platform":"instagram","handle":"examplepage","url":"https://www.instagram.com/examplepage/","name":"Example page","followers":null,"posts":[],"coverage":{},"overall":null}
  ],
  "memberships": [
    {"collectionId":"22222222-2222-4222-8222-222222222222","pageId":"33333333-3333-4333-8333-333333333333"}
  ]
}
```

Example `owner-map.json`:

```json
{"old-owner-id":"11111111-1111-4111-8111-111111111111"}
```

Use your actual target UUID, not the example. Review the export, keep it outside Git, and take a target database backup. Apply the legacy import migration and set the Supabase URL plus server secret through `.env.local`, then run:

```sh
# Validate JSON, ownership references, counters, URLs, and size limits only.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --validate-only

# Check target users, collisions, and final record limits through the Supabase API. No rows are written.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json

# Insert new rows in one transaction after reviewing the dry run.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --apply
```

The importer validates the files locally, then calls `desk_import_legacy(p_data jsonb, p_apply boolean default false)` using the Supabase JavaScript SDK. The named function runs as its caller and is executable only by `service_role`. A dry run takes the same per-owner locks and checks as an import but writes no rows; an applied import completes in one transaction.

The importer preserves collection and page IDs, cached posts, coverage, and last-refresh timestamps; it clears stale refresh locks. Existing rows are never overwritten. Conflicting IDs, another owner's records, or a handle already saved under a different page ID cause the transaction to fail. Repeating the same successful import is safe because existing matching records are skipped.

Accounts, roles, API keys, settings, usage, and browser preferences are not imported. Re-enter provider keys in the new application. Old ciphertext is tied to the old encryption key and is deliberately not reused. The importer also enforces the app's limit of 100 collections and 500 pages per target user.

## Operations and recovery

- Enable Supabase backups appropriate to your project and test restoring into a separate environment. Keep database migration files with each source release.
- Keep the encryption key stable and backed up separately from the source. If a provider key is exposed, revoke it at the provider and replace it in the app. Do not silently rotate the application encryption key over existing ciphertext.
- Preserve production environment variables when rolling back application code. A Vercel rollback does not undo a database migration; use forward-compatible migrations and review schema compatibility before rolling back.
- Use Vercel and Supabase logs to diagnose failures, but do not log provider keys, passwords, cookies, refresh tokens, or complete private exports. Server errors returned to users should not include database credentials or raw SQL.
- Review public Auth signup settings, rate limits, email delivery, and provider spend limits before inviting a larger audience. The app request cap counts provider attempts, not a guaranteed dollar budget.

## Troubleshooting

| Symptom | Check |
|---|---|
| Login shows setup instructions | Missing public Supabase URL/key or production app origin; set variables and rebuild |
| Callback fails or returns to the wrong domain | Supabase Site URL, exact callback allowlist, and `NEXT_PUBLIC_APP_URL` |
| Confirmation/recovery email never arrives | SMTP sender verification, provider logs, spam folder, Auth email limits, and templates |
| Backend Supabase API calls fail | Supabase project URL/status, server secret, API reachability, and server-only configuration |
| Missing relation, profile, or RPC errors | A required migration was not applied, or the deployment points to the wrong project |
| Admin access denied | Verify the signed-in account's UUID and stored `public.users.user_type`; reload after SQL change |
| Saved provider key cannot be read | `APP_ENCRYPTION_KEY` differs from the key used when the value was saved |
| Provider refresh fails | User key, provider balance/status, supported endpoint, and the app's request cap |

## Primary documentation

- [Supabase Next.js SSR setup](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)
- [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
- [Supabase database functions](https://supabase.com/docs/guides/database/functions)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Google authentication](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Vercel Next.js deployment](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)
