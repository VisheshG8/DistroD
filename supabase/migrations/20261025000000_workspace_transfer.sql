-- Portable workspace identities survive copies between logins. Database row IDs
-- remain tenant-specific; these IDs only identify a record inside a backup.
alter table public.collections add column transfer_id uuid;
update public.collections set transfer_id = id where transfer_id is null;
alter table public.collections alter column transfer_id set default gen_random_uuid();
alter table public.collections alter column transfer_id set not null;
alter table public.collections add unique (owner, transfer_id);
alter table public.pages add column transfer_id uuid;
update public.pages set transfer_id = id where transfer_id is null;
alter table public.pages alter column transfer_id set default gen_random_uuid();
alter table public.pages alter column transfer_id set not null;
alter table public.pages add unique (owner, transfer_id);

-- Transfers use bounded chunks so large workspaces do not hit hosting request
-- limits. Staging is private, owner-bound, expiring, and never browser-readable.
create table private.workspace_transfers (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.users(id) on delete cascade,
  direction text not null check (direction in ('import', 'export')),
  state text not null default 'uploading',
  bytes integer not null check (bytes between 1 and 104857600),
  total integer not null check (total between 1 and 200),
  data bytea,
  meta jsonb not null default '{}',
  expires_at timestamptz not null default now() + interval '1 hour'
);
create index workspace_transfers_owner on private.workspace_transfers(owner, expires_at);
create table private.workspace_transfer_chunks (
  job uuid not null references private.workspace_transfers(id) on delete cascade,
  position integer not null check (position between 0 and 199),
  data bytea not null check (octet_length(data) between 1 and 524288),
  primary key (job, position)
);
-- No browser policies: only the backend service role (BYPASSRLS) can access
-- these staging records, in addition to the explicit privilege revocations.
alter table private.workspace_transfers enable row level security;
alter table private.workspace_transfer_chunks enable row level security;
revoke all on private.workspace_transfers, private.workspace_transfer_chunks from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on private.workspace_transfers, private.workspace_transfer_chunks to service_role;

create function private.prepare_workspace_import(p_owner uuid, p_archive jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  w jsonb; cm jsonb; pm jsonb; rows jsonb; summary jsonb; settings jsonb;
begin
  if p_archive->>'format' is distinct from 'distribution-desk.workspace'
    or p_archive->>'version' is distinct from '1'
    or jsonb_typeof(p_archive->'workspace') is distinct from 'object' then
    raise exception 'DD400:Choose a Distribution Desk workspace backup (version 1). CSV reports cannot be restored.';
  end if;
  w := p_archive->'workspace';
  if jsonb_typeof(w->'collections') is distinct from 'array'
    or jsonb_typeof(w->'pages') is distinct from 'array'
    or jsonb_typeof(w->'memberships') is distinct from 'array'
    or jsonb_array_length(w->'collections') > 100
    or jsonb_array_length(w->'pages') > 500
    or jsonb_array_length(w->'memberships') > 50000 then
    raise exception 'DD400:This backup has invalid records or exceeds workspace limits.';
  end if;
  if p_archive ? 'preferences' and (jsonb_typeof(p_archive->'preferences') <> 'object'
    or octet_length((p_archive->'preferences')::text) > 2097152) then
    raise exception 'DD400:The saved view preferences are invalid or too large.';
  end if;
  settings := w->'settings';
  if settings is not null and settings <> 'null'::jsonb then
    if jsonb_typeof(settings) <> 'object'
      or (settings->>'provider') is null or settings->>'provider' not in ('tikhub','scrapecreators')
      or (settings->>'post_limit') is null or (settings->>'post_limit')::integer not in (30,100)
      or (settings->>'request_limit') is null or (settings->>'request_limit')::integer not between 10 and 2500 then
      raise exception 'DD400:The backup contains invalid workspace settings.';
    end if;
    settings := jsonb_build_object('provider',settings->>'provider',
      'post_limit',(settings->>'post_limit')::integer,'request_limit',(settings->>'request_limit')::integer);
  end if;
  -- Map only inside the verified destination workspace. Ignore uploaded owners,
  -- roles, credentials, usage counters and locks. They cannot be imported.
  select coalesce(jsonb_agg(jsonb_build_object('source',i.id,'target',coalesce(e.id,gen_random_uuid()),
    'transfer',coalesce(i.transfer_id,i.id),'isNew',e.id is null)), '[]') into cm
  from jsonb_to_recordset(w->'collections') as i(id uuid,transfer_id uuid)
  left join lateral (select c.id from public.collections c where c.owner=p_owner
    and (c.transfer_id=coalesce(i.transfer_id,i.id) or c.id=i.id)
    order by (c.transfer_id=coalesce(i.transfer_id,i.id)) desc limit 1) e on true;
  if exists (select 1 from jsonb_to_recordset(w->'pages') as i(id uuid,transfer_id uuid,platform text,handle text,canonical_id text)
    where (select count(*) from public.pages p where p.owner=p_owner and p.platform=i.platform
      and (p.transfer_id=coalesce(i.transfer_id,i.id) or p.id=i.id or p.handle=i.handle
        or (nullif(i.canonical_id,'') is not null and p.canonical_id=i.canonical_id))) > 1) then
    raise exception 'DD409:A backup page matches multiple saved pages. Resolve those duplicate pages before importing.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('source',i.id,'target',coalesce(e.id,gen_random_uuid()),
    'transfer',coalesce(i.transfer_id,i.id),'isNew',e.id is null)), '[]') into pm
  from jsonb_to_recordset(w->'pages') as i(id uuid,transfer_id uuid,platform text,handle text,canonical_id text)
  left join lateral (select p.id from public.pages p where p.owner=p_owner and p.platform=i.platform
    and (p.transfer_id=coalesce(i.transfer_id,i.id) or p.id=i.id or p.handle=i.handle
      or (nullif(i.canonical_id,'') is not null and p.canonical_id=i.canonical_id)) limit 1) e on true;
  if (select count(distinct m.transfer) from jsonb_to_recordset(cm) as m(transfer uuid)) <> jsonb_array_length(cm)
    or (select count(distinct m.transfer) from jsonb_to_recordset(pm) as m(transfer uuid)) <> jsonb_array_length(pm)
    or (select count(distinct m.target) from jsonb_to_recordset(cm) as m(target uuid)) <> jsonb_array_length(cm)
    or (select count(distinct m.target) from jsonb_to_recordset(pm) as m(target uuid)) <> jsonb_array_length(pm) then
    raise exception 'DD400:The backup contains duplicate collection or page identities.';
  end if;
  select jsonb_build_object(
    'collections',coalesce((select jsonb_agg((i.value-'owner'-'transfer_id') || jsonb_build_object('id',m.target,'owner',p_owner))
      from jsonb_array_elements(w->'collections') i(value)
      join jsonb_to_recordset(cm) m(source uuid,target uuid) on m.source=(i.value->>'id')::uuid),'[]'),
    'pages',coalesce((select jsonb_agg((i.value-'owner'-'locked_until'-'transfer_id') || jsonb_build_object(
      'id',m.target,'owner',p_owner,'handle',coalesce(existing.handle,i.value->>'handle'),'posts',case when jsonb_typeof(i.value->'posts')='array' then
        coalesce((select jsonb_agg(post.value || jsonb_build_object('pageId',m.target))
          from jsonb_array_elements(i.value->'posts') post(value)),'[]') else i.value->'posts' end))
      from jsonb_array_elements(w->'pages') i(value)
      join jsonb_to_recordset(pm) m(source uuid,target uuid) on m.source=(i.value->>'id')::uuid
      left join public.pages existing on existing.id=m.target and existing.owner=p_owner),'[]'),
    'memberships',coalesce((select jsonb_agg(jsonb_build_object('collection_id',c.target,'page_id',p.target,'owner',p_owner))
      from jsonb_to_recordset(w->'memberships') i(collection_id uuid,page_id uuid)
      join jsonb_to_recordset(cm) c(source uuid,target uuid) on c.source=i.collection_id
      join jsonb_to_recordset(pm) p(source uuid,target uuid) on p.source=i.page_id),'[]')
  ) into rows;
  if jsonb_array_length(rows->'collections') <> jsonb_array_length(w->'collections')
    or jsonb_array_length(rows->'pages') <> jsonb_array_length(w->'pages')
    or jsonb_array_length(rows->'memberships') <> jsonb_array_length(w->'memberships') then
    raise exception 'DD400:The backup contains missing IDs or broken collection memberships.';
  end if;
  -- The existing importer validates timestamps, profile URLs, counters, posts,
  -- ownership references, duplicates and final record caps without any writes.
  summary := public.desk_import_legacy(rows,false);
  summary := summary || jsonb_build_object(
    'collections',jsonb_array_length(cm),'pages',jsonb_array_length(pm),
    'existingCollections',jsonb_array_length(cm)-(summary->>'collectionsToAdd')::integer,
    'existingPages',jsonb_array_length(pm)-(summary->>'pagesToAdd')::integer,
    'posts',coalesce((select sum(jsonb_array_length(p->'posts')) from jsonb_array_elements(rows->'pages') p),0),
    'collectionNames',coalesce((select jsonb_agg(i.name) from (select value->>'name' as name from jsonb_array_elements(rows->'collections') limit 6) i),'[]'),
    'exportedAt',p_archive->>'exportedAt');
  return jsonb_build_object('rows',rows,'summary',summary,'collections',cm,'pages',pm,
    'preferences',coalesce(p_archive->'preferences','{}'),'settings',settings);
end;
$$;
revoke all on function private.prepare_workspace_import(uuid,jsonb) from public, anon, authenticated;
grant execute on function private.prepare_workspace_import(uuid,jsonb) to service_role;

create function public.desk_workspace_transfer(p_owner uuid,p_action text,p_job uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_job private.workspace_transfers%rowtype;
  archive jsonb; prepared jsonb; rows jsonb; result jsonb; raw bytea; part bytea;
  v_position integer; expected integer; overwrite_existing boolean; restore_settings boolean;
begin
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  -- Expired transfer contents are removed on the next transfer operation.
  delete from private.workspace_transfers where expires_at < now();
  if p_action in ('begin_export','begin_import') then
    if (select count(*) from private.workspace_transfers where owner=p_owner and state<>'done') >= 3 then
      raise exception 'DD409:Finish or cancel an open transfer before starting another.';
    end if;
    if p_action='begin_export' then
      select jsonb_build_object('format','distribution-desk.workspace','version',1,'exportedAt',now(),
        'workspace',jsonb_build_object(
          'collections',coalesce((select jsonb_agg(to_jsonb(c)-'owner' order by c.created_at,c.id) from public.collections c where c.owner=p_owner),'[]'),
          'pages',coalesce((select jsonb_agg(to_jsonb(p)-'owner'-'locked_until' order by p.id) from public.pages p where p.owner=p_owner),'[]'),
          'memberships',coalesce((select jsonb_agg(to_jsonb(m)-'owner' order by m.collection_id,m.page_id) from public.memberships m where m.owner=p_owner),'[]'),
          'settings',coalesce((select jsonb_build_object('provider',s.provider,'post_limit',s.post_limit,'request_limit',s.request_limit) from public.settings s where s.owner=p_owner),
            '{"provider":"tikhub","post_limit":30,"request_limit":500}'::jsonb))) into archive;
      raw := convert_to(archive::text,'UTF8');
      if octet_length(raw)>102760448 then raise exception 'DD400:This workspace exceeds the 98 MB backup limit.'; end if;
      insert into private.workspace_transfers(owner,direction,state,bytes,total,data)
        values(p_owner,'export','ready',octet_length(raw),ceil(octet_length(raw)/524288.0)::integer,raw) returning * into v_job;
    else
      expected := (p_data->>'bytes')::integer;
      if expected is null or expected not between 1 and 104857600 then raise exception 'DD400:Choose a backup smaller than 100 MB.'; end if;
      insert into private.workspace_transfers(owner,direction,bytes,total)
        values(p_owner,'import',expected,ceil(expected/524288.0)::integer) returning * into v_job;
    end if;
    return jsonb_build_object('job',v_job.id,'bytes',v_job.bytes,'total',v_job.total);
  end if;
  select * into v_job from private.workspace_transfers where id=p_job and owner=p_owner for update;
  if not found then raise exception 'DD404:This transfer expired or is unavailable. Choose the file again.'; end if;
  if p_action='cancel' then
    delete from private.workspace_transfers where id=v_job.id;
    return jsonb_build_object('ok',true);
  end if;
  if p_action='read_export' and v_job.direction='export' then
    v_position := (p_data->>'index')::integer;
    if v_position is null or v_position<0 or v_position>=v_job.total then raise exception 'DD400:Invalid transfer chunk.'; end if;
    return jsonb_build_object('chunk',encode(substring(v_job.data from v_position*524288+1 for 524288),'base64'));
  end if;
  if v_job.direction<>'import' then raise exception 'DD400:Invalid transfer operation.'; end if;
  if p_action='upload' and v_job.state='uploading' then
    v_position := (p_data->>'index')::integer;
    if v_position is null or v_position<0 or v_position>=v_job.total or octet_length(p_data->>'chunk')>720000 then
      raise exception 'DD400:Invalid transfer chunk.';
    end if;
    part := decode(p_data->>'chunk','base64');
    expected := case when v_position=v_job.total-1 then v_job.bytes-v_position*524288 else 524288 end;
    if part is null or octet_length(part)<>expected then raise exception 'DD400:The transfer chunk is incomplete. Retry the upload.'; end if;
    insert into private.workspace_transfer_chunks(job,position,data) values(v_job.id,v_position,part)
      on conflict(job,position) do update set data=excluded.data;
    return jsonb_build_object('ok',true);
  end if;
  if p_action='preview' and v_job.state in ('uploading','ready') then
    if (select count(*) from private.workspace_transfer_chunks where workspace_transfer_chunks.job=v_job.id)<>v_job.total then
      raise exception 'DD400:The upload is incomplete. Choose the file again.';
    end if;
    select string_agg(c.data,''::bytea order by c.position) into raw from private.workspace_transfer_chunks c where c.job=v_job.id;
    if octet_length(raw)<>v_job.bytes then raise exception 'DD400:The upload is incomplete. Choose the file again.'; end if;
    begin archive := convert_from(raw,'UTF8')::jsonb;
    exception when others then raise exception 'DD400:This file is not a valid JSON workspace backup.'; end;
    prepared := private.prepare_workspace_import(p_owner,archive);
    update private.workspace_transfers set state='ready',data=convert_to((prepared->'rows')::text,'UTF8'),meta=prepared-'rows' where id=v_job.id;
    return jsonb_build_object('summary',prepared->'summary','settings',prepared->'settings');
  end if;
  if p_action='apply' and v_job.state='done' then return v_job.meta; end if;
  if p_action='apply' and v_job.state='ready' then
    rows := convert_from(v_job.data,'UTF8')::jsonb;
    overwrite_existing := coalesce((p_data->>'overwrite')::boolean,false);
    restore_settings := coalesce((p_data->>'restoreSettings')::boolean,false);
    if exists(select 1 from public.pages p join jsonb_to_recordset(rows->'pages') i(id uuid) on i.id=p.id
      where p.owner=p_owner and p.locked_until>extract(epoch from clock_timestamp())*1000) then
      raise exception 'DD409:Wait for active page refreshes to finish, then import again.';
    end if;
    -- Recheck all limits and conflicts at commit, then perform one transaction.
    result := public.desk_import_legacy(rows,true);
    update public.collections c set transfer_id=m.transfer from jsonb_to_recordset(v_job.meta->'collections') m(target uuid,transfer uuid,"isNew" boolean)
      where c.id=m.target and c.owner=p_owner and m."isNew";
    update public.pages p set transfer_id=m.transfer from jsonb_to_recordset(v_job.meta->'pages') m(target uuid,transfer uuid,"isNew" boolean)
      where p.id=m.target and p.owner=p_owner and m."isNew";
    if overwrite_existing then
      update public.collections c set name=i.name,created_at=i.created_at
        from jsonb_to_recordset(rows->'collections') i(id uuid,name text,created_at timestamptz) where c.id=i.id and c.owner=p_owner;
      update public.pages p set name=i.name,url=i.url,followers=i.followers,posts=i.posts,coverage=i.coverage,overall=nullif(i.overall,'null'::jsonb),
        last_synced_at=i.last_synced_at,sync_error=i.sync_error,provider=i.provider,canonical_id=i.canonical_id,locked_until=0
        from jsonb_to_recordset(rows->'pages') i(id uuid,name text,url text,followers bigint,posts jsonb,coverage jsonb,overall jsonb,
          last_synced_at timestamptz,sync_error text,provider text,canonical_id text) where p.id=i.id and p.owner=p_owner;
    end if;
    if restore_settings and jsonb_typeof(v_job.meta->'settings')='object' then
      insert into public.settings(owner,provider,post_limit,request_limit)
        values(p_owner,v_job.meta->'settings'->>'provider',(v_job.meta->'settings'->>'post_limit')::smallint,(v_job.meta->'settings'->>'request_limit')::integer)
        on conflict(owner) do update set provider=excluded.provider,post_limit=excluded.post_limit,request_limit=excluded.request_limit,
          api_key=case when public.settings.provider=excluded.provider then public.settings.api_key else null end;
    end if;
    result := jsonb_build_object('ok',true,'summary',(v_job.meta->'summary') || result || jsonb_build_object('pages',jsonb_array_length(rows->'pages'),
      'collections',jsonb_array_length(rows->'collections'),'overwritten',overwrite_existing),
      'pageMap',v_job.meta->'pages','collectionMap',v_job.meta->'collections','preferences',v_job.meta->'preferences');
    delete from private.workspace_transfer_chunks c where c.job=v_job.id;
    update private.workspace_transfers set state='done',data=null,meta=result where id=v_job.id;
    return result;
  end if;
  raise exception 'DD400:This transfer operation is not available.';
end;
$$;
revoke all on function public.desk_workspace_transfer(uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.desk_workspace_transfer(uuid,text,uuid,jsonb) to service_role;
