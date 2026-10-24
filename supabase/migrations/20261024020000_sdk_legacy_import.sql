-- A fixed-purpose SDK import boundary. Only the server's service_role may call
-- it; browsers cannot import, choose another owner, or submit arbitrary SQL.
create function public.desk_import_legacy(p_data jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owners uuid[];
  v_owner uuid;
  v_summary jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or p_apply is null
    or jsonb_typeof(p_data -> 'collections') is distinct from 'array'
    or jsonb_typeof(p_data -> 'pages') is distinct from 'array'
    or jsonb_typeof(p_data -> 'memberships') is distinct from 'array' then
    raise exception 'Invalid import structure' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 104857600
    or jsonb_array_length(p_data -> 'collections') > 50000
    or jsonb_array_length(p_data -> 'pages') > 50000
    or jsonb_array_length(p_data -> 'memberships') > 50000 then
    raise exception 'Import exceeds size limits' using errcode = '22023';
  end if;

  -- Typed recordsets reject malformed UUIDs, timestamps, and integer counters.
  if exists (
    select 1 from jsonb_to_recordset(p_data -> 'collections') as i(id uuid, owner uuid, name text, created_at timestamptz)
    where i.id is null or i.owner is null or i.name is null
      or char_length(btrim(i.name)) not between 1 and 100 or i.created_at is null
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(
      id uuid, owner uuid, platform text, handle text, name text, url text,
      followers bigint, posts jsonb, coverage jsonb, overall jsonb,
      last_synced_at timestamptz, sync_error text, provider text, canonical_id text)
    where i.id is null or i.owner is null or i.platform is null
      or i.platform not in ('instagram', 'youtube', 'tiktok')
      or i.handle is null or char_length(i.handle) not between 1 and 100
      or i.name is null or char_length(btrim(i.name)) not between 1 and 300
      or i.url is null or char_length(i.url) > 500
      or i.url !~ ('^https://(www\.|m\.)?' || case i.platform when 'instagram' then 'instagram\.com' when 'youtube' then 'youtube\.com' else 'tiktok\.com' end || '(:[0-9]+)?(/|$)')
      or i.followers < 0 or i.followers > 9007199254740991
      or jsonb_typeof(i.posts) is distinct from 'array'
      or jsonb_typeof(i.coverage) is distinct from 'object'
      or (i.overall is not null and i.overall <> 'null'::jsonb and jsonb_typeof(i.overall) <> 'object')
      or octet_length(i.posts::text) > 8388608
      or octet_length(i.coverage::text) > 65536 or octet_length(i.overall::text) > 65536
      or char_length(i.sync_error) > 2000 or char_length(i.provider) > 100 or char_length(i.canonical_id) > 200
  ) then
    raise exception 'Invalid import record' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(posts jsonb)
    where jsonb_array_length(i.posts) > 1000
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(id uuid, posts jsonb),
      lateral jsonb_array_elements(i.posts) as post(value)
    where jsonb_typeof(post.value) <> 'object' or jsonb_typeof(post.value -> 'id') is distinct from 'string'
      or char_length(btrim(post.value ->> 'id')) not between 1 and 200
      or (post.value ->> 'pageId') is distinct from i.id::text
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(posts jsonb)
    where (select count(*) from jsonb_array_elements(i.posts)) <>
      (select count(distinct post.value ->> 'id') from jsonb_array_elements(i.posts) as post(value))
  ) then
    raise exception 'Invalid post snapshots' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(posts jsonb),
      lateral jsonb_array_elements(i.posts) as post(value), lateral jsonb_each(post.value) as metric(key, value)
    where metric.key in ('views', 'likes', 'comments', 'shares', 'saves') and metric.value <> 'null'::jsonb
      and (jsonb_typeof(metric.value) <> 'number' or (metric.value #>> '{}')::numeric < 0
        or (metric.value #>> '{}')::numeric > 9007199254740991
        or (metric.value #>> '{}')::numeric <> trunc((metric.value #>> '{}')::numeric))
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(overall jsonb),
      lateral jsonb_each(case when jsonb_typeof(i.overall) = 'object' then i.overall else '{}'::jsonb end) as metric(key, value)
    where metric.key in ('views', 'posts', 'followers', 'likes', 'comments', 'shares') and metric.value <> 'null'::jsonb
      and (jsonb_typeof(metric.value) <> 'number' or (metric.value #>> '{}')::numeric < 0
        or (metric.value #>> '{}')::numeric > 9007199254740991
        or (metric.value #>> '{}')::numeric <> trunc((metric.value #>> '{}')::numeric))
  ) then
    raise exception 'Invalid snapshot counters' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_to_recordset(p_data -> 'collections') as i(id uuid)) <>
      (select count(distinct id) from jsonb_to_recordset(p_data -> 'collections') as i(id uuid))
    or (select count(*) from jsonb_to_recordset(p_data -> 'pages') as i(id uuid)) <>
      (select count(distinct id) from jsonb_to_recordset(p_data -> 'pages') as i(id uuid))
    or (select count(*) from jsonb_to_recordset(p_data -> 'pages') as i(owner uuid, platform text, handle text)) <>
      (select count(distinct (owner, platform, handle)) from jsonb_to_recordset(p_data -> 'pages') as i(owner uuid, platform text, handle text))
    or (select count(*) from jsonb_to_recordset(p_data -> 'memberships') as i(collection_id uuid, page_id uuid)) <>
      (select count(distinct (collection_id, page_id)) from jsonb_to_recordset(p_data -> 'memberships') as i(collection_id uuid, page_id uuid)) then
    raise exception 'Duplicate import records' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_data -> 'memberships') as m(collection_id uuid, page_id uuid, owner uuid)
    left join jsonb_to_recordset(p_data -> 'collections') as c(id uuid, owner uuid) on c.id = m.collection_id and c.owner = m.owner
    left join jsonb_to_recordset(p_data -> 'pages') as p(id uuid, owner uuid) on p.id = m.page_id and p.owner = m.owner
    where m.owner is null or c.id is null or p.id is null
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as p(id uuid)
    where not exists (select 1 from jsonb_to_recordset(p_data -> 'memberships') as m(page_id uuid) where m.page_id = p.id)
  ) then
    raise exception 'Import memberships must join imported records of one owner' using errcode = '22023';
  end if;

  select coalesce(array_agg(owner order by owner), '{}'::uuid[]) into v_owners from (
    select owner from jsonb_to_recordset(p_data -> 'collections') as i(owner uuid)
    union select owner from jsonb_to_recordset(p_data -> 'pages') as i(owner uuid)
  ) as owners;
  -- Share the same owner-row lock as the SDK workspace operations. Sorting
  -- makes imports spanning several owners safe from reversed lock order.
  perform u.id from public.users as u where u.id = any(v_owners) order by u.id for update;
  if (select count(*) from public.users as u where u.id = any(v_owners)) <> cardinality(v_owners) then
    raise exception 'Mapped users must already exist' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_data -> 'collections') as i(id uuid, owner uuid)
    join public.collections as c on c.id = i.id where c.owner <> i.owner
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(id uuid, owner uuid, platform text, handle text)
    join public.pages as p on p.id = i.id
    where p.owner <> i.owner or p.platform <> i.platform or p.handle <> i.handle
  ) or exists (
    select 1 from jsonb_to_recordset(p_data -> 'pages') as i(id uuid, owner uuid, platform text, handle text)
    join public.pages as p on p.owner = i.owner and p.platform = i.platform and p.handle = i.handle
    where p.id <> i.id
  ) then
    raise exception 'Import conflicts with existing ownership or page identity' using errcode = '23505';
  end if;
  foreach v_owner in array v_owners loop
    if (select count(*) from public.collections where owner = v_owner) +
        (select count(*) from jsonb_to_recordset(p_data -> 'collections') as i(id uuid, owner uuid)
          where i.owner = v_owner and not exists (select 1 from public.collections as c where c.id = i.id)) > 100
      or (select count(*) from public.pages where owner = v_owner) +
        (select count(*) from jsonb_to_recordset(p_data -> 'pages') as i(id uuid, owner uuid)
          where i.owner = v_owner and not exists (select 1 from public.pages as p where p.id = i.id)) > 500 then
      raise exception 'Import exceeds target workspace limits' using errcode = '22023';
    end if;
  end loop;
  select jsonb_build_object(
    'collectionsToAdd', (select count(*) from jsonb_to_recordset(p_data -> 'collections') as i(id uuid) where not exists (select 1 from public.collections as c where c.id = i.id)),
    'pagesToAdd', (select count(*) from jsonb_to_recordset(p_data -> 'pages') as i(id uuid) where not exists (select 1 from public.pages as p where p.id = i.id)),
    'membershipsInExport', jsonb_array_length(p_data -> 'memberships'),
    'membershipsToAdd', (select count(*) from jsonb_to_recordset(p_data -> 'memberships') as i(collection_id uuid, page_id uuid) where not exists (select 1 from public.memberships as m where m.collection_id = i.collection_id and m.page_id = i.page_id)),
    'owners', cardinality(v_owners)) into v_summary;
  if not p_apply then return v_summary; end if;

  insert into public.collections (id, owner, name, created_at)
  select i.id, i.owner, i.name, i.created_at
  from jsonb_to_recordset(p_data -> 'collections') as i(id uuid, owner uuid, name text, created_at timestamptz)
  where not exists (select 1 from public.collections as c where c.id = i.id);
  insert into public.pages (id, owner, platform, handle, url, name, followers, posts, coverage, overall,
    last_synced_at, sync_error, provider, canonical_id, locked_until)
  select i.id, i.owner, i.platform, i.handle, i.url, i.name, i.followers, i.posts, i.coverage, nullif(i.overall, 'null'::jsonb),
    i.last_synced_at, i.sync_error, i.provider, i.canonical_id, 0
  from jsonb_to_recordset(p_data -> 'pages') as i(id uuid, owner uuid, platform text, handle text, url text, name text,
    followers bigint, posts jsonb, coverage jsonb, overall jsonb, last_synced_at timestamptz, sync_error text, provider text, canonical_id text)
  where not exists (select 1 from public.pages as p where p.id = i.id);
  insert into public.memberships (collection_id, page_id, owner)
  select i.collection_id, i.page_id, i.owner
  from jsonb_to_recordset(p_data -> 'memberships') as i(collection_id uuid, page_id uuid, owner uuid)
  where not exists (select 1 from public.memberships as m where m.collection_id = i.collection_id and m.page_id = i.page_id);
  return v_summary;
end;
$$;

revoke all on function public.desk_import_legacy(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.desk_import_legacy(jsonb, boolean) to service_role;
grant usage on schema public to service_role;
grant select on table public.users to service_role;
-- SELECT ... FOR UPDATE requires UPDATE privilege on at least one column.
grant update (last_seen_at) on table public.users to service_role;
grant select, insert on table public.collections, public.pages, public.memberships to service_role;
