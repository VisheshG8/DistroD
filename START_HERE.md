# Start here

Distribution Desk V2 is in `P:\VI\distribution-desk`.

## Try the interface

Use Node.js 22.x, then run:

```powershell
Set-Location 'P:\VI\distribution-desk'
npm ci
npm run dev
```

Open `http://localhost:3000/demo` for the synthetic demo. It does not fetch paid data or change customer records.

For an optional developer JSON fixture: `node scripts/seed-demo.mjs --output ./demo-data.json`. This writes synthetic analytics data, not a workspace backup or production database seed; the demo does not require this step.

## Set up real accounts

1. For a **new installation**, copy `.env.example` to `.env.local` and fill in the Supabase public/server keys, application origin, and stable encryption key. For an **existing installation**, keep your current `.env.local` and keys; add only missing values from the example. Do not replace or regenerate the encryption key.
2. Apply missing SQL migrations from [DEPLOYMENT.md](./DEPLOYMENT.md), in order, once. **If the first six migrations are already applied, only three new files are needed:** `20261026010000_analytics_history.sql`, `20261026015000_analytics_operations.sql`, and `20261026020000_analytics_transfer.sql`. A fresh database needs all nine.
3. Configure Supabase email and callback URLs. Run `npm run check:env`, then sign up at `/login`.
4. Open `/dashboard` for analytics or `/collections` for collections, bulk entry, and backups.
5. To make your own verified account an admin, change `public.users.user_type` to `admin` for its exact UUID in Supabase. The SQL example is in [DEPLOYMENT.md](./DEPLOYMENT.md). No login or registration option grants admin access.
6. Set server provider keys and review `/admin/providers`. Test one small refresh before enabling automatic refresh.

Scheduled refresh starts **paused**. The configured hourly Vercel cron needs a plan supporting hourly jobs and a `CRON_SECRET` of at least 32 characters. Set actual provider rates before enabling it; the shared estimated budget defaults to $25/month.

## What to expect

- Users see their own data. Admins can see people, collections, pages, and provider operations.
- Page pay is a reporting field. There are no payments, plans, pricing pages, or View accounts.
- New tracking builds real history over time. It cannot recover past follower counts. Typical performance needs observations at post age 7–8 days; health scores need eight comparable matured posts.
- **Import / export** under `/collections` moves a complete workspace, including V2 metadata, saved posts, history, and alerts. Keys and account roles stay out of backups.

See [README.md](./README.md) for features and cost examples, [DEPLOYMENT.md](./DEPLOYMENT.md) for setup, and [VERIFICATION.md](./VERIFICATION.md) for tested behavior and remaining hosted checks. No production migration or deployment has been performed by the local build work.
