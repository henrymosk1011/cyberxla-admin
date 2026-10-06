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
| `dashboard/` | The admin dashboard (Svelte + Vite, static site) |
| `supabase/functions/submit-quote/index.ts` | The public endpoint |
| `supabase/functions/submit-quote/lib.ts` | Validation and pricing (`CATALOG` must match the website) |
| `tests/` | Unit tests: `npm test` |
| `scripts/check-catalog.mjs` | `npm run check-catalog` fails if website prices and `CATALOG` disagree |

## One-time setup

1. **Run the migrations.** Supabase > SQL Editor > New query, paste
   `supabase/migrations/0001_init.sql`, Run. Then the same for
   `0002_realtime.sql`.
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

## Changing prices

Prices live in two places: the website's `build-your-quote/index.html` and
`CATALOG` in `lib.ts`. After changing either, run `npm run check-catalog`
(it reads the live site by default, or pass a local path to the HTML).

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
