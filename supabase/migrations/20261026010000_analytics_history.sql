-- Analytics V2. Apply once after the preceding migrations.
-- Cached provider responses are shared; customer history and business metadata
-- are owner-scoped so an imported archive can never rewrite another workspace.
create table public.tracked_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram','youtube','tiktok')),
  handle text not null check (char_length(handle) between 1 and 100),
  canonical_id text,
  name text not null default '' check (char_length(name)<=300),
  latest_payload jsonb check (latest_payload is null or jsonb_typeof(latest_payload)='object'),
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  status text not null default 'pending' check (char_length(status)<=40),
  error text check (error is null or char_length(error)<=500),
  locked_until bigint not null default 0 check (locked_until between 0 and 9007199254740991),
  unique(platform,handle)
);
create index tracked_accounts_native_idx on public.tracked_accounts(platform,canonical_id) where canonical_id is not null;
create index tracked_accounts_due_idx on public.tracked_accounts(fetched_at nulls first);

alter table public.pages
  add column monthly_pay numeric(14,2) check (monthly_pay is null or monthly_pay between 0 and 999999999999.99),
  add column editor text not null default '' check (char_length(editor)<=150),
  add column start_date date,
  add column active boolean not null default true,
  add column notes text not null default '' check (char_length(notes)<=2000),
  add column tracked_account_id uuid references public.tracked_accounts(id) on delete set null;
create index pages_tracked_account_idx on public.pages(tracked_account_id) where tracked_account_id is not null;

create table public.page_posts (
  owner uuid not null,
  page_id uuid not null,
  post_id text not null check (char_length(post_id) between 1 and 300),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  source_asset_id text check (source_asset_id is null or char_length(source_asset_id)<=300),
  created_at timestamptz not null default now(),
  observed_at timestamptz not null default now(),
  primary key(page_id,post_id),
  foreign key(page_id,owner) references public.pages(id,owner) on delete cascade
);
create index page_posts_owner_idx on public.page_posts(owner,page_id);

create table public.account_snapshots (
  owner uuid not null,
  page_id uuid not null,
  observed_at timestamptz not null,
  sample_day date generated always as ((observed_at at time zone 'UTC')::date) stored,
  followers bigint check (followers between 0 and 9007199254740991),
  following bigint check (following between 0 and 9007199254740991),
  post_count bigint check (post_count between 0 and 9007199254740991),
  primary key(page_id,sample_day),
  foreign key(page_id,owner) references public.pages(id,owner) on delete cascade
);
create index account_snapshots_owner_time_idx on public.account_snapshots(owner,observed_at,page_id);

create table public.post_snapshots (
  owner uuid not null,
  page_id uuid not null,
  post_id text not null check (char_length(post_id) between 1 and 300),
  observed_at timestamptz not null,
  sample_day date generated always as ((observed_at at time zone 'UTC')::date) stored,
  views bigint check (views between 0 and 9007199254740991),
  likes bigint check (likes between 0 and 9007199254740991),
  comments bigint check (comments between 0 and 9007199254740991),
  shares bigint check (shares between 0 and 9007199254740991),
  saves bigint check (saves between 0 and 9007199254740991),
  primary key(page_id,post_id,sample_day),
  foreign key(page_id,owner) references public.pages(id,owner) on delete cascade
);
create index post_snapshots_owner_time_idx on public.post_snapshots(owner,observed_at,page_id);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  page_id uuid not null,
  level text not null check (level in ('red','amber','green')),
  type text not null check (type ~ '^[a-z0-9_-]{1,64}$'),
  title text not null check (char_length(title) between 1 and 200),
  details text not null default '' check (char_length(details)<=2000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  last_seen_at timestamptz not null default now(),
  foreign key(page_id,owner) references public.pages(id,owner) on delete cascade
);
create unique index alerts_open_unique on public.alerts(owner,page_id,type) where resolved_at is null;
create index alerts_owner_time_idx on public.alerts(owner,created_at desc);
create table private.alert_checks (
  owner uuid not null,
  page_id uuid not null,
  type text not null,
  checks integer not null default 1 check (checks between 0 and 2),
  last_seen_at timestamptz not null,
  last_alert_at timestamptz,
  primary key(owner,page_id,type),
  foreign key(page_id,owner) references public.pages(id,owner) on delete cascade
);

create table public.provider_settings (
  id boolean primary key default true check (id),
  provider_order jsonb not null default '{"youtube":["youtube-official","tikhub"],"instagram":["hikerapi","tikhub","scrapecreators"],"tiktok":["lamatok","tikhub"]}'::jsonb check (jsonb_typeof(provider_order)='object'),
  monthly_request_cap integer not null default 25000 check (monthly_request_cap between 1 and 1000000),
  monthly_budget_usd numeric(12,6) not null default 25 check (monthly_budget_usd between 0 and 25),
  request_costs jsonb not null default '{"youtube-official":0,"hikerapi":0.02,"lamatok":0.02,"tikhub":0.001,"scrapecreators":0.001}'::jsonb check (jsonb_typeof(request_costs)='object'),
  refresh_enabled boolean not null default false,
  refresh_interval_hours integer not null default 24 check (refresh_interval_hours between 1 and 168)
);
insert into public.provider_settings(id) values(true);
create table public.provider_requests (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,64}$'),
  platform text not null check (platform in ('instagram','youtube','tiktok')),
  endpoint text not null check (char_length(endpoint) between 1 and 300 and endpoint like '/%' and endpoint !~ '[?#]'),
  funding text not null default 'platform' check (funding in ('platform','workspace')),
  owner uuid references public.users(id) on delete set null,
  success boolean,
  latency_ms integer check (latency_ms between 0 and 300000),
  estimated_cost_usd numeric(12,6) not null default 0 check (estimated_cost_usd between 0 and 25),
  created_at timestamptz not null default now(),
  raw_response jsonb check (raw_response is null or octet_length(raw_response::text)<=65536),
  error text check (error is null or char_length(error)<=500)
);
create index provider_requests_month_idx on public.provider_requests(created_at,funding);
create index provider_requests_provider_idx on public.provider_requests(provider,created_at desc);

alter table public.tracked_accounts enable row level security;
alter table public.page_posts enable row level security;
alter table public.account_snapshots enable row level security;
alter table public.post_snapshots enable row level security;
alter table public.alerts enable row level security;
alter table private.alert_checks enable row level security;
alter table public.provider_settings enable row level security;
alter table public.provider_requests enable row level security;
revoke all on public.tracked_accounts,public.page_posts,public.account_snapshots,public.post_snapshots,
  public.alerts,private.alert_checks,public.provider_settings,public.provider_requests from public,anon,authenticated;
grant select,insert,update,delete on public.tracked_accounts,public.page_posts,public.account_snapshots,public.post_snapshots,
  public.alerts,private.alert_checks,public.provider_settings,public.provider_requests to service_role;
grant select on public.page_posts,public.account_snapshots,public.post_snapshots,public.alerts to authenticated;
create policy page_posts_read on public.page_posts for select to authenticated using(owner=(select auth.uid()) or (select private.is_admin()));
create policy account_snapshots_read on public.account_snapshots for select to authenticated using(owner=(select auth.uid()) or (select private.is_admin()));
create policy post_snapshots_read on public.post_snapshots for select to authenticated using(owner=(select auth.uid()) or (select private.is_admin()));
create policy alerts_read on public.alerts for select to authenticated using(owner=(select auth.uid()) or (select private.is_admin()));

-- Linking a customer's handle must not overwrite the global network cache.
create function private.link_tracked_account() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.tracked_account_id is null or (tg_op='UPDATE' and (new.platform is distinct from old.platform or new.handle is distinct from old.handle)) then
    insert into public.tracked_accounts(platform,handle) values(new.platform,new.handle) on conflict(platform,handle) do nothing;
    select id into new.tracked_account_id from public.tracked_accounts where platform=new.platform and handle=new.handle;
  end if;
  return new;
end;
$$;
revoke all on function private.link_tracked_account() from public,anon,authenticated;
grant execute on function private.link_tracked_account() to service_role;
create trigger desk_link_tracked_account before insert or update of platform,handle,tracked_account_id on public.pages
for each row execute function private.link_tracked_account();
insert into public.tracked_accounts(platform,handle) select distinct platform,handle from public.pages on conflict do nothing;
update public.pages p set tracked_account_id=a.id from public.tracked_accounts a
where p.tracked_account_id is null and a.platform=p.platform and a.handle=p.handle;

create function private.desk_safe_timestamp(p_value jsonb) returns timestamptz language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(p_value)<>'string' or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T'
    or (p_value #>> '{}') !~ '(Z|[+-]\d{2}:\d{2})$' then return null; end if;
  return (p_value #>> '{}')::timestamptz;
exception when others then return null;
end;
$$;
revoke all on function private.desk_safe_timestamp(jsonb) from public,anon,authenticated;
grant execute on function private.desk_safe_timestamp(jsonb) to service_role;

create function public.desk_record_page_history(p_owner uuid,p_page uuid) returns void language plpgsql security invoker set search_path='' as $$
declare r public.pages%rowtype; item jsonb; post_key text; published timestamptz; latest timestamptz;
begin
  select * into r from public.pages where id=p_page and owner=p_owner;
  if not found then raise exception 'DD404:Page not found.'; end if;
  if r.last_synced_at is null then return; end if;
  insert into public.account_snapshots(owner,page_id,observed_at,followers,following,post_count)
    values(r.owner,r.id,r.last_synced_at,r.followers,private.desk_safe_count(r.overall->'following',true),private.desk_safe_count(r.overall->'posts',true))
    on conflict(page_id,sample_day) do nothing;
  for item in select value from jsonb_array_elements(r.posts) loop
    if jsonb_typeof(item)<>'object' then continue; end if;
    post_key:=item->>'id';
    if post_key is null or char_length(post_key) not between 1 and 300 then continue; end if;
    item:=item || jsonb_build_object('pageId',r.id);
    insert into public.page_posts(owner,page_id,post_id,payload,source_asset_id,observed_at)
      values(r.owner,r.id,post_key,item,null,r.last_synced_at)
      on conflict(page_id,post_id) do update set payload=excluded.payload,observed_at=excluded.observed_at
      where excluded.observed_at>=public.page_posts.observed_at;
    published:=private.desk_safe_timestamp(item->'publishedAt');
    select max(observed_at) into latest from public.post_snapshots where page_id=r.id and post_id=post_key;
    -- New rows are observations now, never a claim about an earlier post age.
    if latest is null or (published is not null and r.last_synced_at>=published and
       (r.last_synced_at<=published+interval '30 days' or
        (r.last_synced_at<=published+interval '90 days' and r.last_synced_at>=latest+interval '7 days'))) then
      insert into public.post_snapshots(owner,page_id,post_id,observed_at,views,likes,comments,shares,saves)
        values(r.owner,r.id,post_key,r.last_synced_at,
          private.desk_safe_count(item->'views'),private.desk_safe_count(item->'likes'),private.desk_safe_count(item->'comments'),
          private.desk_safe_count(item->'shares'),private.desk_safe_count(item->'saves'))
        on conflict(page_id,post_id,sample_day) do nothing;
    end if;
  end loop;
end;
$$;
revoke all on function public.desk_record_page_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.desk_record_page_history(uuid,uuid) to service_role;
create function private.capture_page_history() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.last_synced_at is not null and (tg_op='INSERT' or new.last_synced_at is distinct from old.last_synced_at or new.posts is distinct from old.posts) then
    perform public.desk_record_page_history(new.owner,new.id);
  end if;
  return new;
end;
$$;
revoke all on function private.capture_page_history() from public,anon,authenticated;
grant execute on function private.capture_page_history() to service_role;
create trigger desk_capture_page_history after insert or update of last_synced_at,posts on public.pages
for each row execute function private.capture_page_history();
do $$ declare r record; begin
  for r in select id,owner from public.pages where last_synced_at is not null loop
    perform public.desk_record_page_history(r.owner,r.id);
  end loop;
end $$;

-- Keep the original lease/canonical checks, and move owner-scoped history in
-- the same transaction before the original operation removes an alias.
alter function public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb) rename to desk_save_refresh_before_history;
alter function public.desk_save_refresh_before_history(uuid,uuid,uuid,bigint,jsonb) set schema private;
revoke all on function private.desk_save_refresh_before_history(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function private.desk_save_refresh_before_history(uuid,uuid,uuid,bigint,jsonb) to service_role;
create function public.desk_save_refresh(p_owner uuid,p_source uuid,p_target uuid,p_lease bigint,p_snapshot jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.users where id=p_owner for update;
  if p_source<>p_target and exists(select 1 from public.pages where id=p_source and owner=p_owner)
    and exists(select 1 from public.pages where id=p_target and owner=p_owner) then
    insert into public.page_posts(owner,page_id,post_id,payload,source_asset_id,observed_at)
      select owner,p_target,post_id,payload||jsonb_build_object('pageId',p_target),source_asset_id,observed_at
      from public.page_posts where owner=p_owner and page_id=p_source
      on conflict(page_id,post_id) do update set payload=excluded.payload,observed_at=excluded.observed_at,
        source_asset_id=coalesce(public.page_posts.source_asset_id,excluded.source_asset_id)
      where excluded.observed_at>public.page_posts.observed_at;
    insert into public.account_snapshots(owner,page_id,observed_at,followers,following,post_count)
      select owner,p_target,observed_at,followers,following,post_count from public.account_snapshots where owner=p_owner and page_id=p_source
      on conflict(page_id,sample_day) do nothing;
    insert into public.post_snapshots(owner,page_id,post_id,observed_at,views,likes,comments,shares,saves)
      select owner,p_target,post_id,observed_at,views,likes,comments,shares,saves from public.post_snapshots where owner=p_owner and page_id=p_source
      on conflict(page_id,post_id,sample_day) do nothing;
    -- Keep resolved alert history too. If both aliases have the same open alert,
    -- retain the target's open item and close (rather than delete) the source one.
    update public.alerts source set resolved_at=now() where source.owner=p_owner and source.page_id=p_source and source.resolved_at is null
      and exists(select 1 from public.alerts target where target.owner=p_owner and target.page_id=p_target and target.type=source.type and target.resolved_at is null);
    update public.alerts set page_id=p_target where owner=p_owner and page_id=p_source;
    insert into private.alert_checks(owner,page_id,type,checks,last_seen_at,last_alert_at)
      select owner,p_target,type,checks,last_seen_at,last_alert_at from private.alert_checks where owner=p_owner and page_id=p_source
      on conflict(owner,page_id,type) do update set
        checks=case when excluded.last_seen_at>private.alert_checks.last_seen_at then excluded.checks else private.alert_checks.checks end,
        last_seen_at=greatest(private.alert_checks.last_seen_at,excluded.last_seen_at),
        last_alert_at=greatest(private.alert_checks.last_alert_at,excluded.last_alert_at);
    update public.pages target set monthly_pay=coalesce(target.monthly_pay,source.monthly_pay),
      editor=case when target.editor='' then source.editor else target.editor end,
      start_date=coalesce(target.start_date,source.start_date),notes=case when target.notes='' then source.notes else target.notes end
      from public.pages source where target.id=p_target and target.owner=p_owner and source.id=p_source and source.owner=p_owner;
  end if;
  return private.desk_save_refresh_before_history(p_owner,p_source,p_target,p_lease,p_snapshot);
end;
$$;
revoke all on function public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb) to service_role;

create function public.desk_reserve_provider_request(p_provider text,p_platform text,p_endpoint text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare config public.provider_settings%rowtype; used bigint; spent numeric; cost numeric; request_id uuid;
begin
  select * into config from public.provider_settings where id=true for update;
  if not found then raise exception 'DD400:Provider settings are not configured.'; end if;
  if p_platform is null or p_platform not in ('instagram','youtube','tiktok') or p_provider is null or p_provider !~ '^[a-z0-9_-]{1,64}$'
    or not coalesce(config.provider_order->p_platform @> jsonb_build_array(p_provider),false)
    or jsonb_typeof(config.request_costs->p_provider) is distinct from 'number' then
    raise exception 'DD400:This provider is not enabled for the selected platform.';
  end if;
  cost:=(config.request_costs->>p_provider)::numeric;
  if cost<0 or cost>25 then raise exception 'DD400:Choose a valid estimated request cost.'; end if;
  if p_endpoint is null or char_length(p_endpoint) not between 1 and 300 or p_endpoint not like '/%' or p_endpoint ~ '[?#]' then
    raise exception 'DD400:Only a sanitized provider endpoint path may be logged.';
  end if;
  select count(*),coalesce(sum(estimated_cost_usd),0) into used,spent from public.provider_requests
    where funding='platform' and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
      and created_at<(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC';
  if used>=config.monthly_request_cap or spent+cost>config.monthly_budget_usd then return null; end if;
  insert into public.provider_requests(provider,platform,endpoint,estimated_cost_usd)
    values(p_provider,p_platform,p_endpoint,cost) returning id into request_id;
  return request_id;
end;
$$;
revoke all on function public.desk_reserve_provider_request(text,text,text) from public,anon,authenticated;
grant execute on function public.desk_reserve_provider_request(text,text,text) to service_role;

create function public.desk_provider_usage() returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('requests',count(*),'estimatedCostUsd',coalesce(sum(estimated_cost_usd),0),
    'month',to_char(now() at time zone 'UTC','YYYY-MM'))
  from public.provider_requests where funding='platform'
    and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
    and created_at<(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC';
$$;
revoke all on function public.desk_provider_usage() from public,anon,authenticated;
grant execute on function public.desk_provider_usage() to service_role;

create function public.desk_cleanup_provider_logs() returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  update public.provider_requests set raw_response=null where raw_response is not null and created_at<now()-interval '7 days';
  get diagnostics changed=row_count;
  return changed;
end;
$$;
revoke all on function public.desk_cleanup_provider_logs() from public,anon,authenticated;
grant execute on function public.desk_cleanup_provider_logs() to service_role;

create function public.desk_reconcile_alerts(p_owner uuid,p_candidates jsonb,p_observed_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare candidate jsonb; page_key uuid; check_row private.alert_checks%rowtype; next_count integer; opened integer:=0; resolved integer:=0; changed integer;
begin
  if p_observed_at is null or p_observed_at>now()+interval '5 minutes' or p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>5000 then
    raise exception 'DD400:Invalid alert check.';
  end if;
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(candidate)<>'object' or coalesce(candidate->>'pageId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(candidate->>'type','') !~ '^[a-z0-9_-]{1,64}$' or coalesce(candidate->>'level','') not in ('red','amber','green')
      or char_length(coalesce(candidate->>'title','')) not between 1 and 200 or char_length(coalesce(candidate->>'details',''))>2000 then
      raise exception 'DD400:Invalid alert candidate.';
    end if;
    if not exists(select 1 from public.pages where id=(candidate->>'pageId')::uuid and owner=p_owner) then raise exception 'DD404:Page not found.'; end if;
  end loop;
  for candidate in select distinct on(value->>'pageId',value->>'type') value from jsonb_array_elements(p_candidates) order by value->>'pageId',value->>'type' loop
    page_key:=(candidate->>'pageId')::uuid;
    select * into check_row from private.alert_checks where owner=p_owner and page_id=page_key and type=candidate->>'type' for update;
    if found and p_observed_at<=check_row.last_seen_at then continue; end if;
    if not found or check_row.checks=0 or p_observed_at-check_row.last_seen_at>interval '2 days' then next_count:=1;
    elsif (p_observed_at at time zone 'UTC')::date>(check_row.last_seen_at at time zone 'UTC')::date then next_count:=least(2,check_row.checks+1);
    else next_count:=check_row.checks; end if;
    insert into private.alert_checks(owner,page_id,type,checks,last_seen_at) values(p_owner,page_key,candidate->>'type',next_count,p_observed_at)
      on conflict(owner,page_id,type) do update set checks=excluded.checks,last_seen_at=excluded.last_seen_at;
    update public.alerts set last_seen_at=p_observed_at,title=candidate->>'title',details=coalesce(candidate->>'details',''),level=candidate->>'level'
      where owner=p_owner and page_id=page_key and type=candidate->>'type' and resolved_at is null and last_seen_at<=p_observed_at;
    if next_count>=2 and (check_row.last_alert_at is null or p_observed_at>=check_row.last_alert_at+interval '3 days') then
      insert into public.alerts(owner,page_id,level,type,title,details,created_at,last_seen_at)
        values(p_owner,page_key,candidate->>'level',candidate->>'type',candidate->>'title',coalesce(candidate->>'details',''),p_observed_at,p_observed_at)
        on conflict(owner,page_id,type) where resolved_at is null do nothing;
      get diagnostics changed=row_count; opened:=opened+changed;
      if changed>0 then update private.alert_checks set last_alert_at=p_observed_at where owner=p_owner and page_id=page_key and type=candidate->>'type'; end if;
    end if;
  end loop;
  update public.alerts a set resolved_at=p_observed_at where a.owner=p_owner and a.resolved_at is null and a.last_seen_at<p_observed_at
    and not exists(select 1 from jsonb_array_elements(p_candidates) c where c->>'pageId'=a.page_id::text and c->>'type'=a.type);
  get diagnostics resolved=row_count;
  update private.alert_checks a set checks=0,last_seen_at=p_observed_at where a.owner=p_owner and a.last_seen_at<p_observed_at
    and not exists(select 1 from jsonb_array_elements(p_candidates) c where c->>'pageId'=a.page_id::text and c->>'type'=a.type);
  return jsonb_build_object('opened',opened,'resolved',resolved);
end;
$$;
revoke all on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz) to service_role;
