-- OnScene admin: screens, rentals and back-office sessions.
-- Only the server (secret / service-role key) reads or writes these tables.
-- RLS is enabled with no policies, so the public anon key has no access.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- screens ----------

create table public.screens (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (number ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  label text not null default '' check (char_length(label) <= 80),
  status text not null default 'available' check (status in ('available', 'maintenance', 'retired')),
  notes text not null default '' check (char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger screens_updated_at before update on public.screens
  for each row execute function public.set_updated_at();

-- ---------- rentals ----------

create table public.rentals (
  id uuid primary key default gen_random_uuid(),
  client text not null check (char_length(client) between 1 and 120),
  venue text not null default '' check (char_length(venue) <= 160),
  notes text not null default '' check (char_length(notes) <= 1000),
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date < 366)
);
create index rentals_dates on public.rentals (start_date, end_date);
create trigger rentals_updated_at before update on public.rentals
  for each row execute function public.set_updated_at();

-- Which screens go out on each rental. `during` copies the rental's dates
-- (kept in sync by triggers) so Postgres itself refuses double-bookings.
create table public.rental_screens (
  rental_id uuid not null references public.rentals (id) on delete cascade,
  screen_id uuid not null references public.screens (id) on delete restrict,
  during daterange not null,
  primary key (rental_id, screen_id),
  constraint rental_screens_no_double_booking exclude using gist (screen_id with =, during with &&)
);
create index rental_screens_screen on public.rental_screens (screen_id);

create or replace function public.rental_screens_fill_during() returns trigger
language plpgsql set search_path = '' as $$
begin
  select daterange(r.start_date, r.end_date, '[]') into new.during from public.rentals r where r.id = new.rental_id;
  return new;
end $$;
create trigger rental_screens_during before insert or update on public.rental_screens
  for each row execute function public.rental_screens_fill_during();

create or replace function public.rentals_sync_during() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.rental_screens set during = daterange(new.start_date, new.end_date, '[]') where rental_id = new.id;
  return new;
end $$;
create trigger rentals_sync_during after update of start_date, end_date on public.rentals
  for each row execute function public.rentals_sync_during();

-- Creates or replaces a rental and its screens in one transaction.
create or replace function public.save_rental(
  p_id uuid, p_client text, p_venue text, p_notes text, p_start date, p_end date, p_screen_ids uuid[]
) returns public.rentals
language plpgsql set search_path = '' as $$
declare
  saved public.rentals;
begin
  if p_id is null then
    insert into public.rentals (client, venue, notes, start_date, end_date)
    values (p_client, p_venue, p_notes, p_start, p_end) returning * into saved;
  else
    -- Release the old screens first so moving dates cannot clash with itself.
    delete from public.rental_screens where rental_id = p_id;
    update public.rentals set client = p_client, venue = p_venue, notes = p_notes, start_date = p_start, end_date = p_end
    where id = p_id returning * into saved;
    if not found then raise exception 'Rental not found' using errcode = 'P0002'; end if;
  end if;
  insert into public.rental_screens (rental_id, screen_id)
  select saved.id, screen_id from (select distinct unnest(p_screen_ids) as screen_id) chosen;
  return saved;
end $$;

-- ---------- back-office sessions ----------

create table public.admin_sessions (
  token_hash text primary key,
  credential text not null,
  expires_at timestamptz not null
);
create index admin_sessions_expiry on public.admin_sessions (expires_at);

create table public.admin_login_attempts (
  key text primary key,
  count integer not null,
  window_ends timestamptz not null
);

-- Counts a sign-in attempt in a fixed window and returns the running total.
create or replace function public.admin_login_hit(p_key text, p_window_seconds integer) returns integer
language sql set search_path = '' as $$
  insert into public.admin_login_attempts as a (key, count, window_ends)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update set
    count = case when a.window_ends <= now() then 1 else a.count + 1 end,
    window_ends = case when a.window_ends <= now() then excluded.window_ends else a.window_ends end
  returning count;
$$;

-- ---------- lock down ----------

alter table public.screens enable row level security;
alter table public.rentals enable row level security;
alter table public.rental_screens enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_login_attempts enable row level security;

revoke all on public.screens, public.rentals, public.rental_screens, public.admin_sessions, public.admin_login_attempts from anon, authenticated;

revoke all on function public.save_rental(uuid, text, text, text, date, date, uuid[]) from public, anon, authenticated;
revoke all on function public.admin_login_hit(text, integer) from public, anon, authenticated;
grant execute on function public.save_rental(uuid, text, text, text, date, date, uuid[]) to service_role;
grant execute on function public.admin_login_hit(text, integer) to service_role;
