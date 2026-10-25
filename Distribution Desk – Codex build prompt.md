# Distribution Desk – Codex build prompt

Give this whole document to Codex as the task. It is self-contained. If a handoff repo with AGENTS.md, docs/ and prototype/ exists, read those too, but where they disagree, this document wins.

## Your task

Build and deploy v1 of Distribution Desk: a subscription web app for tracking the performance of Instagram, TikTok and YouTube pages. Users add a page by its handle and the app fetches its numbers automatically. Nobody needs to connect or log in to their own social account. Build it production-ready, with tests, deploy it to Vercel with Supabase as the backend, and report what is done and what needs keys or decisions from the owner.

## Stack

- Next.js (App Router, TypeScript, strict mode), Tailwind CSS.
- Supabase: Postgres, Auth (email magic link and Google), Row Level Security, pg\_cron or Supabase scheduled edge functions.
- Vercel for hosting, with Vercel Cron as an alternative scheduler.
- Payments: build behind a payment adapter (see below). Default to Razorpay subscriptions (India, UPI autopay); Stripe must be addable as a second adapter.
- Charts: Recharts or similar.

## Users, roles and plans

| Role | What they can do |
| --- | --- |
| Admin | Everything. Add or remove pages for any customer, assign pages to customers, manage customers, grant or revoke plans manually (free trials, clients), see data-provider spend and request counts, set a monthly request cap, choose the active data provider per platform. |
| Pro plan | Everything in View, plus add and remove their own pages, up to a page limit (default 25, configurable by admin). |
| View plan | See dashboards for pages the admin has assigned to them. Cannot add or remove pages. |
| Signed in, no active plan | Only the pricing and subscribe page. No data at all. |

Enforce access with Supabase Row Level Security, not only in the UI. A customer must never be able to read another customer's pages, even by calling the API directly. Write tests that prove this.

Plans are stored in the database (name, price, page limit, can\_add\_pages). Prices are placeholders until the owner decides; make them editable by admin.

## Provider-independent data layer (critical requirement)

The app must never call any data provider (HikerAPI, LamaTok, RapidAPI, TikHub, YouTube API, or any future one) directly from features, pages, jobs or calculations. All social data goes through one service layer.

- Define one TypeScript interface, for example `SocialDataProvider`, with methods such as `getProfile(platform, handle)` returning a standard profile (id, handle, name, avatar, followers, following, post count, is\_verified) and `getRecentPosts(platform, handle, since?)` returning standard posts (platform post id, url, type, caption, published\_at, duration, views, likes, comments, shares, saves where available, thumbnail).
- Each provider is one adapter file in `lib/providers/` (for example `hikerapi.ts`, `lamatok.ts`, `rapidapi-instagram.ts`, `youtube-official.ts`, `tikhub.ts`) that converts that provider's response into the standard format. Missing fields are null, never zero.
- A registry chooses the adapter per platform from configuration (database setting editable by admin, with env var defaults). Switching provider means changing that setting or adding one adapter file. Nothing else in the codebase changes.
- Support an ordered fallback list per platform: if the primary provider errors or times out, try the next one.
- The layer handles retries with backoff, timeouts, rate limiting, logging every request (provider, endpoint, success, latency, estimated cost) to a table, and the monthly request cap.
- Store raw responses briefly for debugging (for example 7 days), then delete them.
- Write adapter contract tests with recorded sample responses so a new adapter can be checked against the standard format.

Apply the same pattern to payments: a `PaymentProvider` interface with Razorpay and Stripe adapters.

## Default providers (all unverified vendor prices; test with free credits first)

| Platform | Default | Notes |
| --- | --- | --- |
| YouTube | Official YouTube Data API v3 with an API key | Free. Use channels.list for the uploads playlist, playlistItems.list and videos.list (1 quota unit each). Avoid search.list. |
| Instagram | HikerAPI | About $1 per 1,000 requests, prepaid, balance never expires, 100 free requests. |
| TikTok | LamaTok | About $1 per 1,000 requests, prepaid, 100 free requests. |
| Fallback | TikHub (TikTok, YouTube) or any RapidAPI listing | Implement at least one fallback adapter. |

The owner's budget is at most $25 a month. Target about 2 requests per Instagram or TikTok page per day. Fetch each unique handle once per refresh even if many customers track it.

What the data can and cannot give: public Instagram data has views (play count), likes, comments and followers. TikTok also shows shares and saves publicly. Instagram saves, reach and followers gained per reel are not available from any provider. Show such fields as not available, never as zero. Optional account linking through official APIs is out of scope for v1, but design the provider interface so an official adapter can be added later.

## Database (Supabase Postgres)

Minimum tables (adjust names as needed):

- `profiles`: user id, name, role (admin or customer).
- `plans` and `subscriptions`: plan, status, period start and end, payment provider ids.
- `tracked_accounts`: one row per unique social account (platform, handle, platform id, name, avatar, last fetched, fetch status, last error).
- `customer_pages`: links a customer to a tracked account, with their own fields: monthly pay, editor or responsible person, start date, active or inactive, notes. Admin can assign pages to any customer.
- `posts`: one row per post per tracked account (standard post fields).
- `post_snapshots`: daily snapshot of each post's counts for its first 30 days, then weekly up to 90 days.
- `account_snapshots`: daily snapshot of followers, following and post count per tracked account.
- `alerts`: generated alerts with level, type, details, page, created and resolved time.
- `provider_requests`: request log for cost and reliability.
- `settings`: active provider per platform, fallback order, request cap, refresh schedule.

RLS: customers can only read rows linked to their own `customer_pages`, and only when their subscription is active. Pro customers can insert and delete their own `customer_pages` up to the plan limit. Admin can do everything.

## History and growth tracking (critical requirement)

- Save follower count and post view counts every day for every tracked account, building a full history from the day the page is added. Past follower counts cannot be fetched, so follower history starts on the day a page is added; older posts and their views are imported on first fetch.
- Every screen supports a date range filter: Today, 7 days, 30 days, 90 days, This month, Last month, and Custom (any start and end date).
- Support comparing one date range with another (for example 1–15 September against 1–15 August), page by page and for all pages together.
- Show follower growth, views gained, posts published and engagement for any range, per page and in total.
- Monthly view: month-by-month table and chart for each page and for all pages.
- Be explicit about which view number is shown: views gained during the range (difference between snapshots) or views of posts published in the range. Default to views gained during the range and label it.

## Screens

1. Overview: top line saying how many pages need attention today; KPIs (active pages, total views, posts published, median views per post, engagement rate, total followers, follower growth, total monthly page pay, cost per 1M views); views chart; best page; best post; page health list.
2. Pages (page master): list of pages with platform, handle, link, editor, monthly pay, start date, data status, active status. Add page form: paste handle or URL, platform detected automatically, profile looked up and shown, then monthly pay, editor, active. Remove and edit. Only Admin and Pro can add or remove.
3. Page detail: followers over time, views over time, posts, median views, consistency chart (each post as a dot with median and average lines), health score with a breakdown of where each point comes from.
4. Page performance: all pages ranked side by side with health score, views, posts, median views, hit rate, engagement, shares (where available), follower growth, posts per day, monthly pay, cost per 1M views.
5. Posts (content tracker): every post with date, page, thumbnail, caption, type, views, likes, comments, shares and saves where available. Posts under 7 days old are marked maturing. Best lists: most viewed, most shared, most engaging, best against the page's own baseline. Worst against baseline.
6. Economics: pay against views chart, cost per post, cost per 1M views (main metric), views per ₹1,000 shown for reference. Pay is prorated to the selected date range.
7. Monthly report: this month against last month (pay, views, posts, cost per 1M views, median views, engagement, follower growth) and a verdict on whether more spend bought proportionally more views. Exportable as PDF or CSV.
8. Alerts: list grouped by red (act today), amber (watch), green (opportunity), each with a one-click next step. Optional daily email summary (WhatsApp later).
9. Admin: customers, plans and subscriptions, page assignments, provider settings and fallback order, request cap, provider spend and success rate, failed fetches.
10. Pricing and subscribe page for users without a plan.

The content library (matching the same source video across pages) is postponed to v2. Leave room for it in the schema (a nullable `source_asset_id` on posts).

## Metric rules (use exactly these)

- Use medians, not averages, for typical views, because viral posts distort averages. Show the average only as a secondary figure.
- Consistency: spread = interquartile range divided by median of views per post. Hit rate = share of posts reaching at least 0.7 times the page's 90-day median.
- Compare posts at a fixed age. Posts younger than 7 days are maturing and are excluded from medians, scores and alerts.
- Engagement rate = (likes + comments + shares) divided by views, using only fields the platform provides. Never compare engagement across platforms.
- Never pool views across platforms in rankings; rank within each platform.
- Viral post: views more than 5 times the page's 90-day median.
- Health score (0–100), each part a percentile rank across the customer's pages on the same platform: views trend against the page's own baseline 30%, median views per post 20%, engagement rate 15%, follower growth percentage 15%, consistency 10%, posting activity 10%. Pages with fewer than 8 matured posts show insufficient data instead of a score.
- Cost per 1M views = pay for the range divided by views in the range, times 1,000,000. Views per ₹1,000 is the inverse and is only a reference label.
- Alerts, using matured posts only and only when the condition persists across two checks:
  - Red: no post in 7 or more days.
  - Red: median views per post in the latest matured week below 0.7 times the week before.
  - Amber: posting frequency down to 60% or less of the previous week.
  - Amber: below the page's 30-day baseline by more than 25%.
  - Green: viral post detected.
  - Green: strong upward trend (more than 1.4 times baseline).
  - Data health: fetch failing, account private or not found.
  - Do not repeat the same alert for the same page within a few days.

The prototype file `prototype/metrics.js` implements most of these in JavaScript and can be used as a reference.

## Background jobs

- Daily refresh of every active tracked account: profile (followers) and recent posts, then post snapshots. Stagger requests.
- New page: immediate first fetch, including older posts.
- Daily alert generation after refresh, then optional email summary.
- Respect the monthly request cap: when near the cap, refresh less often instead of stopping.
- Show last updated time on every page and retry failed fetches.

## Design

- Product name: Distribution Desk (pending confirmation; keep it in one config value).
- Colours: ink #142231, paper #EFF2EE, signal yellow #F4C21B, up #0F7D5A, down #CC3F2B, watch #B87A00.
- Fonts: Bricolage Grotesque for headings, IBM Plex Sans for interface text.
- Look and layout: follow the prototype in `prototype/index.html` (dark left sidebar, numbered sections). Indian number formats and ₹ currency.
- Mobile-friendly for viewing.

## Security and quality

- All keys in environment variables, never in the repo or the browser. Provider calls only from the server.
- RLS on every table; tests proving isolation between customers and plan gating.
- Input validation on handles and URLs.
- Unit tests for metrics and alerts, adapter contract tests, and an end-to-end test of sign up, subscribe (test mode), add page, see data.
- Seed script with sample data so the app can be demonstrated without provider keys.
- README with setup, environment variables, how to add a new provider adapter, and how to deploy.

## Environment variables

- SUPABASE\_URL, SUPABASE\_ANON\_KEY, SUPABASE\_SERVICE\_ROLE\_KEY
- HIKERAPI\_KEY, LAMATOK\_KEY, YOUTUBE\_API\_KEY, plus keys for any fallback provider (for example RAPIDAPI\_KEY, TIKHUB\_KEY)
- RAZORPAY\_KEY\_ID, RAZORPAY\_KEY\_SECRET, RAZORPAY\_WEBHOOK\_SECRET (or Stripe equivalents)
- ADMIN\_EMAILS (comma-separated emails that become admin)

## Open decisions (use the defaults until the owner answers)

1. Razorpay or Stripe. Default: Razorpay, test mode.
2. Plan prices and Pro page limit. Default: placeholder prices, limit 25.
3. View customers see only pages the admin assigned to them. Default: yes.
4. Product name. Default: Distribution Desk.

## Build order

1. Project setup, Supabase schema, RLS, auth, roles.
2. Provider layer with YouTube official and HikerAPI adapters, then LamaTok and one fallback.
3. Page add and remove, first fetch, daily refresh, snapshots.
4. Metrics, scores and alerts with tests.
5. Screens, starting with Overview, Pages and Page detail.
6. Date ranges, comparisons and monthly report.
7. Payments and plan gating.
8. Admin panel.
9. Tests, seed data, README, deploy to Vercel.

When finished, report: the live URL, what works, what was tested, what is waiting for keys or decisions, and the estimated monthly data cost at 50, 150 and 300 pages.
