# cyberxla-admin

The admin dashboard for cyberx.la (admin.cyberx.la, Svelte, built by Cloudflare Pages from `main`) and its Supabase back end (migrations, Edge Functions). See README.md for how it fits together.

## How the owner wants changes shipped

- When the owner asks for a change, ship it live without asking first: make the change, check it, open a pull request into `main`, merge it, then confirm the new version is live (the Cloudflare Pages production deployment for the merge commit succeeded). Don't stop for a go-ahead or a preview.
- Supabase changes don't deploy from `main`. When a change includes a migration or an Edge Function, apply it in Supabase as part of shipping (the Supabase connector when available), check it, and say exactly what was applied.
- Keep it at WCAG 2.1 AA or better on phone and desktop: keyboard access, visible focus, contrast, and reduced motion.
- House rules: no dashes as punctuation in UI copy, docs, or comments; the wordmark is always cyberxLA.
- This repo is public. Never commit secrets, or client names and email addresses (demo data uses made up names and the reserved `.example` domain).
