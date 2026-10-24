-- Execute as postgres against a local/disposable Supabase database AFTER the
-- migration. Every fixture and assertion is rolled back at the end.
-- Run in the Supabase SQL Editor after applying the migrations.
--
-- PGlite compatibility: before applying the migration, create anon and
-- authenticated roles; auth.users(id uuid primary key, email text,
-- raw_user_meta_data jsonb default '{}'); and auth.uid() returning
-- nullif(current_setting('request.jwt.claim.sub', true), '')::uuid.

begin;

insert into auth.users (id, email, raw_user_meta_data) values
 ('a1111111-1111-4111-8111-111111111111', 'user-a@distribution-desk.test', '{"full_name":"User A","user_type":"admin","role":"admin"}'),
 ('b2222222-2222-4222-8222-222222222222', 'user-b@distribution-desk.test', '{"name":"User B"}'),
 ('c3333333-3333-4333-8333-333333333333', 'admin@distribution-desk.test', '{"full_name":"Admin"}');

do $$ begin
  if (select user_type from public.users where id='a1111111-1111-4111-8111-111111111111') <> 'user' then
    raise exception 'Auth metadata must not assign admin privileges';
  end if;
  if (select name from public.users where id='b2222222-2222-4222-8222-222222222222') <> 'User B' then
    raise exception 'Auth profile display name was not registered';
  end if;
end $$;

update public.users set user_type='admin' where id='c3333333-3333-4333-8333-333333333333';
update auth.users set email='updated-a@distribution-desk.test', raw_user_meta_data='{"full_name":"Updated A","user_type":"admin","role":"admin"}'
where id='a1111111-1111-4111-8111-111111111111';
update auth.users set raw_user_meta_data='{"full_name":"Updated Admin","user_type":"user"}'
where id='c3333333-3333-4333-8333-333333333333';

do $$ begin
  if (select user_type from public.users where id='a1111111-1111-4111-8111-111111111111') <> 'user' then
    raise exception 'Updating mutable Auth metadata escalated a role';
  end if;
  if (select email from public.users where id='a1111111-1111-4111-8111-111111111111') <> 'updated-a@distribution-desk.test' then
    raise exception 'Verified Auth identity email did not synchronize';
  end if;
  if (select user_type from public.users where id='c3333333-3333-4333-8333-333333333333') <> 'admin' then
    raise exception 'Auth profile updates overwrote a manually assigned role';
  end if;
end $$;

insert into public.collections (id,owner,name) values
 ('d4444444-4444-4444-8444-444444444444','a1111111-1111-4111-8111-111111111111','A collection'),
 ('e5555555-5555-4555-8555-555555555555','b2222222-2222-4222-8222-222222222222','B collection');
insert into public.pages (id,owner,platform,handle,name,url,followers) values
 ('f6666666-6666-4666-8666-666666666666','a1111111-1111-4111-8111-111111111111','instagram','same_handle','A page','https://www.instagram.com/same_handle/',0),
 ('07777777-7777-4777-8777-777777777777','b2222222-2222-4222-8222-222222222222','instagram','same_handle','B page','https://www.instagram.com/same_handle/',100);
insert into public.memberships (collection_id,page_id,owner) values
 ('d4444444-4444-4444-8444-444444444444','f6666666-6666-4666-8666-666666666666','a1111111-1111-4111-8111-111111111111'),
 ('e5555555-5555-4555-8555-555555555555','07777777-7777-4777-8777-777777777777','b2222222-2222-4222-8222-222222222222');
insert into public.settings(owner,api_key,youtube_key) values
 ('a1111111-1111-4111-8111-111111111111','fixture-ciphertext','fixture-ciphertext');
insert into public.usage(owner,month,requests) values
 ('a1111111-1111-4111-8111-111111111111','2026-10',1);

-- Server-side mistakes must not be able to associate different tenants.
do $$ begin
  begin
    insert into public.memberships(collection_id,page_id,owner) values
      ('d4444444-4444-4444-8444-444444444444','07777777-7777-4777-8777-777777777777','a1111111-1111-4111-8111-111111111111');
    raise exception 'Cross-tenant page membership was accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.memberships(collection_id,page_id,owner) values
      ('e5555555-5555-4555-8555-555555555555','f6666666-6666-4666-8666-666666666666','a1111111-1111-4111-8111-111111111111');
    raise exception 'Cross-tenant collection membership was accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.pages(owner,platform,handle,name,url) values
      ('a1111111-1111-4111-8111-111111111111','instagram','same_handle','Duplicate','https://www.instagram.com/same_handle/');
    raise exception 'Duplicate tenant/platform/handle was accepted';
  exception when unique_violation then null; end;
  begin
    update public.pages set posts='{}'::jsonb where id='f6666666-6666-4666-8666-666666666666';
    raise exception 'Non-array post payload was accepted';
  exception when check_violation then null; end;
  begin
    update public.pages set coverage='[]'::jsonb where id='f6666666-6666-4666-8666-666666666666';
    raise exception 'Non-object coverage payload was accepted';
  exception when check_violation then null; end;
  begin
    update public.pages set followers=-1 where id='f6666666-6666-4666-8666-666666666666';
    raise exception 'Negative follower count was accepted';
  exception when check_violation then null; end;
  begin
    update public.pages set followers=9007199254740992 where id='f6666666-6666-4666-8666-666666666666';
    raise exception 'Unsafe JavaScript follower count was accepted';
  exception when check_violation then null; end;
  begin
    update public.settings set request_limit=2501 where owner='a1111111-1111-4111-8111-111111111111';
    raise exception 'Invalid request cap was accepted';
  exception when check_violation then null; end;
  begin
    update public.usage set month='2026-13' where owner='a1111111-1111-4111-8111-111111111111';
    raise exception 'Invalid usage month was accepted';
  exception when check_violation then null; end;
end $$;

set local request.jwt.claim.sub = 'a1111111-1111-4111-8111-111111111111';
set local role authenticated;
do $$ begin
  if (select count(*) from public.users where id in ('a1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222','c3333333-3333-4333-8333-333333333333')) <> 1 then
    raise exception 'Normal user can read another person profile';
  end if;
  if (select count(*) from public.collections where id in ('d4444444-4444-4444-8444-444444444444','e5555555-5555-4555-8555-555555555555')) <> 1 then
    raise exception 'Collection tenant isolation failed';
  end if;
  if (select count(*) from public.pages where id in ('f6666666-6666-4666-8666-666666666666','07777777-7777-4777-8777-777777777777')) <> 1 then
    raise exception 'Page tenant isolation failed';
  end if;
  if (select count(*) from public.memberships where collection_id in ('d4444444-4444-4444-8444-444444444444','e5555555-5555-4555-8555-555555555555')) <> 1 then
    raise exception 'Membership tenant isolation failed';
  end if;
  if (select private.is_admin()) then raise exception 'Normal user incorrectly classified as admin'; end if;
  begin
    update public.users set user_type='admin' where id='a1111111-1111-4111-8111-111111111111';
    raise exception 'Client role escalation was accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.users(id,user_type) values('08888888-8888-4888-8888-888888888888','admin');
    raise exception 'Client forged profile insertion was accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.collections(owner,name) values('a1111111-1111-4111-8111-111111111111','Forbidden client write');
    raise exception 'Client collection write was accepted';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.pages where id='f6666666-6666-4666-8666-666666666666';
    raise exception 'Client page deletion was accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform api_key from public.settings;
    raise exception 'Ciphertext was exposed to its owner through the browser role';
  exception when insufficient_privilege then null; end;
  begin
    perform requests from public.usage;
    raise exception 'Server usage data was exposed to browser role';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local request.jwt.claim.sub = 'c3333333-3333-4333-8333-333333333333';
set local role authenticated;
do $$ begin
  if not (select private.is_admin()) then raise exception 'Manual admin role was not recognized'; end if;
  if (select count(*) from public.users where id in ('a1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222','c3333333-3333-4333-8333-333333333333')) <> 3 then
    raise exception 'Admin cannot read all registered profiles';
  end if;
  if (select count(*) from public.collections where id in ('d4444444-4444-4444-8444-444444444444','e5555555-5555-4555-8555-555555555555')) <> 2 then
    raise exception 'Admin cannot read all collections';
  end if;
  if (select count(*) from public.pages where id in ('f6666666-6666-4666-8666-666666666666','07777777-7777-4777-8777-777777777777')) <> 2 then
    raise exception 'Admin cannot read all pages';
  end if;
  if (select count(*) from public.memberships where collection_id in ('d4444444-4444-4444-8444-444444444444','e5555555-5555-4555-8555-555555555555')) <> 2 then
    raise exception 'Admin cannot read all memberships';
  end if;
  begin
    perform youtube_key from public.settings;
    raise exception 'Ciphertext was exposed to browser admin';
  exception when insufficient_privilege then null; end;
  begin
    update public.users set user_type='admin' where id='b2222222-2222-4222-8222-222222222222';
    raise exception 'Browser admin gained profile write privileges';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local request.jwt.claim.sub = '';
set local role anon;
do $$ begin
  begin
    perform id from public.users;
    raise exception 'Anonymous profile read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform id from public.collections;
    raise exception 'Anonymous collection read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform id from public.pages;
    raise exception 'Anonymous page read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform page_id from public.memberships;
    raise exception 'Anonymous membership read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform private.is_admin();
    raise exception 'Anonymous role-function execution was allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Cascading deletion of an Auth identity removes only that tenant's records.
delete from auth.users where id='a1111111-1111-4111-8111-111111111111';
do $$ begin
  if exists (select 1 from public.users where id='a1111111-1111-4111-8111-111111111111')
     or exists (select 1 from public.collections where owner='a1111111-1111-4111-8111-111111111111')
     or exists (select 1 from public.pages where owner='a1111111-1111-4111-8111-111111111111')
     or exists (select 1 from public.memberships where owner='a1111111-1111-4111-8111-111111111111')
     or exists (select 1 from public.settings where owner='a1111111-1111-4111-8111-111111111111')
     or exists (select 1 from public.usage where owner='a1111111-1111-4111-8111-111111111111') then
    raise exception 'Auth identity deletion did not cascade through tenant data';
  end if;
  if not exists (select 1 from public.pages where id='07777777-7777-4777-8777-777777777777') then
    raise exception 'Tenant deletion removed another tenant data';
  end if;
  raise notice 'Distribution Desk schema and RLS assertions passed.';
end $$;

rollback;
