-- Web accessibility services. The homepage's Audit, Starter fix and Business
-- fix cards link to the quote builder with ?service=ada-audit / ada-starter /
-- ada-business, so these ids need to exist in the live catalog (the builder
-- rebuilds its cards from it, and submit-quote only accepts catalog ids).
-- Safe to run more than once.

begin;

insert into public.service_categories (id, name, blurb, sort) values
  ('accessibility', 'Web accessibility', 'Make your existing website usable for everyone, and harder to sue.', 60)
on conflict (id) do nothing;

insert into public.services (id, category_id, name, description, price, unit, price_from, in_packages, locked, sort) values
  ('ada-audit', 'accessibility', 'Accessibility Audit', 'We check your site for ADA problems and send a plain English list and a fixed price quote. Free, no obligation.', 0, 'once', false, false, false, 0),
  ('ada-starter', 'accessibility', 'Accessibility Fix, Starter', 'Real code fixes for sites up to 10 pages, with a WCAG 2.1 AA conformance report.', 999, 'once', false, false, false, 10),
  ('ada-business', 'accessibility', 'Accessibility Fix, Business', 'Code fixes for sites with 11 to 30 pages, including templates, blogs, and popups.', 3500, 'once', false, false, false, 20),
  ('ada-monitor', 'accessibility', 'Accessibility Monitoring', 'Monthly scans so new pages and posts stay accessible.', 99, 'mo', false, false, false, 30)
on conflict (id) do nothing;

commit;
