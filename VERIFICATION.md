# Verification

Verified on 24 October 2026 using Node.js 22.21.1:

- Standard `npm run typecheck` completed without errors.
- Standard `npm test`: all 94 tests passed.
- Standard `npm run build` completed with Next.js 16.4.3.
- Production dependency audit reported zero known vulnerabilities.
- The built production server returned the homepage and login with HTTP 200. Protected dashboard/admin pages redirected to login; account, workspace, and admin APIs rejected anonymous access with HTTP 401. Refresh and sign-out remained POST-only.

The SDK regression tests use the real Supabase JavaScript client with a PostgreSQL-backed test transport. They verify request serialization and owner filters, account-role preservation, encrypted provider settings, pagination beyond 1,000 memberships, atomic request caps, refresh leases, alias merge/rollback, and duplicate-canonical-page races. SQL integration tests apply the actual migrations in PGlite and check browser grants, RLS, backend-only RPC execution, stored admin authorization, safe metric totals, and atomic legacy imports.

No direct PostgreSQL driver or connection string is used by the app or importer. Backend requests require the server-only Supabase secret key; encryption still requires the stable application encryption key.

The actual Supabase project and Vercel deployment were not connected during these checks. Real Supabase Data API access, email/Google login, SMTP delivery, provider requests, and the final hosted application still need the project-specific smoke checks in DEPLOYMENT.md. Local tests do not replace those hosted checks.

Existing hosted records are not automatically transferred. The optional importer requires a complete export and an explicit old-owner-to-Supabase-user mapping; it never imports roles or saved API keys.
