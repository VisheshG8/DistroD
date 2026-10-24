# Verification

Verified on 24 October 2026 using Node.js 22.21.1.

- Standard `npm run build` completed with Next.js 16.4.3.
- `npm test`: 67 tests passed, including real PostgreSQL-engine (PGlite) RLS/schema and API transaction tests.
- Production dependency audit: no known vulnerabilities reported at verification time.
- Standalone production server returned the homepage/login; protected pages redirect to login, APIs reject anonymous access, sign-out is POST-only.
- Public homepage and independent sign-in screen inspected in the browser.

The actual Supabase project, email/Google provider configuration, and Vercel deployment need your project settings. Real provider login, SMTP delivery, hosted database connectivity, and the final deployed application must be smoke-tested using DEPLOYMENT.md. Existing hosted records are not automatically transferred; the optional importer requires a complete export and an explicit old-owner-to-Supabase-user mapping.
