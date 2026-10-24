-- Distribution Desk: Supabase Auth identities, tenant-owned records, and
-- read-only browser access. Privileged application writes use DATABASE_URL
-- on the server; never expose that connection string or a service role key.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text check (email is null or char_length(email) <= 320),
  name text check (name is null or char_length(name) <= 200),
  user_type text not null default 'user' check (user_type in ('user', 'admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (id, owner)
);

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.users(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'youtube', 'tiktok')),
  handle text not null check (char_length(handle) between 1 and 100),
  name text not null check (char_length(name) <= 300),
  url text not null check (char_length(url) <= 500 and url ~ '^https://'),
  followers bigint check (followers between 0 and 9007199254740991),
  posts jsonb not null default '[]'::jsonb check (jsonb_typeof(posts) = 'array'),
  coverage jsonb not null default '{}'::jsonb check (jsonb_typeof(coverage) = 'object'),
  overall jsonb check (overall is null or jsonb_typeof(overall) = 'object'),
  last_synced_at timestamptz,
  sync_error text,
  provider text,
  locked_until bigint not null default 0 check (locked_until between 0 and 9007199254740991),
  canonical_id text,
  unique (owner, platform, handle),
  unique (id, owner)
);

create table public.memberships (
  collection_id uuid not null,
  page_id uuid not null,
  owner uuid not null references public.users(id) on delete cascade,
  primary key (collection_id, page_id),
  foreign key (collection_id, owner) references public.collections(id, owner) on delete cascade,
  foreign key (page_id, owner) references public.pages(id, owner) on delete cascade
);

create table public.settings (
  owner uuid primary key references public.users(id) on delete cascade,
  provider text not null default 'tikhub' check (provider in ('tikhub', 'scrapecreators')),
  -- Application-encrypted ciphertext only. Neither key column is available
  -- through the browser Data API, including for admin users.
  api_key text,
  youtube_key text,
  post_limit smallint not null default 30 check (post_limit in (30, 100)),
  request_limit integer not null default 500 check (request_limit between 10 and 2500)
);

create table public.usage (
  owner uuid not null references public.users(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  requests bigint not null default 0 check (requests between 0 and 9007199254740991),
  primary key (owner, month)
);

create index users_email_idx on public.users (lower(email));
create index users_user_type_idx on public.users (user_type);
create index collections_owner_created_idx on public.collections (owner, created_at desc);
create index pages_owner_platform_idx on public.pages (owner, platform);
create index pages_owner_canonical_idx on public.pages (owner, platform, canonical_id) where canonical_id is not null;
create index memberships_owner_collection_idx on public.memberships (owner, collection_id);
create index memberships_page_owner_idx on public.memberships (page_id, owner);

-- The function owner is the privileged migration role. It bypasses users RLS
-- for this boolean lookup, avoiding recursive users-policy evaluation.
-- Empty search_path and qualified names prevent search-path substitution.
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users
    where id = (select auth.uid()) and user_type = 'admin'
  );
$$;
revoke all on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;

alter table public.users enable row level security;
alter table public.collections enable row level security;
alter table public.pages enable row level security;
alter table public.memberships enable row level security;
alter table public.settings enable row level security;
alter table public.usage enable row level security;

-- Explicit grants override Supabase's broad defaults for these application
-- tables. No browser role can insert, update, delete, or promote a profile.
revoke all on table public.users, public.collections, public.pages,
  public.memberships, public.settings, public.usage from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.users, public.collections, public.pages,
  public.memberships to authenticated;

create policy users_read_own_or_admin on public.users
for select to authenticated
using (id = (select auth.uid()) or (select private.is_admin()));

create policy collections_read_own_or_admin on public.collections
for select to authenticated
using (owner = (select auth.uid()) or (select private.is_admin()));

create policy pages_read_own_or_admin on public.pages
for select to authenticated
using (owner = (select auth.uid()) or (select private.is_admin()));

create policy memberships_read_own_or_admin on public.memberships
for select to authenticated
using (owner = (select auth.uid()) or (select private.is_admin()));

-- settings and usage deliberately have no browser grants and no policies.

create function private.sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, name)
  values (
    new.id,
    nullif(btrim(new.email), ''),
    coalesce(
      nullif(btrim(left(new.raw_user_meta_data ->> 'full_name', 200)), ''),
      nullif(btrim(left(new.raw_user_meta_data ->> 'name', 200)), '')
    )
  )
  on conflict (id) do update set
    email = excluded.email,
    name = excluded.name;
  -- Role is always the database default for inserts, and is never changed
  -- from mutable Auth metadata. Existing manually assigned roles survive.
  return new;
end;
$$;
revoke all on function private.sync_auth_profile() from public, anon, authenticated;

create trigger distribution_desk_sync_auth_profile
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function private.sync_auth_profile();

-- After the first sign-in, promote the intended account manually using a
-- privileged SQL connection, matching its verified public.users.id:
-- update public.users set user_type = 'admin' where id = '<verified-user-uuid>';
-- No account is automatically promoted by email or by being first to sign up.
