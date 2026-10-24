# Deploy Distribution Desk on Supabase and Vercel

This application uses standard Next.js, Supabase Auth, and Supabase PostgreSQL. The source includes the schema and deployment configuration. The hosting accounts, project credentials, Auth providers, and production email service must be configured in your own accounts.

## 1. Create the Supabase database

Create a fresh Supabase project, preferably in a region close to your expected users and Vercel function region. Keep its database password in a password manager.

Apply `supabase/migrations/20261024000000_init.sql` once using the Supabase SQL Editor. Alternatively, install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), link this directory to your project, and use its migration workflow:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Use one migration workflow consistently. Do not rerun the initial SQL against an already initialized database or edit an applied migration. Add a new migration for later schema changes. If using an existing project, review its current tables before applying this schema; `public.users`, `collections`, `pages`, `memberships`, `settings`, and `usage` are application-owned names.

The migration creates:

| Table | Purpose |
|---|---|
| `public.users` | Supabase Auth identity, contact details, and `user_type` |
| `public.collections` | Groups owned by a user |
| `public.pages` | Tracked social profiles and saved snapshots |
| `public.memberships` | Page-to-collection links with same-owner foreign keys |
| `public.settings` | Provider preferences, request cap, and encrypted keys |
| `public.usage` | Monthly provider request accounting |

Supabase Auth registration creates a normal user profile. Browser Data API access is read-only and protected by row-level security. Browser clients cannot read settings or usage, write counters, or promote themselves. Application writes use the server-only PostgreSQL connection and verify the authenticated owner or stored admin role.

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

Copy `.env.example` to `.env.local` for development. In Vercel, add the same variable names under **Project → Settings → Environment Variables**, with values appropriate to each environment.

| Variable | Visibility | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project API origin |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Supabase publishable key; the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is also supported |
| `NEXT_PUBLIC_APP_URL` | Public | Application origin; HTTPS is required in production |
| `NEXT_PUBLIC_ENABLE_GOOGLE_AUTH` | Public | `true` after Google is configured; otherwise `false` |
| `DATABASE_URL` | Server only | Supabase PostgreSQL transaction-pooler connection string |
| `APP_ENCRYPTION_KEY` | Server only | Exactly 32 random bytes encoded as base64 |

For `DATABASE_URL`, copy the **transaction pooler** URI from Supabase's Connect panel. It normally uses port `6543` and a username like `postgres.PROJECT_REF`. This avoids direct-connection IPv6 constraints and is suitable for serverless functions. URL-encode special characters in the password. Keep TLS enabled. The application's PostgreSQL client uses `prepare: false` and a small per-instance connection pool for transaction-pooler compatibility.

Generate the encryption key once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the result as a server secret and retain it in a password manager. The encrypted provider key format is versioned AES-256-GCM. Changing `APP_ENCRYPTION_KEY` without re-encrypting existing values makes those saved provider keys unreadable; users would need to re-enter them. It does not replace the Supabase database password.

Never put `DATABASE_URL`, `APP_ENCRYPTION_KEY`, a Supabase secret/service-role key, or a provider key in a `NEXT_PUBLIC_*` variable. A Supabase service-role key is not required by this application.

Validate without printing values:

```sh
npm run check:env
npm run check:env -- --production
```

This validates formats and required fields. It does not prove that a password, network route, OAuth provider, SMTP service, or database schema is correct.

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

Use your actual target UUID, not the example. Review the export, keep it outside Git, and take a target database backup. Set `DATABASE_URL` through `.env.local`, then run:

```sh
# Validate JSON, ownership references, counters, URLs, and size limits only.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --validate-only

# Connect to the target and check users, collisions, and final record limits. No rows are written.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json

# Insert new rows in one transaction after reviewing the dry run.
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --apply
```

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
| Database connection fails on Vercel | Transaction-pooler URI, encoded password, port 6543, TLS, and Supabase project status |
| Missing relation or profile errors | Initial migration was not applied, or the deployment points to the wrong project |
| Admin access denied | Verify the signed-in account's UUID and stored `public.users.user_type`; reload after SQL change |
| Saved provider key cannot be read | `APP_ENCRYPTION_KEY` differs from the key used when the value was saved |
| Provider refresh fails | User key, provider balance/status, supported endpoint, and the app's request cap |

## Primary documentation

- [Supabase Next.js SSR setup](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)
- [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Google authentication](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Vercel Next.js deployment](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)
