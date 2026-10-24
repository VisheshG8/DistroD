-- Backend-only operations used through the Supabase SDK. Each call is one
-- database transaction; no SQL text or privileged writes are exposed to clients.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.users, public.collections,
  public.pages, public.memberships, public.settings, public.usage to service_role;

create function public.desk_create_collection(p_owner uuid, p_name text, p_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.users where id = p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'DD400:Use a collection name between 1 and 100 characters.';
  end if;
  if (select count(*) from public.collections where owner = p_owner) >= 100 then
    raise exception 'DD400:You can save up to 100 collections.';
  end if;
  insert into public.collections (id, owner, name) values (p_id, p_owner, btrim(p_name));
  return p_id;
end;
$$;

create function public.desk_delete_collection(p_owner uuid, p_collection uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.users where id = p_owner for update;
  perform 1 from public.collections where id = p_collection and owner = p_owner for update;
  if not found then raise exception 'DD404:Collection not found.'; end if;
  delete from public.collections where id = p_collection and owner = p_owner;
  delete from public.pages p where p.owner = p_owner
    and not exists (select 1 from public.memberships m where m.page_id = p.id and m.owner = p_owner);
end;
$$;

create function public.desk_duplicate_collection(p_owner uuid, p_collection uuid, p_name text, p_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.users where id = p_owner for update;
  perform 1 from public.collections where id = p_collection and owner = p_owner for update;
  if not found then raise exception 'DD404:Collection not found.'; end if;
  perform public.desk_create_collection(p_owner, p_name, p_id);
  insert into public.memberships (collection_id, page_id, owner)
    select p_id, page_id, p_owner from public.memberships
    where collection_id = p_collection and owner = p_owner;
  return p_id;
end;
$$;

create function public.desk_remove_page(p_owner uuid, p_collection uuid, p_page uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.users where id = p_owner for update;
  perform 1 from public.collections where id = p_collection and owner = p_owner for update;
  if not found then raise exception 'DD404:Collection not found.'; end if;
  perform 1 from public.pages where id = p_page and owner = p_owner for update;
  if not found then raise exception 'DD404:Page not found.'; end if;
  delete from public.memberships where collection_id = p_collection and page_id = p_page and owner = p_owner;
  delete from public.pages p where p.id = p_page and p.owner = p_owner
    and not exists (select 1 from public.memberships m where m.page_id = p.id and m.owner = p_owner);
end;
$$;

create function public.desk_add_page(p_owner uuid, p_collection uuid, p_platform text, p_handle text, p_url text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare saved_page_id uuid; added integer;
begin
  perform 1 from public.users where id = p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  perform 1 from public.collections where id = p_collection and owner = p_owner for update;
  if not found then raise exception 'DD404:Collection not found.'; end if;
  if p_platform is null or p_platform not in ('instagram', 'youtube', 'tiktok')
    or p_handle is null or char_length(p_handle) not between 1 and 100
    or p_url is null or char_length(p_url) > 500 or p_url !~ '^https://' then
    raise exception 'DD400:Invalid page input.';
  end if;
  select id into saved_page_id from public.pages
    where owner = p_owner and platform = p_platform and handle = p_handle;
  if saved_page_id is null then
    if (select count(*) from public.pages where owner = p_owner) >= 500 then
      raise exception 'DD400:This workspace can track up to 500 unique pages.';
    end if;
    insert into public.pages (owner, platform, handle, url, name)
      values (p_owner, p_platform, p_handle, p_url, '@' || p_handle) returning id into saved_page_id;
  end if;
  insert into public.memberships (collection_id, page_id, owner)
    values (p_collection, saved_page_id, p_owner) on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

create function public.desk_reserve_usage(p_owner uuid, p_month text, p_limit integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare reserved bigint;
begin
  if p_limit is null or p_limit not between 1 and 2500
    or p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'DD400:Choose a valid monthly request cap.';
  end if;
  insert into public.usage (owner, month, requests) values (p_owner, p_month, 1)
    on conflict (owner, month) do update set requests = public.usage.requests + 1
    where public.usage.requests < p_limit returning requests into reserved;
  return reserved is not null;
end;
$$;

create function public.desk_save_refresh(p_owner uuid, p_source uuid, p_target uuid, p_lease bigint, p_snapshot jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare locked_count integer; expected_count integer; changed integer;
begin
  if p_source is null or p_target is null or p_lease is null or p_lease <= 0 then
    raise exception 'DD409:This page changed during refresh. Please try again.';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or jsonb_typeof(p_snapshot->'posts') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'coverage') is distinct from 'object'
    or (p_snapshot->'overall' is not null and p_snapshot->'overall' <> 'null'::jsonb and jsonb_typeof(p_snapshot->'overall') <> 'object') then
    raise exception 'DD400:The provider returned an invalid snapshot.';
  end if;
  -- Collection edits use the same owner lock, so memberships cannot disappear
  -- between this check and the save. Deterministic row locking avoids deadlocks.
  perform 1 from public.users where id = p_owner for update;
  perform id from public.pages
    where id in (p_source, p_target) and owner = p_owner and locked_until = p_lease
    order by id for update;
  get diagnostics locked_count = row_count;
  expected_count := case when p_source = p_target then 1 else 2 end;
  if locked_count <> expected_count or not exists (
    select 1 from public.memberships where page_id = p_source and owner = p_owner
  ) or not exists (
    select 1 from public.memberships where page_id = p_target and owner = p_owner
  ) then raise exception 'DD409:This page changed during refresh. Please try again.'; end if;

  -- The API discovers aliases before taking this owner mutex. Two distinct
  -- handles can therefore both see no canonical page, then arrive here in
  -- sequence. Keep the second old snapshot and let its next refresh merge it.
  if p_source = p_target and nullif(p_snapshot->>'canonical_id', '') is not null
    and exists (
      select 1 from public.pages other_page
      join public.pages source_page on source_page.id = p_source and source_page.owner = p_owner
      where other_page.owner = p_owner and other_page.platform = source_page.platform
        and other_page.id <> p_source and other_page.canonical_id = p_snapshot->>'canonical_id'
    ) then raise exception 'DD409:Another tracked page now resolves to this account. Refresh again to merge their saved data.'; end if;
  if p_source <> p_target and not exists (
    select 1 from public.pages source_page
    join public.pages target_page on target_page.id = p_target and target_page.owner = p_owner
    where source_page.id = p_source and source_page.owner = p_owner
      and source_page.platform = target_page.platform
      and target_page.canonical_id = nullif(p_snapshot->>'canonical_id', '')
  ) then raise exception 'DD409:This page changed during refresh. Please try again.'; end if;

  update public.pages set
    name = p_snapshot->>'name', followers = (p_snapshot->>'followers')::bigint,
    posts = p_snapshot->'posts', coverage = p_snapshot->'coverage',
    overall = nullif(p_snapshot->'overall', 'null'::jsonb),
    provider = p_snapshot->>'provider', last_synced_at = (p_snapshot->>'last_synced_at')::timestamptz,
    sync_error = null, locked_until = 0, canonical_id = nullif(p_snapshot->>'canonical_id', '')
    where id = p_target and owner = p_owner and locked_until = p_lease;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'DD409:This page changed during refresh. Please try again.'; end if;
  if p_source <> p_target then
    insert into public.memberships (collection_id, page_id, owner)
      select collection_id, p_target, p_owner from public.memberships
      where page_id = p_source and owner = p_owner on conflict do nothing;
    delete from public.pages where id = p_source and owner = p_owner and locked_until = p_lease;
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'DD409:This page changed during refresh. Please try again.'; end if;
  end if;
  return p_target;
end;
$$;

revoke all on function public.desk_create_collection(uuid,text,uuid),
  public.desk_delete_collection(uuid,uuid), public.desk_duplicate_collection(uuid,uuid,text,uuid),
  public.desk_remove_page(uuid,uuid,uuid), public.desk_add_page(uuid,uuid,text,text,text),
  public.desk_reserve_usage(uuid,text,integer), public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.desk_create_collection(uuid,text,uuid),
  public.desk_delete_collection(uuid,uuid), public.desk_duplicate_collection(uuid,uuid,text,uuid),
  public.desk_remove_page(uuid,uuid,uuid), public.desk_add_page(uuid,uuid,text,text,text),
  public.desk_reserve_usage(uuid,text,integer), public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb)
  to service_role;
