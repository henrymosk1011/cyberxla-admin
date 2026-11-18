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
| `supabase/migrations/0013_unifi.sql` | A client's UniFi console, and the log of UniFi software versions the reports have seen |
| `supabase/migrations/0014_unifi_status.sql` | Each client's latest UniFi status for the UniFi tab on a report |
| `supabase/migrations/0015_report_clear.sql` | Archiving finished reports (taking them off the Reports list; called Clear when it was added); test reports delete themselves after a week |
| `supabase/migrations/0016_report_delete.sql` | Deleting archived reports for good (a sent client report must be archived first) |
| `supabase/migrations/0017_report_copy.sql` | Send me a copy: the reports repo reads one report as it stands, without claiming it |
| `supabase/migrations/0018_workspace_services.sql` | Google Workspace migration: Essentials, Pro and Complete tiers, plus their add ons |
| `supabase/migrations/0019_proposals.sql` | Outgoing quotes ("Quotes" in the dashboard, `proposals` in the database): versions, timeline, acceptances, templates, payments, settings, and the public `proposal_view(token)` the quote page reads |
| `supabase/functions/_shared/proposal.ts` | The quote document format, its checks, the totals math (discounts, deposits), and placeholders, shared by the dashboard and the Edge Functions |
| `supabase/functions/quote-action/` | The dashboard's Send now, Resend, Send me a test, and the Payments page's status (emails through Resend) |
| `supabase/functions/_shared/emails.ts` | Every quote email (to clients and to you), shared with the dashboard's email preview |
| `supabase/migrations/0020_quote_flows.sql` | Accepting and Request changes from the quote page, the scheduler (Send later, follow ups, notices to you, expiry), and Stripe payments |
| `supabase/migrations/0021_quote_publish.sql` | Publish without emailing |
| `supabase/functions/quote-public/` | The quote page's Accept, Request changes and Pay buttons (Turnstile, rate limits, totals checked on the server, Stripe Checkout) |
| `supabase/functions/quote-cron/` | The scheduler's worker, woken by pg_cron: Send later, follow ups, emails to you, Stripe on or off |
| `supabase/functions/stripe-webhook/` | Stripe's payment events, signature checked, each applied once |
| `supabase/functions/_shared/stripe.ts`, `mail.ts` | Stripe (mode, Checkout Sessions, webhook signatures) and sending through Resend |
| `supabase/functions/report-action/` | The dashboard's Send now, Send me a copy and preview refresh for patch reports |
| `.github/workflows/keepalive.yml` | Pings the database every 6 hours so the free plan never pauses |
| `dashboard/` | The admin dashboard (Svelte + Vite, static site) |
| `supabase/functions/submit-quote/index.ts` | The public endpoint |
| `supabase/functions/submit-quote/lib.ts` | Validation and pricing (catalog passed in from the database) |
| `tests/` | Unit tests: `npm test` |
| `scripts/bundle-function.mjs` | `npm run bundle-function` writes `dist/submit-quote.ts` (`npm run bundle-report-action` writes `dist/report-action.ts`, and the same for `bundle-quote-action`, `bundle-quote-public`, `bundle-quote-cron`, `bundle-stripe-webhook`), one file to paste into the Supabase editor |

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
- The **internal PDF** follows the same edits: computers hidden or deleted
  here are left off it, renamed ones take the new name, and its counts and
  action items match (each computer carries its Action1 id for this).
- **Hold, Resume, Send now**, one at a time or Hold all and Resume all for the
  week. Send now shows exactly who it goes to first.
- **Send me a copy** emails you the report exactly as the client gets it (same
  email, same PDF), tagged with who it's for. It works in preview or live, before
  or after the report is sent, and never sends to the client or changes the
  report.
- **Preview mode** (the starting mode) sends every report to you, tagged with
  who it's for. Switch to **Live** in Reports, Settings.
- **Extra section** on any report, for one-off work like a router replaced:
  a title and items, only on that report, printed first on page 2.
- **Report template** (Reports, Template): the wording and order every new
  report starts from, including the What we did list. Saving it changes reports
  generated from then on; reports already made don't change. On a report,
  **Use this list for future reports** copies its What we did list into the
  template.
- Who gets a client's reports is set on the client's page (Reports card),
  along with computers to always leave off. A computer can also be marked to
  leave off future reports from any report; hiding or deleting one on a report
  only changes that report.
- A client's page can also name its UniFi console (the router's name as UniFi
  Site Manager shows it). The Sunday run then puts its UniFi equipment on the
  internal report. When any of its devices was updated that period, the
  client's report gets a Network section listing every device: the router
  first, then its UniFi Network app (the software on the router that runs the
  network), then access points. Updated ones say so; the others say No update
  needed (or No update this week when UniFi shows an update waiting for them),
  worded by the template's Network updates card.
  The UniFi key lives only in the private reports repo. A report's UniFi tab
  shows the router, its Network app and each access point, with the version,
  any update waiting and the last update seen; Check now asks the
  report-action Edge Function to start the reports repo's Check UniFi status
  workflow for that client (read only, about a minute).
- A report's page is split into tabs (Report text, Computers, Email, UniFi,
  History, Advanced) with the preview beside them; a dot marks a tab with
  unsaved edits.
- Test reports (from a manual run) never block the real Sunday report, never
  send on a schedule, and always go to you only.
- Archive takes a finished report (sent, failed, cancelled) or a test report
  off the Reports list; it's kept, under Archived, where Restore brings it
  back. Archive test reports does every test at once. Test reports delete
  themselves a week after they're made (each Sunday run calls
  reporting.purge_test_reports()). In the database this is still the
  `cleared_at` column (it was called Clear when it was added); only the
  wording in the dashboard changed.
- Under Archived, Delete (on a row, or Delete selected for ticked rows)
  removes reports for good, with their PDFs; the record in Activity stays. A
  sent client report can only be deleted once it's archived, and a report
  that is sending never can (enforced in the database too).

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

## Quotes

**Quotes** (in the menu under Sales) are the quotes you send. The website's
Build Your Quote submissions are **quote requests**, shown on each lead's page;
they're separate things (`public.quotes` in the database is the requests,
`public.proposals` is the quotes you send).

- **Numbers**: Q1001, Q1002, ... taken when a quote is created and never reused
  (a deleted quote's number stays unused).
- **Editor**: client and recipient, details, tiers (one tier makes a simple
  quote), comparison rows with a checkbox per tier (and optional text like
  "1 week"), add ons (can add, included, or not offered, per tier), discounts on
  any price or on the total (the page shows the old price struck through),
  deposit or full payment, fine print shown per tier or per add on, follow ups,
  and internal notes and costs (your margin per tier). It saves as you type.
  The preview beside it is the real quote page from cyberx.la, desktop or phone.
- **Placeholders** in any text: `{company}`, `{contact_first_name}`,
  `{quote_number}`, `{valid_until}`. They're filled in when a version is sent.
- **Catalog**: tiers, rows and add ons can come from the Services catalog with
  its price and description; editing them never changes the catalog unless you
  press Update catalog price.
- **Templates**: Save as template from any quote, start new quotes from one.
- **Sending**: Send shows the email first (Send me a test emails it to the
  Notify me address in Quotes, Settings), then sends now or later. Each send
  freezes a version; the client always sees the latest sent version at the same
  link. A sent quote is locked: Revise opens a new version, and the client keeps
  seeing the old one until you send it. Accepted quotes are locked the same way.
- **The client's page** is `https://cyberx.la/proposal/?k=<token>` (in the
  website repo). The token is 192 random bits; Make a new link replaces it and
  Turn off the link makes the page say "This quote isn't available". Views are
  counted once per half hour; your preview and View as client don't count.
- **Statuses**: draft, scheduled, sent, viewed, changes requested, accepted,
  declined, expired, revoked. Sending moves a lead to Proposal.
- **Accepting**: the client picks a tier and add ons, then Accept asks for their
  name, title, email, a typed signature and the terms checkbox (with a
  Cloudflare Turnstile check). The server recomputes every total from the
  version they saw and refuses one that doesn't match. The acceptance is a
  snapshot that can't be changed, the quote locks, the lead moves to Won and
  its value follows the accepted total. You get an email right away; the client
  gets a confirmation with what they accepted (and Pay when Stripe is
  connected, otherwise "We'll send you an invoice").
- **Request changes**: a short form on the quote page. The quote shows Changes
  requested and you get an email with their message. Revise and send again.
- **Emails to you** (to the Notify me address): first open, changes requested,
  accepted, payment received, and any email that didn't send. If one fails it's
  retried by the scheduler.
- **Follow ups** (per quote): a reminder if it isn't opened after a few days,
  and one a couple of days before it expires (the days are in Quotes,
  Settings). Reminders go out between 9 AM and 5 PM Pacific.
- **Convert to project** (on an accepted quote, or by hand on a sent one): makes
  a project named after the quote with a line per accepted item (net of any
  discount) and the scope in its notes, and can convert the lead to a client.
  The project shows "From quote Q1001" with what was accepted and whether it's
  paid; the Projects list has a Quote column; lead and client pages list their
  quotes; the Overview shows open quotes, sent this month, win rate, time to
  accept, payments, and recent quote activity.

### Setup for sending

Four Edge Functions, each with "Verify JWT" off (they check callers
themselves; `supabase/config.toml` says the same for the CLI):

| Function | Called by | Secrets it reads |
|---|---|---|
| `quote-action` | The dashboard (your login, checked with `is_admin()`) | `RESEND_API_KEY`, `STRIPE_*` (optional) |
| `quote-public` | The quote page on cyberx.la | `INTAKE_DB_URL`, `TURNSTILE_SECRET_KEY`, `IP_HASH_SALT`, `RESEND_API_KEY`, `STRIPE_*` (optional) |
| `quote-cron` | pg_cron, with a key kept in Vault | `INTAKE_DB_URL`, `RESEND_API_KEY`, `STRIPE_*` (optional) |
| `stripe-webhook` | Stripe, signed | `INTAKE_DB_URL`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` |

**Email has to be set up once** before quotes can be emailed (the
`RESEND_API_KEY` secret was never added, and `notify.cyberx.la` isn't in the
connected Resend account yet):

1. Resend, Domains, Add domain: `notify.cyberx.la`. Add the DNS records it
   shows in Cloudflare (DNS for cyberx.la, proxy off), then Verify.
2. Resend, API Keys, Create: name it `cyberxLA quotes`, Sending access, domain
   `notify.cyberx.la`. Copy the key.
3. Supabase, Edge Functions, Secrets: add `RESEND_API_KEY` with that key. It
   works right away. Quotes, Payments says "Quote emails: set up".

Until then, Send shows **Publish without emailing**: it freezes the version,
makes the link live and copies it, so you can send it yourself. Send later,
follow ups and the emails to you wait (nothing is lost; notices from the last
3 days go out once the key is there). Publish without emailing is also there
once email works, for quotes you'd rather send yourself.

The other secrets are the ones submit-quote already uses. To deploy one from the dashboard: `npm run bundle-quote-public` (or
`bundle-quote-action`, `bundle-quote-cron`, `bundle-stripe-webhook`), then paste
the file from `dist/` into an Edge Function of the same name. With the CLI:
`supabase functions deploy quote-public --project-ref <ref>`.

**The scheduler.** Migration 0020 turns on pg_cron and pg_net, stores a random
key in Vault (`quote_cron_key`), and schedules `quote-tick` every minute. Each
tick expires quotes past their date and calls `quote-cron` only when something
is due (a Send later, a notice to you) or at least once an hour (follow ups).
Quotes, Settings shows when it last ran. To check it in the SQL Editor:

```sql
select jobname, schedule, active from cron.job where jobname = 'quote-tick';
select cron_seen_at from public.quote_settings;
```

### Connect Stripe

Payments are built in and stay off until both Stripe secrets exist. Until then
the quote page and the emails say "We'll send you an invoice", Pay buttons
don't show, and the Payments page says Stripe not connected. Start in test
mode, then switch to live.

1. **Get the secret key.** In the Stripe Dashboard, turn on Test mode
   (top right), then Developers, API keys. Copy the **Secret key**
   (`sk_test_...`). A restricted key (`rk_test_...`) works too if it can write
   Checkout Sessions.
2. **Add the webhook.** Developers, Webhooks, Add endpoint:
   - Endpoint URL:
     `https://onpdkqzcgnoepwiqcgtv.supabase.co/functions/v1/stripe-webhook`
     (the Payments page shows it too)
   - Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `charge.refunded`
   - Save, then Reveal the **Signing secret** (`whsec_...`).
3. **Add both secrets.** Supabase, Edge Functions, Secrets:
   | Name | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | The key from step 1 |
   | `STRIPE_WEBHOOK_SECRET` | The signing secret from step 2 |

   Secrets apply to the functions right away; nothing needs redeploying.
4. **Check it.** In the admin, Quotes, Payments: it should say
   Connected (test mode). Press **Send test payment**: it opens a $1 Stripe
   Checkout. Pay with card `4242 4242 4242 4242`, any future date, any CVC and
   ZIP. The payment shows on the Payments page within a few seconds, marked
   Test. A real quote's payment also emails you.
5. **Turn a quote's payment on.** In a quote, under Payment at acceptance, pick
   Deposit (a percent or an amount) or Full. After the client accepts, the page
   and their confirmation email show Pay deposit or Pay now. The amount always
   comes from the server.
6. **Go live.** Turn off Test mode in Stripe and repeat steps 1 to 3 with the
   live key (`sk_live_...`) and a live webhook endpoint (same URL and events,
   its own `whsec_...`), replacing both secrets. Payments then says Connected
   (live). Test payments made before stay marked as tests.

To turn payments off again, delete `STRIPE_SECRET_KEY` in Supabase. Quotes
already accepted keep showing what's due, as an invoice.

