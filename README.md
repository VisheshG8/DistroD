# Distribution Desk

A standalone Next.js application for grouping Instagram, YouTube, and TikTok pages and comparing their public performance. Vercel hosts the application; Supabase provides Auth and PostgreSQL. It runs without ChatGPT hosting, Cloudflare Workers, or a separate server.

## What is included

- Public homepage, Google sign-in when enabled, and email/password registration, sign-in, confirmation, and password recovery.
- Private workspaces with collections, bulk page entry, duplication, page removal, CSV export, and manual refreshes.
- Recent-post and publication-date selections, coverage labels, and separate lifetime profile totals where available.
- Selectable table columns and manual metric overrides marked with `*`. These preferences are saved per account in the browser.
- A database-controlled admin area with People, Collections, and Pages, including owner details.
- Supabase schema, read-only browser RLS policies, encrypted provider keys, atomic request accounting, and refresh locks.

## Deploy

Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for the exact Supabase and Vercel setup, Auth redirect URLs, environment variables, and first-admin instructions. You need your own Supabase and Vercel projects; this source package does not contain project credentials or a preconfigured live deployment.

The short sequence is:

1. Create a Supabase project and apply `supabase/migrations/20261024000000_init.sql`.
2. Configure Auth URLs and email delivery; enable Google if required.
3. Copy `.env.example` to `.env.local` and fill in your project values.
4. Run `npm ci`, `npm run check:env`, `npm run typecheck`, `npm test`, and `npm run build`.
5. Import the repository into Vercel, set the same environment variables, and deploy with the Next.js preset and Node.js 22.
6. Sign in and promote your own verified account to `admin` using the Supabase SQL Editor.

## Local development

```sh
npm ci
npm run check:env
npm run dev
```

Open `http://localhost:3000`. Use a separate development Supabase project, or configure the supplied Supabase CLI project for a local stack. The Auth redirect allowlist must include the local callback URL.

## Data sources

Users enter their own TikHub or ScrapeCreators key in API settings. The official YouTube Data API v3 is supported through an optional YouTube key. Keys are encrypted before storage and never included in CSV or admin responses. Provider billing and API availability are separate from application hosting.

A date range selects **when posts were published**. Counts are their current lifetime counters, as of the last successful refresh; they are not views gained during that range. Missing counters remain unavailable, and partial coverage is labelled. A page's cached data is reused across its collections.

## Accounts and access

- `/` and `/login` are public.
- `/dashboard` contains only the signed-in user's workspace.
- `/admin` and `/api/admin` require a stored `public.users.user_type = 'admin'` role.
- Every new account starts as `user`; mutable Auth metadata cannot grant admin access.
- Database roles are changed through a privileged SQL connection. There is no public role-assignment endpoint.

## Import existing records

The optional [legacy import script](./scripts/import-legacy.mjs) maps old owner IDs to existing Supabase Auth user IDs, preserves collection/page IDs and cached snapshots, and inserts in one transaction. It does not transfer accounts, roles, provider keys, settings, usage, or browser preferences. See the data-portability section of [DEPLOYMENT.md](./DEPLOYMENT.md).

```sh
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --validate-only
npm run import:legacy -- --file workspace-export.json --owners owner-map.json
npm run import:legacy -- --file workspace-export.json --owners owner-map.json --apply
```

The second command is a database dry run. Only `--apply` writes records. Existing records are not overwritten.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local Next.js development server |
| `npm run build` | Production Next.js build |
| `npm start` | Run a built application |
| `npm run typecheck` | TypeScript validation |
| `npm test` | Application and database regression tests |
| `npm run check:env -- --production` | Validate production variable formats without printing secrets |
| `npm run import:legacy -- --help` | Import usage and safety behavior |

## Project map

- `app/`: public pages, authenticated workspace, admin UI, Auth callbacks, and API routes.
- `lib/`: verified identity, server database access, encryption, metric normalization, and provider adapters.
- `supabase/migrations/`: versioned PostgreSQL schema and access policies.
- `supabase/tests/` and `tests/`: database and application checks.
- `scripts/`: environment validation and optional data import.

Do not commit `.env.local`, database connection strings, or API keys. Keep the encryption key stable across deployments so saved provider keys remain readable.
