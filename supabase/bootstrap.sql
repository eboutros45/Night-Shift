-- Run after the tracked migrations, in the Supabase SQL editor.
-- Both buckets are private: even event artwork requires the authenticated Worker.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
 ('proofs', 'proofs', false, 5242880, array['image/png','image/jpeg','image/webp','application/pdf']),
 ('media', 'media', false, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- No browser client accesses application tables. The Worker uses server credentials.
revoke all on public.events, public.waves, public.orders, public.tickets, public.users,
 public.journal, public.page_views, public.rate_limits, public.login_challenges, public.staff_sessions from anon, authenticated;
