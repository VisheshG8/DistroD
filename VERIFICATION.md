# Verification

## Admin directory update - 26 October 2026

Verified locally using Node.js 24.19.0:

- All **110 existing regression tests passed**, followed by **two new UI regression tests** after the final review. The admin tests cover owner-safe collection membership names, counter availability, valid zero values, credential redaction, revoked roles, browser-role restrictions, and data preservation when the new reporting migration is reapplied. The UI tests exercise navigation with an unnamed account and search changes before passive effects run, ensuring old rows never render under the new request.
- TypeScript validation passed after removing the temporary preview and its generated development types.
- The public-environment guard and production build (`next build --webpack`) passed, including compilation, TypeScript, static generation, and build traces. The generated route list contains no preview route. The default build command remains unchanged.
- Browser checks covered People-first navigation, 25-row pagination, person-to-collection-to-page navigation, retained owner breadcrumbs, collection links, partial metrics, zero versus unavailable values, and clearing search when switching sections. Mobile checks at 390 pixels covered first-column shortcuts and confirmed no document-wide horizontal overflow.
- The populated browser preview used synthetic data and intercepted admin requests locally. Its temporary route was removed; no real workspace records or account roles were changed.
- Sign-in and signup showed no admin option. Signed-out `/admin` redirected to login, and `/api/admin` and `/api/desk` returned HTTP 401.

Apply `20261026000000_admin_directory.sql` to the real Supabase project after the earlier migrations. It replaces only the admin reporting function and preserves existing data and stored roles. The migration has not been applied to a live project by these checks. Verify an actual database-designated admin and a normal user after deployment using DEPLOYMENT.md.

## Workspace transfer and UI release — 25 October 2026

Verified locally using Node.js 24.19.0:

- TypeScript validation completed without errors.
- The full Node.js regression suite passed: **107 tests, zero failures**.
- `next build --webpack` completed successfully, including compilation, TypeScript, static generation and build traces. The standard Turbopack build encountered a managed-Windows worker-spawn denial while processing CSS; the package's default build command was not changed.
- Browser checks covered the empty dashboard, populated metrics, collection navigation, 25-row pagination (25 rows followed by 7 in a 32-page fixture), backup dialog tabs, and phone-sized layouts. The populated fixture was isolated from live workspace requests and removed after verification.
- Transfer tests use the real Supabase SDK and all five migrations in PGlite. They cover complete snapshots, owner isolation, post/page ID remapping, repeated imports, keep/overwrite modes, native-ID alias matching, Unicode chunking, malformed uploads, forged Content-Length, active refresh leases, quota preservation, transactional rollback and browser-role restrictions. Preference tests verify manual values, column visibility and scope remapping.

Apply `20261025000000_workspace_transfer.sql` to the actual Supabase project before using `/api/transfer`. Existing installations must have the original four migrations first. The real hosted transfer flow still needs a smoke check after this migration is applied; database tests do not apply migrations to a live project.

## Earlier SDK baseline — 24 October 2026

Verified on 24 October 2026 using Node.js 22.21.1:

- Standard `npm run typecheck` completed without errors.
- Standard `npm test`: all 94 tests passed.
- Standard `npm run build` completed with Next.js 16.4.3.
- Production dependency audit reported zero known vulnerabilities.
- The built production server returned the homepage and login with HTTP 200. Protected dashboard/admin pages redirected to login; account, workspace, and admin APIs rejected anonymous access with HTTP 401. Refresh and sign-out remained POST-only.

The SDK regression tests use the real Supabase JavaScript client with a PostgreSQL-backed test transport. They verify request serialization and owner filters, account-role preservation, encrypted provider settings, pagination beyond 1,000 memberships, atomic request caps, refresh leases, alias merge/rollback, and duplicate-canonical-page races. SQL integration tests apply the actual migrations in PGlite and check browser grants, RLS, backend-only RPC execution, stored admin authorization, safe metric totals, and atomic legacy imports.

No direct PostgreSQL driver or connection string is used by the app or importer. Backend requests require the server-only Supabase secret key; encryption still requires the stable application encryption key.

The actual Supabase project and Vercel deployment were not connected during these checks. Real Supabase Data API access, email/Google login, SMTP delivery, provider requests, and the final hosted application still need the project-specific smoke checks in DEPLOYMENT.md. Local tests do not replace those hosted checks.

Existing hosted records are not automatically transferred. The CLI legacy importer requires a complete export and an explicit old-owner-to-Supabase-user mapping; it never imports roles or saved API keys. Current Distribution Desk accounts can use the dashboard workspace backup/import flow described in README.md after the fifth migration is applied.
