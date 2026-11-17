-- Google Workspace migration: three fixed price tiers and the add ons that can
-- be put on the two lower tiers (Complete already includes them). The website's
-- Build Your Quote page and the quote function read these from the catalog.
-- Safe to run more than once.

begin;

insert into public.service_categories (id, name, blurb, sort) values
  ('workspace', 'Google Workspace', 'Move your office onto Google Workspace with sign ins, email, and files locked down from day one. Google licenses are billed separately.', 70)
on conflict (id) do nothing;

insert into public.services (id, category_id, name, description, price, unit, price_from, in_packages, locked, sort) values
  ('workspace-essentials', 'workspace', 'Workspace Migration, Essentials', 'Accounts, email and file migration, domain cutover, MFA, Drive on every PC, SPF, DKIM, and DMARC, backup moved over, staff training, and a written runbook. One week of support after cutover.', 4200, 'once', false, false, false, 0),
  ('workspace-pro', 'workspace', 'Workspace Migration, Pro', 'Everything in Essentials, plus files split into separate shared drives with their own permissions, DMARC enforced to block spoofing, a tested backup restore with failure alerts, and two weeks of support after cutover.', 5500, 'once', false, false, false, 10),
  ('workspace-complete', 'workspace', 'Workspace Migration, Complete', 'Everything in Pro on Business Plus, plus Vault retention and legal holds, USB security keys, Windows sign in with Workspace accounts, phone policies, IT policies, and 30 days of support after cutover.', 8400, 'once', false, false, false, 20),
  ('workspace-usb-keys', 'workspace', 'USB Security Keys', 'Physical security keys set up for up to 3 people, the strongest protection against phishing. Keys billed at cost.', 400, 'once', false, false, false, 30),
  ('workspace-windows-logins', 'workspace', 'Windows Synced User Logins', 'Each person signs into their PC with their Workspace account and MFA, so one login covers everything and offboarding is one step.', 750, 'once', false, false, false, 40),
  ('workspace-phone-policies', 'workspace', 'Phone Policies', 'A screen lock required and remote wipe ready on every phone that has company email.', 400, 'once', false, false, false, 50),
  ('workspace-basic-policies', 'workspace', 'Basic IT Policies', 'Short written policies for acceptable use, passwords and MFA, and onboarding and offboarding staff.', 750, 'once', false, false, false, 60),
  ('workspace-hypercare', 'workspace', 'Extended Hypercare, 30 Days', 'Support after cutover extended to 30 days, with fixes at no extra charge.', 500, 'once', false, false, false, 70)
on conflict (id) do nothing;

commit;
