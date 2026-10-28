# Deployment notes

These notes are from when the app was running in production. It has since been retired, and the automatic deploy workflow has been removed.

## Background

The code started as a shared, multi-club codebase (Epping and a second product,
Flinther). It was then cut down to a single-club app for Epping Table Tennis Club.

## What changed

1. **Security fixes** (ported from the Flinther repo, which had them and this
   repo did not):
   - `GET /api/members/:id` only shows email and phone to admins and to the
     member themselves.
   - Stripe capture/void checks the payment belongs to this club.
   - Product images can no longer be read outside the uploads folder.
   - Register and password reset are rate-limited; passwords need 8+ characters.
   - `helmet` security headers and a general API rate limit.
   - The server refuses to start in production without `JWT_SECRET` and
     `SESSION_SECRET`.
   - Errors no longer send raw database, Stripe or API messages to the browser.
2. **Single club**: every request uses the club whose subdomain is
   `CLUB_SUBDOMAIN` (default `epping`). Subdomain detection, the
   `X-Club-Subdomain` header and `?club=` are gone.
3. **Removed** (Flinther-only): super-admin, Stripe subscription billing,
   platform signup/login and email verification, club self-registration,
   cross-domain SSO, coach invite links, settings-conflict check,
   `PUT /courts/count`, coach-summary report, public daily and coach schedules,
   platform feedback, and the Landing/Onboarding/PlatformDashboard pages.
4. **Repo cleanup**: unused root files and another club's images removed;
   new uploads under `server/uploads/` are ignored by git.

The `club_id` columns stay in the database as a fixed value. Nothing else in
the database changes.

## Server environment (`server/.env`)

| Variable | Notes |
| --- | --- |
| `JWT_SECRET`, `SESSION_SECRET` | Required in production (server exits without them). |
| `CLUB_SUBDOMAIN` | `epping` (the default). Must match `clubs.subdomain`. |
| `FRONTEND_URL` | `https://eppingtabletennis.com.au` |
| `CORS_ORIGINS` | Optional, comma-separated extra origins (e.g. a Cloudflare Pages preview URL). `flinther.com`, `*.vercel.app` and `*.pages.dev` are no longer allowed by default. |
| `EMAIL_FROM` | Must be on a domain verified in Resend. The default is now `noreply@eppingtabletennis.com.au`, not flinther.com. |

The frontend no longer reads `VITE_CLUB_SUBDOMAIN`; only `VITE_API_URL` is needed.

## Before deploying: protect uploaded files

`server/uploads/products/` already has 34 committed images. They stay tracked
in the repo, so a normal `git pull` on the server is safe. If you later want
them out of git, first copy the folder somewhere safe on the server, then
`git rm -r --cached server/uploads`, commit and pull, then copy them back.

## Deploy

On the EC2 server, `git pull` then `npm install` in `server/` (new dependency:
`helmet`), then `pm2 restart tt-api`. While the app was live, a GitHub Actions
workflow ran these steps on every push to `main`.

## Remove the other clubs' data (optional)

`server/scripts/remove-other-clubs.sql` deletes every club except Epping,
their data, and Flinther platform-owner accounts. It ends in `ROLLBACK`, so
the first run only reports what it would delete.

```bash
pg_dump "$DATABASE_URL" > backup-before-cleanup.sql      # 1. back up
psql "$DATABASE_URL" -f server/scripts/remove-other-clubs.sql   # 2. dry run
# 3. if the output looks right: change ROLLBACK to COMMIT at the bottom, run again
```

## Retire Flinther

1. **Archive the Flinther repo** on GitHub: Settings → General → Danger Zone →
   Archive this repository. Its deploy workflow logs into the same EC2 folder
   and pulls and restarts the Epping API whenever Flinther gets a push;
   archiving stops that.
2. **Take down flinther.com**: delete or pause the Flinther project in
   Cloudflare Pages, and remove the DNS records if you are not keeping the domain.
