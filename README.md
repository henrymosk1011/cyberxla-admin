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
  -> plain-text alert email via Resend
```

No service-role key is used anywhere. The public (publishable) key has no
access to any table.

## Layout

| Path | What |
|---|---|
| `supabase/migrations/0001_init.sql` | Tables, row-level security, audit log, intake function and role |
| `supabase/functions/submit-quote/index.ts` | The public endpoint |
| `supabase/functions/submit-quote/lib.ts` | Validation and pricing (`CATALOG` must match the website) |
| `tests/` | Unit tests: `npm test` |
| `scripts/check-catalog.mjs` | `npm run check-catalog` fails if website prices and `CATALOG` disagree |

## One-time setup

1. **Run the migration.** Supabase > SQL Editor > New query, paste
   `supabase/migrations/0001_init.sql`, Run.
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
   | `RESEND_API_KEY` | Resend key (sending access, `notify.cyberx.la` only) |
   | `ALERT_EMAIL` | Inbox for new-quote alerts |
   | `INTAKE_DB_URL` | From step 4 |
   | `IP_HASH_SALT` | Any long random string (IPs are stored only as salted hashes) |
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
