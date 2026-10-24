-- Fixed service-only reporting RPC. No dynamic SQL or credential payloads.
create function private.desk_safe_count(p_value jsonb, p_allow_string boolean default false)
returns bigint language plpgsql immutable security invoker set search_path = ''
as $$
declare n numeric;
begin
  if jsonb_typeof(p_value) = 'number' then n := (p_value #>> '{}')::numeric;
  elsif p_allow_string and jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[0-9]+$' then
    if char_length(ltrim(p_value #>> '{}','0'))>16 then return null; end if;
    n := (p_value #>> '{}')::numeric;
  else return null;
  end if;
  if n between 0 and 9007199254740991 and trunc(n) = n then return n::bigint; end if;
  return null;
end;
$$;
revoke all on function private.desk_safe_count(jsonb, boolean) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.desk_safe_count(jsonb, boolean) to service_role;

create function public.desk_admin_report(
  p_actor uuid, p_section text default 'overview', p_limit integer default 25,
  p_offset integer default 0, p_search text default '', p_owner uuid default null,
  p_collection uuid default null
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  summary jsonb;
  items jsonb := '[]'::jsonb;
  collection_record jsonb;
  total bigint := 0;
  pattern text;
begin
  if not exists (select 1 from public.users where id=p_actor and user_type='admin') then
    raise exception using errcode='P0001', message='DD403:Administrator access is required.';
  end if;
  if p_section is null or p_section not in ('overview','users','pages','collections') then
    raise exception using errcode='P0001', message='DD400:Choose users, pages, collections, or overview.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception using errcode='P0001', message='DD400:Invalid pagination.';
  end if;
  p_search := btrim(coalesce(p_search,''));
  if char_length(p_search)>200 then
    raise exception using errcode='P0001', message='DD400:Search must be 200 characters or fewer.';
  end if;
  if p_collection is not null and p_section<>'pages' then
    raise exception using errcode='P0001', message='DD400:Collection filtering is available in the pages section.';
  end if;
  pattern := '%' || replace(replace(replace(p_search,'!','!!'),'%','!%'),'_','!_') || '%';
  select jsonb_build_object(
    'users',(select count(*) from public.users),
    'admins',(select count(*) from public.users where user_type='admin'),
    'collections',(select count(*) from public.collections),
    'pages',(select count(*) from public.pages),
    'memberships',(select count(*) from public.memberships)
  ) into summary;

  if p_section='users' then
    with filtered as (
      select u.*,
        (select count(*) from public.collections c where c.owner=u.id) as collection_count,
        (select count(*) from public.pages p where p.owner=u.id) as page_count
      from public.users u
      where (p_owner is null or u.id=p_owner)
        and (p_search='' or u.email ilike pattern escape '!' or u.name ilike pattern escape '!' or u.id::text ilike pattern escape '!')
    ), paged as (
      select *,row_number() over(order by created_at desc,id) as ordinal
      from filtered order by created_at desc,id limit p_limit offset p_offset
    )
    select (select count(*) from filtered),coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'email',email,'name',name,'userType',user_type,
      'createdAt',created_at,'lastSeenAt',last_seen_at,'collectionCount',collection_count,'pageCount',page_count
    ) order by ordinal),'[]'::jsonb) into total,items from paged;
  elsif p_section='collections' then
    with filtered as (
      select c.*,u.email as owner_email,u.name as owner_name,
        (select count(*) from public.memberships m join public.pages p on p.id=m.page_id and p.owner=c.owner
          where m.collection_id=c.id and m.owner=c.owner) as page_count
      from public.collections c left join public.users u on u.id=c.owner
      where (p_owner is null or c.owner=p_owner)
        and (p_search='' or c.name ilike pattern escape '!' or u.email ilike pattern escape '!' or u.name ilike pattern escape '!' or c.owner::text ilike pattern escape '!')
    ), paged as (
      select *,row_number() over(order by created_at desc,id) as ordinal
      from filtered order by created_at desc,id limit p_limit offset p_offset
    )
    select (select count(*) from filtered),coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'name',name,'createdAt',created_at,'pageCount',page_count,
      'ownerId',owner,'ownerEmail',owner_email,'ownerName',owner_name
    ) order by ordinal),'[]'::jsonb) into total,items from paged;
  elsif p_section='pages' then
    if p_collection is not null then
      select jsonb_build_object('id',c.id,'name',c.name,'createdAt',c.created_at,
        'pageCount',(select count(*) from public.memberships m join public.pages p on p.id=m.page_id and p.owner=c.owner where m.collection_id=c.id and m.owner=c.owner),
        'ownerId',c.owner,'ownerEmail',u.email,'ownerName',u.name)
      into collection_record
      from public.collections c left join public.users u on u.id=c.owner where c.id=p_collection;
      if collection_record is null then
        raise exception using errcode='P0001', message='DD404:Collection not found.';
      end if;
    end if;
    with filtered as (
      select p.*,u.email as owner_email,u.name as owner_name,
        (select count(*) from public.memberships m join public.collections c on c.id=m.collection_id and c.owner=p.owner where m.page_id=p.id and m.owner=p.owner) as collection_count
      from public.pages p left join public.users u on u.id=p.owner
      where (p_owner is null or p.owner=p_owner)
        and (p_collection is null or exists(select 1 from public.memberships m where m.page_id=p.id and m.collection_id=p_collection and m.owner=p.owner))
        and (p_search='' or p.name ilike pattern escape '!' or p.handle ilike pattern escape '!' or p.url ilike pattern escape '!' or u.email ilike pattern escape '!' or u.name ilike pattern escape '!' or p.owner::text ilike pattern escape '!')
    ), paged as (
      select *,row_number() over(order by last_synced_at desc nulls last,name,id) as ordinal
      from filtered order by last_synced_at desc nulls last,name,id limit p_limit offset p_offset
    ), records as (
      select p.ordinal,jsonb_build_object(
        'id',p.id,'platform',p.platform,'handle',p.handle,'name',p.name,'url',p.url,'followers',p.followers,
        'lastSyncedAt',p.last_synced_at,'hasSyncError',coalesce(p.sync_error<>'',false),
        'selectedPostCount',metrics.posts,'views',private.desk_safe_count(to_jsonb(metrics.views)),
        'likes',private.desk_safe_count(to_jsonb(metrics.likes)),'comments',private.desk_safe_count(to_jsonb(metrics.comments)),
        'shares',private.desk_safe_count(to_jsonb(metrics.shares)),
        'lifetimeViews',private.desk_safe_count(p.overall->'views',true),'lifetimePosts',private.desk_safe_count(p.overall->'posts',true),
        'collectionCount',p.collection_count,'ownerId',p.owner,'ownerEmail',p.owner_email,'ownerName',p.owner_name,
        'coverage',jsonb_build_object(
          'mode',case when p.coverage->>'requestedMode'='date' then 'date' else 'posts' end,
          'limit',private.desk_safe_count(p.coverage->'limit',true),
          'from',case when jsonb_typeof(p.coverage->'from')='string' then p.coverage->>'from' else null end,
          'to',case when jsonb_typeof(p.coverage->'to')='string' then p.coverage->>'to' else null end,
          'complete',coalesce(p.coverage->'complete'='true'::jsonb,false)
        )
      ) as item
      from paged p cross join lateral (
        select count(*) as posts,
          sum(private.desk_safe_count(post.value->'views')) as views,
          sum(private.desk_safe_count(post.value->'likes')) as likes,
          sum(private.desk_safe_count(post.value->'comments')) as comments,
          sum(private.desk_safe_count(post.value->'shares')) as shares
        from jsonb_array_elements(case when jsonb_typeof(p.posts)='array' then p.posts else '[]'::jsonb end) as post(value)
      ) metrics
    )
    select (select count(*) from filtered),coalesce(jsonb_agg(item order by ordinal),'[]'::jsonb) into total,items from records;
  end if;
  return jsonb_build_object('section',p_section,'items',items,'total',total,'limit',p_limit,'offset',p_offset,
    'hasMore',p_offset+jsonb_array_length(items)<total,'summary',summary)
    || case when collection_record is null then '{}'::jsonb else jsonb_build_object('collection',collection_record) end;
end;
$$;
revoke all on function public.desk_admin_report(uuid,text,integer,integer,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.desk_admin_report(uuid,text,integer,integer,text,uuid,uuid) to service_role;
