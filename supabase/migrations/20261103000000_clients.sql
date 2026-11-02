-- Clients become their own records. Every rental links to one client, and keeps
-- the address used for that booking (prefilled from the client's default address).

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  email text not null default '' check (char_length(email) <= 254 and (email = '' or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  phone text not null default '' check (phone ~ '^[0-9+() -]{0,30}$'),
  address text not null default '' check (char_length(address) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_name on public.clients (lower(name));
create trigger clients_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

-- Move existing free-text client names onto client records (one per distinct name).
insert into public.clients (name) select distinct client from public.rentals;
alter table public.rentals add column client_id uuid references public.clients (id) on delete restrict;
update public.rentals r set client_id = c.id from public.clients c where c.name = r.client;
alter table public.rentals alter column client_id set not null;
alter table public.rentals drop column client;
create index rentals_client on public.rentals (client_id);

-- The old "venue" becomes the booking address.
alter table public.rentals rename column venue to address;
alter table public.rentals drop constraint if exists rentals_venue_check;
alter table public.rentals add constraint rentals_address_check check (char_length(address) <= 300);

drop function public.save_rental(uuid, text, text, text, date, date, uuid[]);

-- Creates or replaces a rental and its screens in one transaction.
-- An empty address falls back to the client's default address.
create function public.save_rental(
  p_id uuid, p_client_id uuid, p_address text, p_notes text, p_start date, p_end date, p_screen_ids uuid[]
) returns public.rentals
language plpgsql set search_path = '' as $$
declare
  saved public.rentals;
  chosen_address text := p_address;
begin
  if coalesce(chosen_address, '') = '' then
    select c.address into chosen_address from public.clients c where c.id = p_client_id;
  end if;
  if p_id is null then
    insert into public.rentals (client_id, address, notes, start_date, end_date)
    values (p_client_id, coalesce(chosen_address, ''), p_notes, p_start, p_end) returning * into saved;
  else
    -- Release the old screens first so moving dates cannot clash with itself.
    delete from public.rental_screens where rental_id = p_id;
    update public.rentals set client_id = p_client_id, address = coalesce(chosen_address, ''), notes = p_notes, start_date = p_start, end_date = p_end
    where id = p_id returning * into saved;
    if not found then raise exception 'Rental not found' using errcode = 'P0002'; end if;
  end if;
  insert into public.rental_screens (rental_id, screen_id)
  select saved.id, screen_id from (select distinct unnest(p_screen_ids) as screen_id) chosen;
  return saved;
end $$;

alter table public.clients enable row level security;
revoke all on public.clients from anon, authenticated;
revoke all on function public.save_rental(uuid, uuid, text, text, date, date, uuid[]) from public, anon, authenticated;
grant execute on function public.save_rental(uuid, uuid, text, text, date, date, uuid[]) to service_role;
