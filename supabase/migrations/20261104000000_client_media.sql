-- Photos and videos per client. The files live in Cloudflare R2; this table records
-- which client each file belongs to. A row is 'pending' until the upload is confirmed.

create table public.client_media (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict,
  object_key text not null unique check (char_length(object_key) <= 400),
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text not null check (content_type ~ '^(image|video)/[a-z0-9.+-]+$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 5000000000),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz
);
create index client_media_client on public.client_media (client_id, created_at);

alter table public.client_media enable row level security;
revoke all on public.client_media from anon, authenticated;
