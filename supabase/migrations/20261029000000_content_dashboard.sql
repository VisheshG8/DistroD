-- Content Dashboard: Page Master fields, pay end dates, per-page alert settings,
-- content links and alert reconciliation that keeps unchecked pages open.
-- Apply after 20261026030000_instagram_looter_performance.sql. Every statement is
-- idempotent, and the earlier RPC signatures keep working for existing callers.

-- Page Master. display_name is the owner's internal name ('Page A'); the provider
-- name stays in name. end_date is the last paid day of an inactive page.
alter table public.pages
  add column if not exists display_name text not null default '' check (char_length(display_name)<=150),
  add column if not exists end_date date,
  add column if not exists alert_quiet_days integer check (alert_quiet_days is null or alert_quiet_days between 1 and 60);
-- Viral-post alerts name the post they are about.
alter table public.alerts add column if not exists post_id text check (post_id is null or char_length(post_id) between 1 and 300);

-- Pay is counted from the day a page was added (India time, like the dashboard's
-- days). Pages carry no created_at, so existing blank start dates use the first
-- recorded observation of the page; pages never refreshed keep a blank date.
alter table public.pages alter column start_date set default (((now() at time zone 'UTC')+interval '5 hours 30 minutes')::date);
update public.pages p set start_date=((e.first_seen at time zone 'UTC')+interval '5 hours 30 minutes')::date
from (select q.id,least((select min(s.observed_at) from public.account_snapshots s where s.owner=q.owner and s.page_id=q.id),
    (select min(pp.created_at) from public.page_posts pp where pp.owner=q.owner and pp.page_id=q.id),q.last_synced_at) as first_seen
  from public.pages q where q.start_date is null) e
where p.id=e.id and p.start_date is null and e.first_seen is not null;
-- Inactive pages stopped refreshing when they were paused, so their last refresh is
-- the best record of when pay stopped. Without one they keep counting no pay.
update public.pages set end_date=((last_synced_at at time zone 'UTC')+interval '5 hours 30 minutes')::date
where active=false and end_date is null and last_synced_at is not null
  and (start_date is null or start_date<=((last_synced_at at time zone 'UTC')+interval '5 hours 30 minutes')::date);

-- Deactivating a page ends its pay today unless the same change names an end
-- date; reactivating it clears the end date. Updates that leave active alone are untouched.
create or replace function private.maintain_page_end_date() returns trigger language plpgsql security invoker set search_path='' as $$
declare today date:=((now() at time zone 'UTC')+interval '5 hours 30 minutes')::date;
begin
  if new.active and not old.active then new.end_date:=null;
  elsif old.active and not new.active and new.end_date is not distinct from old.end_date then
    new.end_date:=case when new.start_date is null or new.start_date<=today then today end;
  end if;
  return new;
end;
$$;
revoke all on function private.maintain_page_end_date() from public,anon,authenticated;
grant execute on function private.maintain_page_end_date() to service_role;
drop trigger if exists desk_maintain_page_end_date on public.pages;
create trigger desk_maintain_page_end_date before update of active on public.pages
for each row execute function private.maintain_page_end_date();

create index if not exists page_posts_owner_asset_idx on public.page_posts(owner,source_asset_id) where source_asset_id is not null;

-- Adding a page reports whether it was already tracked. Typed details fill the
-- saved page's blank fields and never overwrite what the Page Master already holds.
create or replace function public.desk_add_managed_page(p_actor uuid,p_owner uuid,p_page jsonb,p_metadata jsonb,p_collection uuid,p_details boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare target_collection uuid; target_page uuid; existed boolean; pay numeric; started date; ended date; quiet integer; synced timestamptz;
begin
  if p_actor is null or p_owner is null or not exists(select 1 from public.users where id=p_actor)
    or (p_actor<>p_owner and not exists(select 1 from public.users where id=p_actor and user_type='admin')) then
    raise exception 'DD403:This account cannot assign pages to that workspace.';
  end if;
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Account not found.'; end if;
  if jsonb_typeof(p_page) is distinct from 'object' or jsonb_typeof(p_metadata) is distinct from 'object' then raise exception 'DD400:Invalid page details.'; end if;
  if p_metadata->'monthly_pay' is not null and p_metadata->'monthly_pay'<>'null'::jsonb then
    if jsonb_typeof(p_metadata->'monthly_pay')<>'number' then raise exception 'DD400:Enter a valid monthly pay.'; end if;
    pay:=(p_metadata->>'monthly_pay')::numeric;
    if pay<0 or pay>999999999999.99 or trunc(pay,2)<>pay then raise exception 'DD400:Enter a valid monthly pay.'; end if;
  end if;
  if p_metadata->>'start_date' is not null then
    if p_metadata->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'DD400:Enter a valid start date.'; end if;
    started:=(p_metadata->>'start_date')::date;
  end if;
  if p_metadata->>'end_date' is not null then
    if p_metadata->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'DD400:Enter a valid end date.'; end if;
    ended:=(p_metadata->>'end_date')::date;
    if started is not null and ended<started then raise exception 'DD400:The pay end date must be on or after the start date.'; end if;
  end if;
  if p_metadata->'alert_quiet_days' is not null and p_metadata->'alert_quiet_days'<>'null'::jsonb then
    if jsonb_typeof(p_metadata->'alert_quiet_days')<>'number' or (p_metadata->>'alert_quiet_days')::numeric not between 1 and 60
      or (p_metadata->>'alert_quiet_days')::numeric<>trunc((p_metadata->>'alert_quiet_days')::numeric) then
      raise exception 'DD400:Choose a quiet-day alert from 1 to 60 days.';
    end if;
    quiet:=(p_metadata->>'alert_quiet_days')::integer;
  end if;
  if char_length(coalesce(p_metadata->>'editor',''))>150 or char_length(coalesce(p_metadata->>'notes',''))>2000
    or char_length(coalesce(p_metadata->>'display_name',''))>150
    or (p_metadata?'display_name' and jsonb_typeof(p_metadata->'display_name') not in ('string','null'))
    or (p_metadata?'active' and jsonb_typeof(p_metadata->'active')<>'boolean') then raise exception 'DD400:Check the page details.'; end if;
  select id into target_page from public.pages where owner=p_owner and platform=p_page->>'platform' and handle=p_page->>'handle';
  existed:=target_page is not null;
  if p_collection is not null then
    select id into target_collection from public.collections where id=p_collection and owner=p_owner;
    if target_collection is null then raise exception 'DD404:Collection not found.'; end if;
  else
    select id into target_collection from public.collections where owner=p_owner order by created_at,id limit 1;
    if target_collection is null then
      target_collection:=gen_random_uuid();
      perform public.desk_create_collection(p_owner,'My pages',target_collection);
    end if;
  end if;
  perform public.desk_add_page(p_owner,target_collection,p_page->>'platform',p_page->>'handle',p_page->>'url');
  select id into target_page from public.pages where owner=p_owner and platform=p_page->>'platform' and handle=p_page->>'handle';
  if not existed then
    update public.pages set monthly_pay=pay,editor=coalesce(p_metadata->>'editor',''),
      start_date=coalesce(started,((now() at time zone 'UTC')+interval '5 hours 30 minutes')::date),
      active=coalesce((p_metadata->>'active')::boolean,true),notes=coalesce(p_metadata->>'notes',''),
      display_name=coalesce(p_metadata->>'display_name',''),alert_quiet_days=quiet,end_date=ended
      where id=target_page and owner=p_owner;
  else
    update public.pages set monthly_pay=coalesce(monthly_pay,pay),
      editor=case when editor='' then coalesce(p_metadata->>'editor','') else editor end,
      start_date=coalesce(start_date,started),notes=case when notes='' then coalesce(p_metadata->>'notes','') else notes end,
      display_name=case when display_name='' then coalesce(p_metadata->>'display_name','') else display_name end,
      alert_quiet_days=coalesce(alert_quiet_days,quiet)
      where id=target_page and owner=p_owner;
  end if;
  select last_synced_at into synced from public.pages where id=target_page and owner=p_owner;
  return jsonb_build_object('pageId',target_page,'existed',existed,'lastSyncedAt',synced);
end;
$$;
revoke all on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid,boolean) from public,anon,authenticated;
grant execute on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid,boolean) to service_role;
-- The original five-argument call still returns only the page ID.
create or replace function public.desk_add_managed_page(p_actor uuid,p_owner uuid,p_page jsonb,p_metadata jsonb,p_collection uuid default null)
returns uuid language plpgsql security invoker set search_path='' as $$
begin
  return (public.desk_add_managed_page(p_actor,p_owner,p_page,p_metadata,p_collection,true)->>'pageId')::uuid;
end;
$$;
revoke all on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid) to service_role;

-- Confirm that posts on different pages are the same content (mode group), mark
-- posts as unique so they are never suggested again (solo), or undo either (unlink).
-- Group IDs are generated here, so a browser never picks or guesses another owner's.
create or replace function public.desk_link_content(p_owner uuid,p_posts jsonb,p_mode text,p_group text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset text; changed integer;
begin
  if p_mode is null or p_mode not in ('group','solo','unlink') then raise exception 'DD400:Choose how to link these posts.'; end if;
  if jsonb_typeof(p_posts) is distinct from 'array' or jsonb_array_length(p_posts) not between 1 and 50 then raise exception 'DD400:Choose between 1 and 50 posts.'; end if;
  if exists(select 1 from jsonb_array_elements(p_posts) i where jsonb_typeof(i)<>'object'
    or coalesce(i->>'pageId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(i->'postId') is distinct from 'string' or char_length(i->>'postId') not between 1 and 300) then
    raise exception 'DD400:Choose valid posts.';
  end if;
  if (select count(distinct ((i->>'pageId')::uuid,i->>'postId')) from jsonb_array_elements(p_posts) i)<>jsonb_array_length(p_posts) then
    raise exception 'DD400:Choose each post only once.';
  end if;
  if p_group is not null and (p_mode<>'group' or p_group !~ '^ca_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'DD400:Choose a valid content group.';
  end if;
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  if (select count(*) from public.page_posts p join jsonb_to_recordset(p_posts) c("pageId" uuid,"postId" text) on c."pageId"=p.page_id and c."postId"=p.post_id
    where p.owner=p_owner)<>jsonb_array_length(p_posts) then raise exception 'DD404:Post not found.'; end if;
  if p_mode='group' then
    if p_group is not null and not exists(select 1 from public.page_posts where owner=p_owner and source_asset_id=p_group) then
      raise exception 'DD404:Content group not found.';
    end if;
    asset:=coalesce(p_group,'ca_'||gen_random_uuid()::text);
    -- A piece of content is posted once per page, so a group holds one post per page.
    if exists(select 1 from (
        select p.page_id from public.page_posts p where p.owner=p_owner and p.source_asset_id=asset
          and not exists(select 1 from jsonb_to_recordset(p_posts) c("pageId" uuid,"postId" text) where c."pageId"=p.page_id and c."postId"=p.post_id)
        union all select c."pageId" from jsonb_to_recordset(p_posts) c("pageId" uuid,"postId" text)) members group by page_id having count(*)>1) then
      raise exception 'DD409:A content group can hold only one post from each page.';
    end if;
  end if;
  update public.page_posts p set source_asset_id=case p_mode when 'group' then asset when 'solo' then 'solo_'||gen_random_uuid()::text end
    from jsonb_to_recordset(p_posts) c("pageId" uuid,"postId" text) where p.owner=p_owner and p.page_id=c."pageId" and p.post_id=c."postId";
  get diagnostics changed=row_count;
  return jsonb_build_object('groupId',asset,'linked',changed);
end;
$$;
revoke all on function public.desk_link_content(uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.desk_link_content(uuid,jsonb,text,text) to service_role;

-- Same persistence rules as before. Pages in p_skip_pages could not be checked
-- (stale or failed refresh, incomplete feed): their open alerts and check counts
-- are kept instead of being resolved by the absence of a candidate.
create or replace function public.desk_reconcile_alerts(p_owner uuid,p_candidates jsonb,p_observed_at timestamptz,p_skip_pages jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare candidate jsonb; page_key uuid; check_row private.alert_checks%rowtype; next_count integer; opened integer:=0; resolved integer:=0; changed integer; skipped jsonb:=coalesce(p_skip_pages,'[]');
begin
  if p_observed_at is null or p_observed_at>now()+interval '5 minutes' or p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>5000
    or jsonb_typeof(skipped)<>'array' or jsonb_array_length(skipped)>5000
    or exists(select 1 from jsonb_array_elements(skipped) s where jsonb_typeof(s)<>'string' or s#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
    raise exception 'DD400:Invalid alert check.';
  end if;
  perform 1 from public.users where id=p_owner for update;
  if not found then raise exception 'DD404:Workspace not found.'; end if;
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(candidate)<>'object' or coalesce(candidate->>'pageId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(candidate->>'type','') !~ '^[a-z0-9_-]{1,64}$' or coalesce(candidate->>'level','') not in ('red','amber','green')
      or char_length(coalesce(candidate->>'title','')) not between 1 and 200 or char_length(coalesce(candidate->>'details',''))>2000
      or (candidate->'postId' is not null and candidate->'postId'<>'null'::jsonb and (jsonb_typeof(candidate->'postId')<>'string' or char_length(candidate->>'postId') not between 1 and 300)) then
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
    update public.alerts set last_seen_at=p_observed_at,title=candidate->>'title',details=coalesce(candidate->>'details',''),level=candidate->>'level',post_id=candidate->>'postId'
      where owner=p_owner and page_id=page_key and type=candidate->>'type' and resolved_at is null and last_seen_at<=p_observed_at;
    if next_count>=2 and (check_row.last_alert_at is null or p_observed_at>=check_row.last_alert_at+interval '3 days') then
      insert into public.alerts(owner,page_id,level,type,title,details,post_id,created_at,last_seen_at)
        values(p_owner,page_key,candidate->>'level',candidate->>'type',candidate->>'title',coalesce(candidate->>'details',''),candidate->>'postId',p_observed_at,p_observed_at)
        on conflict(owner,page_id,type) where resolved_at is null do nothing;
      get diagnostics changed=row_count; opened:=opened+changed;
      if changed>0 then update private.alert_checks set last_alert_at=p_observed_at where owner=p_owner and page_id=page_key and type=candidate->>'type'; end if;
    end if;
  end loop;
  update public.alerts a set resolved_at=p_observed_at where a.owner=p_owner and a.resolved_at is null and a.last_seen_at<p_observed_at
    and not exists(select 1 from jsonb_array_elements(p_candidates) c where c->>'pageId'=a.page_id::text and c->>'type'=a.type)
    and not exists(select 1 from jsonb_array_elements_text(skipped) s where lower(s)=a.page_id::text);
  get diagnostics resolved=row_count;
  update private.alert_checks a set checks=0,last_seen_at=p_observed_at where a.owner=p_owner and a.last_seen_at<p_observed_at
    and not exists(select 1 from jsonb_array_elements(p_candidates) c where c->>'pageId'=a.page_id::text and c->>'type'=a.type)
    and not exists(select 1 from jsonb_array_elements_text(skipped) s where lower(s)=a.page_id::text);
  return jsonb_build_object('opened',opened,'resolved',resolved);
end;
$$;
revoke all on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz,jsonb) to service_role;
create or replace function public.desk_reconcile_alerts(p_owner uuid,p_candidates jsonb,p_observed_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  return public.desk_reconcile_alerts(p_owner,p_candidates,p_observed_at,'[]'::jsonb);
end;
$$;
revoke all on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.desk_reconcile_alerts(uuid,jsonb,timestamptz) to service_role;

-- Merging an alias keeps the owner's internal name and alert setting as well.
create or replace function public.desk_save_refresh(p_owner uuid,p_source uuid,p_target uuid,p_lease bigint,p_snapshot jsonb)
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
      start_date=coalesce(target.start_date,source.start_date),notes=case when target.notes='' then source.notes else target.notes end,
      display_name=case when target.display_name='' then source.display_name else target.display_name end,
      alert_quiet_days=coalesce(target.alert_quiet_days,source.alert_quiet_days)
      from public.pages source where target.id=p_target and target.owner=p_owner and source.id=p_source and source.owner=p_owner;
  end if;
  return private.desk_save_refresh_before_history(p_owner,p_source,p_target,p_lease,p_snapshot);
end;
$$;
revoke all on function public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.desk_save_refresh(uuid,uuid,uuid,bigint,jsonb) to service_role;

-- Backups. Export already writes whole page and alert rows; the importer now
-- validates and restores the new page fields and alert post IDs. The previous
-- implementations stay underneath, under a _v2 name, as the analytics layer did.
do $$ begin
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='prepare_workspace_import_v2') then
    alter function private.prepare_workspace_import(uuid,jsonb) rename to prepare_workspace_import_v2;
  end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='apply_workspace_analytics_v2') then
    alter function private.apply_workspace_analytics(uuid,jsonb,boolean,jsonb) rename to apply_workspace_analytics_v2;
  end if;
end $$;
create or replace function private.prepare_workspace_import(p_owner uuid,p_archive jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prepared jsonb; extra jsonb:='{}'; row_value jsonb; fields jsonb; target_id uuid; day_value date; alerts jsonb; post_ids jsonb;
begin
  prepared:=private.prepare_workspace_import_v2(p_owner,p_archive);
  for row_value in select value from jsonb_array_elements(p_archive->'workspace'->'pages') loop
    fields:='{}';
    select m.target into target_id from jsonb_to_recordset(prepared->'pages') m(source uuid,target uuid) where m.source=(row_value->>'id')::uuid;
    if row_value ? 'display_name' then
      if jsonb_typeof(row_value->'display_name')<>'string' or char_length(row_value->>'display_name')>150 then
        raise exception 'DD400:Page display names must be text of 150 characters or fewer.';
      end if;
      fields:=fields||jsonb_build_object('display_name',row_value->'display_name');
    end if;
    if row_value ? 'alert_quiet_days' then
      if row_value->'alert_quiet_days'='null'::jsonb then fields:=fields||'{"alert_quiet_days":null}'::jsonb;
      elsif jsonb_typeof(row_value->'alert_quiet_days')<>'number' or (row_value->>'alert_quiet_days')::numeric not between 1 and 60
        or (row_value->>'alert_quiet_days')::numeric<>trunc((row_value->>'alert_quiet_days')::numeric) then
        raise exception 'DD400:Quiet-day alert settings must be whole days from 1 to 60.';
      else fields:=fields||jsonb_build_object('alert_quiet_days',(row_value->>'alert_quiet_days')::integer); end if;
    end if;
    if row_value ? 'end_date' then
      if row_value->'end_date'='null'::jsonb then fields:=fields||'{"end_date":null}'::jsonb;
      else
        if jsonb_typeof(row_value->'end_date')<>'string' or row_value->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'DD400:Page end dates must be calendar dates.'; end if;
        begin day_value:=(row_value->>'end_date')::date; exception when others then raise exception 'DD400:Page end date is invalid.'; end;
        if not isfinite(day_value) then raise exception 'DD400:Page end date is invalid.'; end if;
        fields:=fields||jsonb_build_object('end_date',day_value);
      end if;
    end if;
    if fields<>'{}'::jsonb then extra:=extra||jsonb_build_object(target_id::text,fields); end if;
  end loop;
  if extra<>'{}'::jsonb then
    prepared:=jsonb_set(prepared,'{analytics,pageMetadata}',(select coalesce(jsonb_agg(m||jsonb_build_object('fields',(m->'fields')||coalesce(extra->(m->>'page_id'),'{}'::jsonb))),'[]'::jsonb)
      from jsonb_array_elements(prepared->'analytics'->'pageMetadata') m));
  end if;
  alerts:=p_archive->'workspace'->'analytics'->'alerts';
  if jsonb_typeof(alerts)='array' then
    if exists(select 1 from jsonb_array_elements(alerts) i where i->'post_id' is not null and i->'post_id'<>'null'::jsonb
      and (jsonb_typeof(i->'post_id')<>'string' or char_length(i->>'post_id') not between 1 and 300)) then
      raise exception 'DD400:The backup contains an invalid alert.';
    end if;
    select jsonb_object_agg((coalesce(nullif(i->>'transfer_id',''),i->>'id'))::uuid::text,i->'post_id') into post_ids
      from jsonb_array_elements(alerts) i where jsonb_typeof(i->'post_id')='string';
    if post_ids is not null then
      prepared:=jsonb_set(prepared,'{analytics,alerts}',(select coalesce(jsonb_agg(r||jsonb_build_object('post_id',post_ids->(r->>'transfer_id'))),'[]'::jsonb)
        from jsonb_array_elements(prepared->'analytics'->'alerts') r));
    end if;
  end if;
  return prepared;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  raise exception 'DD400:The backup contains invalid analytics IDs, dates, or numbers.';
end; $$;

create or replace function private.apply_workspace_analytics(p_owner uuid,p_analytics jsonb,p_overwrite boolean,p_page_map jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare i jsonb; paused jsonb;
begin
  -- Pages already inactive before the import keep their end date when an older backup has none.
  select coalesce(jsonb_object_agg(id::text,true),'{}') into paused from public.pages where owner=p_owner and not active;
  perform private.apply_workspace_analytics_v2(p_owner,p_analytics,p_overwrite,p_page_map);
  if p_analytics is null then return; end if;
  for i in select value from jsonb_array_elements(p_analytics->'pageMetadata') loop
    if p_overwrite or exists(select 1 from jsonb_to_recordset(p_page_map) m(target uuid,"isNew" boolean) where m.target=(i->>'page_id')::uuid and m."isNew") then
      -- A restored page takes the backup's end date. An older backup has none, so a page
      -- it pauses counts no pay rather than ending on the import day; one already paused keeps its date.
      update public.pages p set
        display_name=case when i->'fields' ? 'display_name' then i->'fields'->>'display_name' else p.display_name end,
        alert_quiet_days=case when i->'fields' ? 'alert_quiet_days' then (i->'fields'->>'alert_quiet_days')::integer else p.alert_quiet_days end,
        end_date=case when i->'fields' ? 'end_date' then (i->'fields'->>'end_date')::date when i->'fields' ? 'active' then case when not p.active and paused ? p.id::text then p.end_date end else p.end_date end
      where p.id=(i->>'page_id')::uuid and p.owner=p_owner;
    end if;
  end loop;
  update public.alerts a set post_id=i.post_id
    from jsonb_to_recordset(p_analytics->'alerts') i(transfer_id uuid,post_id text)
    where a.owner=p_owner and a.transfer_id=i.transfer_id and i.post_id is not null and (p_overwrite or a.post_id is null);
end; $$;

revoke all on function private.prepare_workspace_import_v2(uuid,jsonb),private.prepare_workspace_import(uuid,jsonb),
  private.apply_workspace_analytics_v2(uuid,jsonb,boolean,jsonb),private.apply_workspace_analytics(uuid,jsonb,boolean,jsonb) from public,anon,authenticated;
grant execute on function private.prepare_workspace_import_v2(uuid,jsonb),private.prepare_workspace_import(uuid,jsonb),
  private.apply_workspace_analytics_v2(uuid,jsonb,boolean,jsonb),private.apply_workspace_analytics(uuid,jsonb,boolean,jsonb) to service_role;
