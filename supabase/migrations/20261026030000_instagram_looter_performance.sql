-- Instagram Looter credentials and measured query-path improvements.
-- Apply once after 20261026020000_analytics_transfer.sql. This transaction
-- blocks provider-log writes while backfilling counters; no requests can fall
-- between the backfill and trigger installation. Existing settings stay intact.
begin;

alter table public.provider_settings
  add column rapidapi_key text not null default '' check (char_length(rapidapi_key)<=8192);
comment on column public.provider_settings.rapidapi_key is
  'Application-encrypted RapidAPI credential. Never return this column through an API or backup.';
update public.provider_settings
set request_costs = '{"instagram-looter":0.000660}'::jsonb || request_costs
where id=true;
-- No automatic provider switch or scheduled refresh enablement.
revoke all on public.provider_settings from public, anon, authenticated;

-- Owner-filtered, stable ordering used by the analytics cursor queries.
-- The replaced indexes were strict prefixes of the new indexes.
create index page_posts_owner_page_post_idx on public.page_posts(owner,page_id,post_id) include(created_at);
drop index public.page_posts_owner_idx;
create index account_snapshots_owner_page_time_idx on public.account_snapshots(owner,page_id,observed_at);
create index post_snapshots_owner_page_time_post_idx on public.post_snapshots(owner,page_id,observed_at,post_id);
create index alerts_owner_created_id_idx on public.alerts(owner,created_at,id);
drop index public.alerts_owner_time_idx;
create index memberships_owner_collection_page_idx on public.memberships(owner,collection_id,page_id);
drop index public.memberships_owner_collection_idx;

-- The scheduler orders attempts, not fetched_at, and reads only active owners.
create index tracked_accounts_attempt_id_idx on public.tracked_accounts(last_attempt_at nulls first,id);
create index pages_active_tracked_id_idx on public.pages(tracked_account_id,id)
  include(owner,last_synced_at) where active=true and tracked_account_id is not null;
create index pages_failed_sync_idx on public.pages(last_synced_at nulls first,id)
  where sync_error is not null and sync_error<>'';
-- Cleanup runs before provider traffic. Do not repeatedly scan retained logs
-- whose raw responses were already cleared.
create index provider_requests_raw_retention_idx on public.provider_requests(created_at)
  where raw_response is not null;

lock table public.provider_requests in share row exclusive mode;
create table private.provider_monthly_usage (
  month date primary key check (extract(day from month)=1),
  requests bigint not null check (requests>=0),
  estimated_cost_usd numeric(20,6) not null check (estimated_cost_usd>=0)
);
alter table private.provider_monthly_usage enable row level security;
revoke all on private.provider_monthly_usage from public, anon, authenticated;
grant select,insert,update,delete on private.provider_monthly_usage to service_role;
insert into private.provider_monthly_usage(month,requests,estimated_cost_usd)
select date_trunc('month',created_at at time zone 'UTC')::date,count(*),sum(estimated_cost_usd)
from public.provider_requests where funding='platform'
group by 1;

-- Maintain exact totals for inserts, corrections and deletions. Same-month
-- corrections apply one delta; cross-month updates lock buckets in date order
-- so two corrections moving in opposite directions cannot deadlock each other.
create function private.maintain_provider_monthly_usage()
returns trigger language plpgsql security invoker set search_path='' as $$
declare old_month date; new_month date; old_cost numeric:=0; new_cost numeric:=0;
begin
  if tg_op<>'INSERT' and old.funding='platform' then
    old_month:=date_trunc('month',old.created_at at time zone 'UTC')::date;
    old_cost:=old.estimated_cost_usd;
  end if;
  if tg_op<>'DELETE' and new.funding='platform' then
    new_month:=date_trunc('month',new.created_at at time zone 'UTC')::date;
    new_cost:=new.estimated_cost_usd;
  end if;
  if old_month is not distinct from new_month then
    if new_month is not null and new_cost<>old_cost then
      update private.provider_monthly_usage set estimated_cost_usd=estimated_cost_usd+new_cost-old_cost where month=new_month;
    end if;
    return null;
  end if;
  -- Seed/lock in deterministic order, including previously empty UTC months.
  insert into private.provider_monthly_usage(month,requests,estimated_cost_usd)
    select distinct m,0,0 from unnest(array[old_month,new_month]) m where m is not null order by m
    on conflict(month) do nothing;
  perform 1 from private.provider_monthly_usage where month in (old_month,new_month) order by month for update;
  if old_month is not null then
    update private.provider_monthly_usage set requests=requests-1,estimated_cost_usd=estimated_cost_usd-old_cost where month=old_month;
  end if;
  if new_month is not null then
    update private.provider_monthly_usage set requests=requests+1,estimated_cost_usd=estimated_cost_usd+new_cost where month=new_month;
  end if;
  return null;
end;
$$;
revoke all on function private.maintain_provider_monthly_usage() from public,anon,authenticated;
grant execute on function private.maintain_provider_monthly_usage() to service_role;
create trigger provider_usage_insert after insert on public.provider_requests
for each row execute function private.maintain_provider_monthly_usage();
create trigger provider_usage_delete after delete on public.provider_requests
for each row execute function private.maintain_provider_monthly_usage();
create trigger provider_usage_update after update of funding,created_at,estimated_cost_usd on public.provider_requests
for each row execute function private.maintain_provider_monthly_usage();

-- Same interface and cap semantics, now using one monthly counter lookup
-- instead of count/sum over the entire month for every HTTP attempt.
create or replace function public.desk_reserve_provider_request(p_provider text,p_platform text,p_endpoint text)
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
  select requests,estimated_cost_usd into used,spent from private.provider_monthly_usage
    where month=date_trunc('month',now() at time zone 'UTC')::date;
  if coalesce(used,0)>=config.monthly_request_cap or coalesce(spent,0)+cost>config.monthly_budget_usd then return null; end if;
  insert into public.provider_requests(provider,platform,endpoint,estimated_cost_usd)
    values(p_provider,p_platform,p_endpoint,cost) returning id into request_id;
  return request_id;
end;
$$;
revoke all on function public.desk_reserve_provider_request(text,text,text) from public,anon,authenticated;
grant execute on function public.desk_reserve_provider_request(text,text,text) to service_role;

create or replace function public.desk_provider_usage() returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('requests',coalesce(u.requests,0),'estimatedCostUsd',coalesce(u.estimated_cost_usd,0),
    'month',to_char(now() at time zone 'UTC','YYYY-MM'))
  from (select date_trunc('month',now() at time zone 'UTC')::date as month) m
  left join private.provider_monthly_usage u using(month);
$$;
revoke all on function public.desk_provider_usage() from public,anon,authenticated;
grant execute on function public.desk_provider_usage() to service_role;

commit;
