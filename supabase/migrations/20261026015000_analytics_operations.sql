-- Atomic page creation/assignment. Roles stay exclusively database-managed.
create function public.desk_add_managed_page(p_actor uuid,p_owner uuid,p_page jsonb,p_metadata jsonb,p_collection uuid default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare target_collection uuid; target_page uuid; existed boolean; pay numeric; started date;
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
  if char_length(coalesce(p_metadata->>'editor',''))>150 or char_length(coalesce(p_metadata->>'notes',''))>2000
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
    update public.pages set monthly_pay=pay,editor=coalesce(p_metadata->>'editor',''),start_date=started,
      active=coalesce((p_metadata->>'active')::boolean,true),notes=coalesce(p_metadata->>'notes','')
      where id=target_page and owner=p_owner;
  end if;
  return target_page;
end;
$$;
revoke all on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.desk_add_managed_page(uuid,uuid,jsonb,jsonb,uuid) to service_role;

create function public.desk_admin_provider_report(p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare providers jsonb; totals jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor and user_type='admin') then raise exception 'DD403:Administrator access is required.'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.provider,r.funding),'[]'::jsonb) into providers from (
    select provider,funding,count(*) as requests,count(*) filter(where success=true) as succeeded,
      count(*) filter(where success=false) as failed,count(*) filter(where success is null) as pending,
      coalesce(sum(estimated_cost_usd),0) as estimated_cost_usd,round(avg(latency_ms)) as latency_ms
    from public.provider_requests where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
      and created_at<(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC'
    group by provider,funding
  )r;
  select public.desk_provider_usage() into totals;
  return jsonb_build_object('providers',providers,'totals',totals);
end;
$$;
revoke all on function public.desk_admin_provider_report(uuid) from public,anon,authenticated;
grant execute on function public.desk_admin_provider_report(uuid) to service_role;
