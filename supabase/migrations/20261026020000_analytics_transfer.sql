-- Extend version-1 backups with optional analytics history. Global provider
-- configuration, request logs, shared cache identities and secrets stay local.
alter table public.alerts add column transfer_id uuid;
update public.alerts set transfer_id=id where transfer_id is null;
alter table public.alerts alter column transfer_id set default gen_random_uuid();
alter table public.alerts alter column transfer_id set not null;
alter table public.alerts add unique(owner,transfer_id);

create function private.workspace_history_counter(p_value jsonb)
returns bigint language plpgsql immutable security invoker set search_path='' as $$
declare n numeric;
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if jsonb_typeof(p_value)<>'number' then raise exception 'DD400:History counters must be whole numbers or unavailable.'; end if;
  n:=(p_value#>>'{}')::numeric;
  if n<0 or n>9007199254740991 or n<>trunc(n) then raise exception 'DD400:History contains an invalid counter.'; end if;
  return n::bigint;
end; $$;

create function private.workspace_history_time(p_value jsonb,p_nullable boolean default false)
returns timestamptz language plpgsql stable security invoker set search_path='' as $$
declare t timestamptz; s text;
begin
  if p_nullable and (p_value is null or p_value='null'::jsonb) then return null; end if;
  s:=p_value#>>'{}';
  if jsonb_typeof(p_value) is distinct from 'string' or s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'DD400:History timestamps must include a time and timezone.';
  end if;
  begin t:=s::timestamptz; exception when others then raise exception 'DD400:History contains an invalid timestamp.'; end;
  if not isfinite(t) or t<'1970-01-01'::timestamptz or t>now()+interval '1 day' then
    raise exception 'DD400:History contains an invalid or future timestamp.';
  end if;
  return t;
end; $$;

-- Keep the proven v1 identity and snapshot validator underneath the extension.
alter function private.prepare_workspace_import(uuid,jsonb) rename to prepare_workspace_import_v1;
create function private.prepare_workspace_import(p_owner uuid,p_archive jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  prepared jsonb; a jsonb; normalized jsonb; metadata jsonb:='[]'; fields jsonb;
  row_value jsonb; field_name text; target_id uuid; amount numeric; day_value date;
  page_posts jsonb:='[]'; account_samples jsonb:='[]'; post_samples jsonb:='[]'; alert_rows jsonb:='[]';
begin
  prepared:=private.prepare_workspace_import_v1(p_owner,p_archive);
  -- Explicit field selection prevents a backup from selecting a shared cache ID.
  for row_value in select value from jsonb_array_elements(p_archive->'workspace'->'pages') loop
    fields:='{}';
    select m.target into target_id from jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid)
      where m.source=(row_value->>'id')::uuid;
    if row_value ? 'monthly_pay' then
      if row_value->'monthly_pay'='null'::jsonb then fields:=fields||'{"monthly_pay":null}'::jsonb;
      else
        if jsonb_typeof(row_value->'monthly_pay')<>'number' then raise exception 'DD400:Monthly page pay must be a number or blank.'; end if;
        amount:=(row_value->>'monthly_pay')::numeric;
        if amount<0 or amount>999999999999.99 or amount<>trunc(amount,2) then raise exception 'DD400:Monthly page pay must be nonnegative with at most two decimal places.'; end if;
        fields:=fields||jsonb_build_object('monthly_pay',amount);
      end if;
    end if;
    foreach field_name in array array['editor','notes'] loop
      if row_value ? field_name then
        if jsonb_typeof(row_value->field_name)<>'string' or char_length(row_value->>field_name)>(case when field_name='editor' then 150 else 2000 end) then
          raise exception 'DD400:Page editor or notes are invalid or too long.';
        end if;
        fields:=fields||jsonb_build_object(field_name,row_value->field_name);
      end if;
    end loop;
    if row_value ? 'active' then
      if jsonb_typeof(row_value->'active')<>'boolean' then raise exception 'DD400:Page active status must be true or false.'; end if;
      fields:=fields||jsonb_build_object('active',row_value->'active');
    end if;
    if row_value ? 'start_date' then
      if row_value->'start_date'='null'::jsonb then fields:=fields||'{"start_date":null}'::jsonb;
      else
        if jsonb_typeof(row_value->'start_date')<>'string' or row_value->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'DD400:Page start dates must be calendar dates.'; end if;
        begin day_value:=(row_value->>'start_date')::date; exception when others then raise exception 'DD400:Page start date is invalid.'; end;
        if not isfinite(day_value) then raise exception 'DD400:Page start date is invalid.'; end if;
        fields:=fields||jsonb_build_object('start_date',day_value);
      end if;
    end if;
    metadata:=metadata||jsonb_build_array(jsonb_build_object('page_id',target_id,'fields',fields));
  end loop;

  a:=p_archive->'workspace'->'analytics';
  if a is not null then
    if jsonb_typeof(a)<>'object' or a->>'version' is distinct from '1' then raise exception 'DD400:This backup has an unsupported analytics-history format.'; end if;
    foreach field_name in array array['pagePosts','accountSnapshots','postSnapshots','alerts'] loop
      if jsonb_typeof(a->field_name) is distinct from 'array' or jsonb_array_length(a->field_name)>1000000 then
        raise exception 'DD400:This backup has invalid or oversized analytics history.';
      end if;
      if exists(select 1 from jsonb_array_elements(a->field_name) i where jsonb_typeof(i)<>'object') then
        raise exception 'DD400:Every history entry must be an object.';
      end if;
      if exists(select 1 from jsonb_array_elements(a->field_name) i
        where not exists(select 1 from jsonb_to_recordset(prepared->'pages') m(source uuid) where m.source=(i->>'page_id')::uuid)) then
        raise exception 'DD400:History refers to a page missing from this backup.';
      end if;
    end loop;

    if exists(select 1 from jsonb_array_elements(a->'pagePosts') i
      where jsonb_typeof(i->'payload') is distinct from 'object' or jsonb_typeof(i->'post_id') is distinct from 'string'
        or char_length(btrim(i->>'post_id')) not between 1 and 300
        or (i->'payload'->>'id') is distinct from (i->>'post_id')
        or (i->'payload'->>'pageId') is distinct from (i->>'page_id')
        or (i->'payload' ? 'url' and (jsonb_typeof(i->'payload'->'url')<>'string' or char_length(i->'payload'->>'url')>2000 or i->'payload'->>'url' !~ '^https://'))
        or (i->'payload' ? 'title' and (jsonb_typeof(i->'payload'->'title')<>'string' or char_length(i->'payload'->>'title')>20000))
        or (i->'payload'->'thumbnail' is not null and i->'payload'->'thumbnail'<>'null'::jsonb and (jsonb_typeof(i->'payload'->'thumbnail')<>'string' or char_length(i->'payload'->>'thumbnail')>4000 or i->'payload'->>'thumbnail' !~ '^https://'))
        or (i->'source_asset_id' is not null and i->'source_asset_id'<>'null'::jsonb and (jsonb_typeof(i->'source_asset_id')<>'string' or char_length(i->>'source_asset_id')>300))
        or octet_length((i->'payload')::text)>65536) then
      raise exception 'DD400:The backup contains an invalid saved post.';
    end if;
    -- Validate the standard fields but retain optional post fields for forwards compatibility.
    perform private.workspace_history_time(i->'payload'->'publishedAt',true),
      private.workspace_history_counter(i->'payload'->'views'),private.workspace_history_counter(i->'payload'->'likes'),
      private.workspace_history_counter(i->'payload'->'comments'),private.workspace_history_counter(i->'payload'->'shares'),
      private.workspace_history_counter(i->'payload'->'saves') from jsonb_array_elements(a->'pagePosts') i;
    select coalesce(jsonb_agg(jsonb_build_object('page_id',m.target,'post_id',i->>'post_id','source_asset_id',i->'source_asset_id',
      'observed_at',private.workspace_history_time(i->'observed_at'),
      'payload',((i->'payload')-'owner'-'tracked_account_id')||jsonb_build_object('pageId',m.target))),'[]') into page_posts
      from jsonb_array_elements(a->'pagePosts') i join jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid) on m.source=(i->>'page_id')::uuid;
    if (select count(distinct (i->>'page_id',i->>'post_id')) from jsonb_array_elements(page_posts) i)<>jsonb_array_length(page_posts) then
      raise exception 'DD400:The backup contains duplicate saved posts.';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('page_id',m.target,'observed_at',private.workspace_history_time(i->'observed_at'),
      'followers',private.workspace_history_counter(i->'followers'),'following',private.workspace_history_counter(i->'following'),
      'post_count',private.workspace_history_counter(i->'post_count'))),'[]') into account_samples
      from jsonb_array_elements(a->'accountSnapshots') i join jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid) on m.source=(i->>'page_id')::uuid;
    if (select count(distinct (i->>'page_id',((i->>'observed_at')::timestamptz at time zone 'UTC')::date)) from jsonb_array_elements(account_samples) i)<>jsonb_array_length(account_samples) then
      raise exception 'DD400:The backup contains duplicate daily account snapshots.';
    end if;

    if exists(select 1 from jsonb_array_elements(a->'postSnapshots') i where jsonb_typeof(i->'post_id') is distinct from 'string'
      or not exists(select 1 from jsonb_array_elements(a->'pagePosts') p where p->>'page_id'=i->>'page_id' and p->>'post_id'=i->>'post_id')) then
      raise exception 'DD400:Post history refers to a saved post missing from this backup.';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('page_id',m.target,'post_id',i->>'post_id','observed_at',private.workspace_history_time(i->'observed_at'),
      'views',private.workspace_history_counter(i->'views'),'likes',private.workspace_history_counter(i->'likes'),
      'comments',private.workspace_history_counter(i->'comments'),'shares',private.workspace_history_counter(i->'shares'),
      'saves',private.workspace_history_counter(i->'saves'))),'[]') into post_samples
      from jsonb_array_elements(a->'postSnapshots') i join jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid) on m.source=(i->>'page_id')::uuid;
    if (select count(distinct (i->>'page_id',i->>'post_id',((i->>'observed_at')::timestamptz at time zone 'UTC')::date)) from jsonb_array_elements(post_samples) i)<>jsonb_array_length(post_samples) then
      raise exception 'DD400:The backup contains duplicate daily post snapshots.';
    end if;

    if exists(select 1 from jsonb_array_elements(a->'alerts') i where (i->>'id') is null or (i->>'level') is null
      or i->>'level' not in ('red','amber','green') or jsonb_typeof(i->'type') is distinct from 'string' or i->>'type' !~ '^[a-z0-9_-]{1,64}$'
      or jsonb_typeof(i->'title') is distinct from 'string' or char_length(coalesce(i->>'title','')) not between 1 and 200 or jsonb_typeof(i->'details') is distinct from 'string'
      or char_length(i->>'details')>2000) then raise exception 'DD400:The backup contains an invalid alert.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('transfer_id',coalesce(nullif(i->>'transfer_id',''),i->>'id')::uuid,
      'page_id',m.target,'level',i->>'level','type',i->>'type','title',i->>'title','details',i->>'details',
      'created_at',private.workspace_history_time(i->'created_at'),'resolved_at',private.workspace_history_time(i->'resolved_at',true),
      'last_seen_at',private.workspace_history_time(i->'last_seen_at'))),'[]') into alert_rows
      from jsonb_array_elements(a->'alerts') i join jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid) on m.source=(i->>'page_id')::uuid;
    if (select count(distinct i->>'transfer_id') from jsonb_array_elements(alert_rows) i)<>jsonb_array_length(alert_rows)
      or exists(select 1 from jsonb_array_elements(alert_rows) i where i->'resolved_at'='null'::jsonb group by i->>'page_id',i->>'type' having count(*)>1)
      or exists(select 1 from jsonb_to_recordset(alert_rows) i(created_at timestamptz,resolved_at timestamptz,last_seen_at timestamptz)
        where i.last_seen_at<i.created_at or i.resolved_at<i.created_at) then
      raise exception 'DD400:The backup contains duplicate alerts or invalid alert dates.';
    end if;
  end if;
  normalized:=jsonb_build_object('pageMetadata',metadata,'pagePosts',page_posts,'accountSnapshots',account_samples,'postSnapshots',post_samples,'alerts',alert_rows);
  prepared:=prepared||jsonb_build_object('analytics',normalized,'summary',(prepared->'summary')||jsonb_build_object(
    'historyPosts',jsonb_array_length(page_posts),'accountSnapshots',jsonb_array_length(account_samples),
    'postSnapshots',jsonb_array_length(post_samples),'alerts',jsonb_array_length(alert_rows)));
  return prepared;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  raise exception 'DD400:The backup contains invalid analytics IDs, dates, or numbers.';
end; $$;

create function private.apply_workspace_analytics(p_owner uuid,p_analytics jsonb,p_overwrite boolean,p_page_map jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare i jsonb; matched uuid; portable uuid; collision uuid;
begin
  if p_analytics is null then return; end if;
  for i in select value from jsonb_array_elements(p_analytics->'pageMetadata') loop
    if p_overwrite or exists(select 1 from jsonb_to_recordset(p_page_map) m(target uuid,"isNew" boolean) where m.target=(i->>'page_id')::uuid and m."isNew") then
      update public.pages p set
        monthly_pay=case when i->'fields' ? 'monthly_pay' then (i->'fields'->>'monthly_pay')::numeric else p.monthly_pay end,
        editor=case when i->'fields' ? 'editor' then i->'fields'->>'editor' else p.editor end,
        start_date=case when i->'fields' ? 'start_date' then (i->'fields'->>'start_date')::date else p.start_date end,
        active=case when i->'fields' ? 'active' then (i->'fields'->>'active')::boolean else p.active end,
        notes=case when i->'fields' ? 'notes' then i->'fields'->>'notes' else p.notes end
      where p.id=(i->>'page_id')::uuid and p.owner=p_owner;
    end if;
  end loop;
  insert into public.page_posts(owner,page_id,post_id,payload,source_asset_id,observed_at)
    select p_owner,i.page_id,i.post_id,i.payload,i.source_asset_id,i.observed_at
    from jsonb_to_recordset(p_analytics->'pagePosts') i(page_id uuid,post_id text,payload jsonb,source_asset_id text,observed_at timestamptz)
    join public.pages p on p.id=i.page_id and p.owner=p_owner
    on conflict(page_id,post_id) do update set payload=excluded.payload,source_asset_id=excluded.source_asset_id,observed_at=excluded.observed_at
      where p_overwrite or exists(select 1 from jsonb_to_recordset(p_page_map) m(target uuid,"isNew" boolean) where m.target=excluded.page_id and m."isNew");
  insert into public.account_snapshots(owner,page_id,observed_at,followers,following,post_count)
    select p_owner,i.page_id,i.observed_at,i.followers,i.following,i.post_count
    from jsonb_to_recordset(p_analytics->'accountSnapshots') i(page_id uuid,observed_at timestamptz,followers bigint,following bigint,post_count bigint)
    join public.pages p on p.id=i.page_id and p.owner=p_owner
    on conflict(page_id,sample_day) do update set observed_at=excluded.observed_at,followers=excluded.followers,following=excluded.following,post_count=excluded.post_count
      where p_overwrite or exists(select 1 from jsonb_to_recordset(p_page_map) m(target uuid,"isNew" boolean) where m.target=excluded.page_id and m."isNew");
  insert into public.post_snapshots(owner,page_id,post_id,observed_at,views,likes,comments,shares,saves)
    select p_owner,i.page_id,i.post_id,i.observed_at,i.views,i.likes,i.comments,i.shares,i.saves
    from jsonb_to_recordset(p_analytics->'postSnapshots') i(page_id uuid,post_id text,observed_at timestamptz,views bigint,likes bigint,comments bigint,shares bigint,saves bigint)
    join public.pages p on p.id=i.page_id and p.owner=p_owner
    on conflict(page_id,post_id,sample_day) do update set observed_at=excluded.observed_at,views=excluded.views,likes=excluded.likes,comments=excluded.comments,shares=excluded.shares,saves=excluded.saves
      where p_overwrite or exists(select 1 from jsonb_to_recordset(p_page_map) m(target uuid,"isNew" boolean) where m.target=excluded.page_id and m."isNew");
  for i in select value from jsonb_array_elements(p_analytics->'alerts') loop
    portable:=(i->>'transfer_id')::uuid; matched:=null; collision:=null;
    select id into matched from public.alerts where owner=p_owner and transfer_id=portable;
    if i->'resolved_at'='null'::jsonb then
      select id into collision from public.alerts where owner=p_owner and page_id=(i->>'page_id')::uuid and type=i->>'type' and resolved_at is null;
    end if;
    if matched is not null and collision is not null and matched<>collision then
      if not p_overwrite then continue; end if;
      raise exception 'DD409:An imported alert conflicts with another active alert. Keep existing values or resolve that alert first.';
    end if;
    matched:=coalesce(matched,collision);
    if matched is null then
      insert into public.alerts(owner,page_id,transfer_id,level,type,title,details,created_at,resolved_at,last_seen_at)
        values(p_owner,(i->>'page_id')::uuid,portable,i->>'level',i->>'type',i->>'title',i->>'details',(i->>'created_at')::timestamptz,(i->>'resolved_at')::timestamptz,(i->>'last_seen_at')::timestamptz);
    elsif p_overwrite then
      update public.alerts set transfer_id=portable,page_id=(i->>'page_id')::uuid,level=i->>'level',type=i->>'type',title=i->>'title',details=i->>'details',
        created_at=(i->>'created_at')::timestamptz,resolved_at=(i->>'resolved_at')::timestamptz,last_seen_at=(i->>'last_seen_at')::timestamptz
        where id=matched and owner=p_owner;
    end if;
  end loop;
end; $$;

alter function public.desk_workspace_transfer(uuid,text,uuid,jsonb) rename to desk_workspace_transfer_v1;
-- The old dispatcher remains an implementation detail, not an extra Data API RPC.
alter function public.desk_workspace_transfer_v1(uuid,text,uuid,jsonb) set schema private;
create function public.desk_workspace_transfer(p_owner uuid,p_action text,p_job uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job private.workspace_transfers%rowtype; archive jsonb; raw bytea; result jsonb; analytics jsonb; page_map jsonb; collection_map jsonb;
begin
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  if p_action='begin_export' then
    delete from private.workspace_transfers where expires_at<now();
    if (select count(*) from private.workspace_transfers where owner=p_owner and state<>'done')>=3 then raise exception 'DD409:Finish or cancel an open transfer before starting another.'; end if;
    -- All collections, current data and historical data share one MVCC snapshot.
    select jsonb_build_object('format','distribution-desk.workspace','version',1,'exportedAt',now(),'workspace',jsonb_build_object(
      'collections',coalesce((select jsonb_agg(to_jsonb(c)-'owner' order by c.created_at,c.id) from public.collections c where c.owner=p_owner),'[]'),
      'pages',coalesce((select jsonb_agg(to_jsonb(p)-'owner'-'locked_until'-'tracked_account_id' order by p.id) from public.pages p where p.owner=p_owner),'[]'),
      'memberships',coalesce((select jsonb_agg(to_jsonb(m)-'owner' order by m.collection_id,m.page_id) from public.memberships m where m.owner=p_owner),'[]'),
      'settings',coalesce((select jsonb_build_object('provider',s.provider,'post_limit',s.post_limit,'request_limit',s.request_limit) from public.settings s where s.owner=p_owner),'{"provider":"tikhub","post_limit":30,"request_limit":500}'),
      'analytics',jsonb_build_object('version',1,
        'pagePosts',coalesce((select jsonb_agg(to_jsonb(p)-'owner'-'created_at' order by p.page_id,p.post_id) from public.page_posts p where p.owner=p_owner),'[]'),
        'accountSnapshots',coalesce((select jsonb_agg(to_jsonb(s)-'owner'-'sample_day' order by s.page_id,s.observed_at) from public.account_snapshots s where s.owner=p_owner),'[]'),
        'postSnapshots',coalesce((select jsonb_agg(to_jsonb(s)-'owner'-'sample_day' order by s.page_id,s.post_id,s.observed_at) from public.post_snapshots s where s.owner=p_owner),'[]'),
        'alerts',coalesce((select jsonb_agg(to_jsonb(a)-'owner' order by a.created_at,a.id) from public.alerts a where a.owner=p_owner),'[]')))) into archive;
    raw:=convert_to(archive::text,'UTF8');
    if octet_length(raw)>102760448 then raise exception 'DD400:This workspace exceeds the 98 MB backup limit.'; end if;
    insert into private.workspace_transfers(owner,direction,state,bytes,total,data)
      values(p_owner,'export','ready',octet_length(raw),ceil(octet_length(raw)/524288.0)::integer,raw) returning * into job;
    return jsonb_build_object('job',job.id,'bytes',job.bytes,'total',job.total);
  end if;
  if p_action='apply' then
    select * into job from private.workspace_transfers where id=p_job and owner=p_owner and expires_at>=now() for update;
    if found and job.state='ready' and job.direction='import' then
      analytics:=job.meta->'analytics';
      -- A matching record may have been removed since preview. The owner lock
      -- makes these flags reflect the records actually present at commit.
      select coalesce(jsonb_agg(i||jsonb_build_object('isNew',not exists(select 1 from public.pages p where p.id=(i->>'target')::uuid and p.owner=p_owner))),'[]')
        into page_map from jsonb_array_elements(job.meta->'pages') i;
      select coalesce(jsonb_agg(i||jsonb_build_object('isNew',not exists(select 1 from public.collections c where c.id=(i->>'target')::uuid and c.owner=p_owner))),'[]')
        into collection_map from jsonb_array_elements(job.meta->'collections') i;
      update private.workspace_transfers set meta=meta||jsonb_build_object('pages',page_map,'collections',collection_map) where id=p_job and owner=p_owner;
    end if;
  end if;
  result:=private.desk_workspace_transfer_v1(p_owner,p_action,p_job,p_data);
  if p_action='apply' and analytics is not null then
    perform private.apply_workspace_analytics(p_owner,analytics,coalesce((p_data->>'overwrite')::boolean,false),page_map);
    -- The original dispatcher caches the result before this same transaction commits.
    -- A failure here rolls back its changes too; retries return only committed data.
    update private.workspace_transfers set meta=result where id=p_job and owner=p_owner and state='done';
  end if;
  return result;
end; $$;

revoke all on function private.workspace_history_counter(jsonb),private.workspace_history_time(jsonb,boolean),
  private.prepare_workspace_import_v1(uuid,jsonb),private.prepare_workspace_import(uuid,jsonb),
  private.apply_workspace_analytics(uuid,jsonb,boolean,jsonb),private.desk_workspace_transfer_v1(uuid,text,uuid,jsonb),
  public.desk_workspace_transfer(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.workspace_history_counter(jsonb),private.workspace_history_time(jsonb,boolean),
  private.prepare_workspace_import_v1(uuid,jsonb),private.prepare_workspace_import(uuid,jsonb),
  private.apply_workspace_analytics(uuid,jsonb,boolean,jsonb),private.desk_workspace_transfer_v1(uuid,text,uuid,jsonb),
  public.desk_workspace_transfer(uuid,text,uuid,jsonb) to service_role;
