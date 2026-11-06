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
| `supabase/migrations/0009_projects.sql` | Projects for leads and clients, with services, notes, and browser-encrypted credentials |
| `supabase/migrations/0010_reports.sql` | Patch reports: drafts, PDFs, settings, the `report_writer` role and its functions |
| `supabase/migrations/0011_report_exclude.sql` | Computers to always leave off a client's patch reports |
| `supabase/migrations/0012_report_template.sql` | The report template every new patch report starts from |
| `supabase/functions/report-action/` | The dashboard's Send now and preview refresh for patch reports |
| `.github/workflows/keepalive.yml` | Pings the database every 6 hours so the free plan never pauses |
| `dashboard/` | The admin dashboard (Svelte + Vite, static site) |
| `supabase/functions/submit-quote/index.ts` | The public endpoint |
| `supabase/functions/submit-quote/lib.ts` | Validation and pricing (catalog passed in from the database) |
| `tests/` | Unit tests: `npm test` |
| `scripts/bundle-function.mjs` | `npm run bundle-function` writes `dist/submit-quote.ts` (`npm run bundle-report-action` writes `dist/report-action.ts`), one file to paste into the Supabase editor |

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

## Projects

The **Projects** page, and a Projects card on every lead and client, tracks
work for a lead or client: the services it would cover (from the catalog or
custom, price x quantity like client services), notes, a target date, a status
(Potential, Proposed, In progress, On hold, Done, Cancelled), and saved
credentials. A lead or client can have any number of projects. Converting a
lead moves its projects to the new client.

### Credentials are encrypted in the browser

- The first time you save a credential you set a **vault passphrase** (12+
  characters). It never leaves the browser and isn't stored anywhere.
- The passphrase derives a key (PBKDF2-SHA256, 600,000 iterations) that wraps
  a random AES-256 data key. Each credential's username, password, URL and
  notes are encrypted with that key (AES-GCM, bound to the credential and its
  project, padded so lengths don't show) before they're sent. The database
  holds only ciphertext, the salt, and the wrapped key; only the label is
  readable.
- The activity log records that a credential was added, changed or removed,
  never its contents.
- Unlocking lasts for the tab. It locks on Lock, sign-out, reload, or 10
  minutes without activity. Copied passwords are cleared from the clipboard
  after 30 seconds.
- Changing the passphrase re-wraps the data key; saved credentials don't
  change.
- **A forgotten passphrase can't be recovered**, by you, Supabase, or anyone
  with database access. "Forgot the passphrase?" deletes every saved
  credential so you can start over. Keep the passphrase in your password
  manager.
- This protects credentials from a leaked database, backup, or Supabase
  account. It can't protect them from someone who controls the dashboard's
  code or your browser while the vault is unlocked; the strict
  Content-Security-Policy is the defense there.
- Project notes are not encrypted (like lead and client notes). Keep secrets
  in Credentials.

## Patch reports

Weekly and monthly Action1 patch reports for clients are built in the private
reports repo (GitHub Actions) and reviewed here, under **Reports**.

```
Sunday, generate time    GitHub Actions makes a draft per client (as report_writer)
Sunday afternoon         you review and edit here; each save rebuilds the PDF
Monday, send time        every report still scheduled goes out; held ones don't
```

- **Every word is editable**: the email (recipients, subject, body) and every
  line of the PDF, plus raw JSON for anything else. Reset to generated undoes
  it all. The preview is images of the real PDF and refreshes about a minute
  after a save. **Rebuild PDF** builds it again with no changes, for example
  after a layout change in the reports repo.
- **Hold, Resume, Send now**, one at a time or Hold all and Resume all for the
  week. Send now shows exactly who it goes to first.
- **Preview mode** (the starting mode) sends every report to you, tagged with
  who it's for. Switch to **Live** in Reports, Settings.
- **Report template** (Reports, Template): the wording and order every new
  report starts from, including the What we did list. Saving it changes reports
  generated from then on; reports already made don't change. On a report,
  **Use this list for future reports** copies its What we did list into the
  template.
- Who gets a client's reports is set on the client's page (Patch reports card),
  along with computers to always leave off. A computer can also be marked to
  leave off future reports from any report; hiding or deleting one on a report
  only changes that report.
- Test reports (from a manual run) never block the real Sunday report, never
  send on a schedule, and always go to you only.

How it's kept safe:

- GitHub Actions logs in as `report_writer`, which can only call the functions
  in the `reporting` schema (the API never exposes it), like `quote_intake`.
  Recipients always come from the client record, never from the caller.
- A report is claimed (scheduled to sending) in one database step before it is
  sent, so the Monday run and Send now can't send it twice. A report that is
  sending or sent can't be edited, and sent reports can't be deleted. The
  database enforces these rules, not just the dashboard.
- The activity log records every change to reports and settings, without the
  large generated columns.
- The `report-action` function checks your session with `is_admin()` (allowlist
  plus MFA) and starts the GitHub workflow with a token that can only run
  Actions on the reports repo.

### Setup

1. **Run the migration.** Paste `supabase/migrations/0010_reports.sql` into the
   SQL Editor and Run.
2. **Set the writer's password.** Generate a long random password (letters and
   numbers only), then:
   ```sql
   alter role report_writer password 'PASTE-PASSWORD-HERE';
   ```
3. **Give the reports repo its database access.** In the reports repo,
   Settings, Secrets and variables, Actions:
   - Secret `REPORTS_DB_URL`: the Transaction pooler URI (Supabase > Connect),
     with `postgres.<ref>` replaced by `report_writer.<ref>` and the password
     from step 2.
   - Variable `REPORTS_DB_CA`: Supabase > Database > Settings > SSL
     Configuration > Download certificate, then paste the whole file. The
     connection is always verified against it.
4. **Make a GitHub token for the dashboard's buttons.** github.com, Settings,
   Developer settings, Fine-grained tokens, Generate: repository access **only
   the reports repo**, permission **Actions: Read and write**, nothing else, an
   expiry of a year at most (put the renewal in your calendar).
5. **Deploy `report-action`.** `npm run bundle-report-action`, then
   Supabase > Edge Functions > Deploy a new function > Via editor, name it
   `report-action`, paste `dist/report-action.ts`, deploy, and turn **off**
   "Verify JWT" in its settings (the function checks the session itself, with
   `is_admin()`). Secrets:
   | Name | Value |
   |---|---|
   | `GH_ACTIONS_TOKEN` | The token from step 4 |
   | `REPORTS_REPO` | The reports repo as `owner/name` |
   | `PUBLISHABLE_KEY` | Only if the function says it's missing: the dashboard's `VITE_SUPABASE_PUBLISHABLE_KEY` |
6. **Turn reports on per client.** Open each client, fill in the Patch reports
   card (Action1 group exactly as in Action1, recipients, cc), check "Send
   weekly and monthly reports", and Save.
7. **Test in preview.** In the reports repo, Actions, Generate reports, Run
   workflow (Test reports checked). Drafts appear under Reports, Test reports,
   in a few minutes. Edit one, Save, watch the preview refresh, then Send now:
   it arrives in your inbox. Hold another and check it stays put.
8. **Go live** before the Monday you want clients to get them: Reports,
   Settings, Live.

## Activity log

Every change to leads, quotes, notes, clients, projects and patch reports is written to `audit_log` by a
database trigger and can't be edited or deleted, even by the admin. "Remove
from timeline" in the dashboard only hides an entry (`activity_hidden`); the
original record stays, and "Show removed" brings it back.
