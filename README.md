# cyberxla-admin

Private back end and admin dashboard for cyberx.la: quote intake, leads, and
pipeline.

## How a quote gets in

```
cyberx.la quote builder
  -> submit-quote Edge Function   (origin check, Turnstile, validation,
                                   server-side pricing, rate limit)
  -> intake.submit_quote()        (called as the quote_intake role, which can
                                   do nothing else)
  -> leads / quotes tables        (readable only by an allowlisted admin whose
                                   session completed MFA)
  -> plain-text alert email via Resend (optional)
  -> dashboard (admin.cyberx.la), live via Supabase Realtime
```

No service-role key is used anywhere. The public (publishable) key has no
access to any table.

## Layout

| Path | What |
|---|---|
| `supabase/migrations/0001_init.sql` | Tables, row-level security, audit log, intake function and role |
| `supabase/migrations/0002_realtime.sql` | Live updates for leads and quotes |
| `supabase/migrations/0003_archive_activity_keepalive.sql` | Archive/delete for leads and quotes, hideable activity entries, keep-alive heartbeat |
| `supabase/migrations/0004_quote_edits.sql` | Lead value follows edits to a quote's services and device counts |
| `supabase/migrations/0005_catalog_and_clients.sql` | Services catalog (managed in the dashboard, read live by the website and the quote function) and clients |
| `.github/workflows/keepalive.yml` | Pings the database every 6 hours so the free plan never pauses |
| `dashboard/` | The admin dashboard (Svelte + Vite, static site) |
| `supabase/functions/submit-quote/index.ts` | The public endpoint |
| `supabase/functions/submit-quote/lib.ts` | Validation and pricing (catalog passed in from the database) |
| `tests/` | Unit tests: `npm test` |
| `scripts/bundle-function.mjs` | `npm run bundle-function` writes `dist/submit-quote.ts`, one file to paste into the Supabase editor |

## One-time setup

1. **Run the migrations.** Supabase > SQL Editor > New query, paste each file
   in `supabase/migrations/` in order (0001, 0002, 0003, ...) and Run.
2. **Make yourself the admin.** In the SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'YOUR-ADMIN-LOGIN-EMAIL';
   ```
3. **Set the intake role's password.** Generate a long random password in your
   password manager (letters and numbers only, so it needs no URL escaping),
   then run:
   ```sql
   alter role quote_intake password 'PASTE-PASSWORD-HERE';
   ```
4. **Build the connection string.** Supabase > Connect > Transaction pooler
   shows a URI like
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres`.
   Replace `postgres.<ref>` with `quote_intake.<ref>` and the password with the
   one from step 3. That full string is the `INTAKE_DB_URL` secret.
5. **Add secrets.** Supabase > Edge Functions > Secrets:
   | Name | Value |
   |---|---|
   | `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key |
   | `INTAKE_DB_URL` | From step 4 |
   | `IP_HASH_SALT` | Any long random string (IPs are stored only as salted hashes) |
   | `RESEND_API_KEY` | Optional. Resend key (sending access, `notify.cyberx.la` only) |
   | `ALERT_EMAIL` | Optional. Inbox for new-quote alerts |
6. **Deploy the function.** Either
   - Dashboard: Edge Functions > Deploy a new function > Via editor, name it
     `submit-quote`, add `index.ts` and `lib.ts` with these files' contents,
     deploy, then in the function's settings turn **off** "Verify JWT"; or
   - CLI: `supabase functions deploy submit-quote --project-ref <ref>`
     (reads `supabase/config.toml`, which already turns JWT verification off).

## Services and prices

Services, categories and prices live in the database and are edited on the
dashboard's **Services** page. The website's Build Your Quote page loads them
live (`public.service_catalog()`), falling back to the cards built into the
page if the database is slow or down, and the quote function prices every
submission from the same catalog. Patching, EDR and 24/7 MDR are used by the
homepage packages, so they can be edited but not deleted or hidden.

To redeploy the quote function after changing its code: `npm run
bundle-function`, then paste `dist/submit-quote.ts` into Supabase > Edge
Functions > submit-quote > Code and deploy.

## Dashboard

```
cd dashboard
npm ci
npm run demo      # sample data, no back end needed: http://localhost:5173
npm run check     # type check
npm test          # unit tests for the chart math
```

Sign-in is email + password, then an authenticator-app code (set up on first
sign-in). Sessions end when the tab closes or after 30 minutes idle.

### Deploy (Cloudflare Pages)

1. Cloudflare > Workers & Pages > Create > Pages > Connect to Git, pick
   `cyberxla-admin`.
2. Build settings: root directory `dashboard`, build command
   `npm ci && npm run build`, output directory `dist`.
   Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
   (both public), `NODE_VERSION` = `22`.
3. Custom domains > add `admin.cyberx.la`.

The build writes `dist/_headers`: a strict Content-Security-Policy that only
allows this site and your Supabase project, plus HSTS, no framing, no
referrer, no indexing, and no caching of the app shell.

### Lock it with Cloudflare Access

Zero Trust > Access controls > Applications > Add > Self-hosted:

- Name `cyberXLA Admin`, session duration 4 hours.
- Hostnames: `admin.cyberx.la`, and the Pages hostnames
  `<project>.pages.dev` and `*.<project>.pages.dev` so the default and preview
  URLs are covered too.
- Login methods: **GitHub only** (turn off One-time PIN), instant auth on.
- Policy: Action **Allow**, Include > Emails > your GitHub email.

### Supabase Auth settings

- Authentication > URL Configuration: Site URL `https://admin.cyberx.la`.
- Authentication > Sign In / Providers: "Allow new users to sign up" **off**.
- MFA (TOTP) stays enabled (the default).

## Activity log

Every change to leads, quotes and notes is written to `audit_log` by a
database trigger and can't be edited or deleted, even by the admin. "Remove
from timeline" in the dashboard only hides an entry (`activity_hidden`); the
original record stays, and "Show removed" brings it back.
