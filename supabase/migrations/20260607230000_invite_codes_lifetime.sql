-- =============================================================================
-- 20260607230000_invite_codes_lifetime  (SAAS — aplicada en remoto vía MCP)
-- invite_codes (códigos canjeables al registrarse: vitalicio o trial de X plan,
-- con vigencia/cupo/activación; admin solo staff) + subscriptions.is_lifetime
-- + redeem_invite_code() (owner canjea para su tenant, auditado)
-- + internal_grant_access() (staff otorga vitalicio o días gratis, auditado).
-- Ver contenido completo aplicado: mismo SQL que esta migración.
-- =============================================================================
create table if not exists invite_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  kind        text not null check (kind in ('lifetime','trial_days')),
  plan_key    text not null,
  trial_days  int check (trial_days is null or trial_days between 1 and 730),
  max_uses    int check (max_uses is null or max_uses >= 1),
  used_count  int not null default 0,
  valid_from  date,
  valid_until date,
  is_active   boolean not null default true,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

alter table invite_codes enable row level security;
create policy invite_codes_select on invite_codes
  for select using ((select is_internal()));
create policy invite_codes_insert on invite_codes
  for insert with check ((select is_internal()));
create policy invite_codes_update on invite_codes
  for update using ((select is_internal())) with check ((select is_internal()));

alter table subscriptions add column if not exists is_lifetime boolean not null default false;

create or replace function redeem_invite_code(p_code text, p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code invite_codes%rowtype;
  v_plan_id uuid;
begin
  if not exists (
    select 1 from tenant_users
    where tenant_id = p_tenant_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_code from invite_codes
   where upper(code) = upper(btrim(p_code)) and deleted_at is null
   for update;
  if not found then raise exception 'invalid_code'; end if;
  if not v_code.is_active then raise exception 'code_inactive'; end if;
  if v_code.valid_from is not null and current_date < v_code.valid_from then
    raise exception 'code_not_started';
  end if;
  if v_code.valid_until is not null and current_date > v_code.valid_until then
    raise exception 'code_expired';
  end if;
  if v_code.max_uses is not null and v_code.used_count >= v_code.max_uses then
    raise exception 'code_exhausted';
  end if;

  select id into v_plan_id from plans
   where key = v_code.plan_key and tenant_id is null and is_active limit 1;
  if v_plan_id is null then raise exception 'plan_not_found'; end if;

  if v_code.kind = 'lifetime' then
    update subscriptions
       set plan_id = v_plan_id, status = 'active', is_lifetime = true,
           updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants set status = 'active', trial_ends_at = null, updated_at = now()
     where id = p_tenant_id;
  else
    update subscriptions
       set plan_id = v_plan_id, status = 'trial', updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants
       set status = 'trial',
           trial_ends_at = now() + make_interval(days => coalesce(v_code.trial_days, 14)),
           updated_at = now()
     where id = p_tenant_id;
  end if;

  update invite_codes set used_count = used_count + 1 where id = v_code.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'invite_codes', v_code.id, 'invite_code_redeemed',
          jsonb_build_object('code', v_code.code, 'kind', v_code.kind,
                             'plan', v_code.plan_key, 'trial_days', v_code.trial_days));

  return jsonb_build_object('kind', v_code.kind, 'plan', v_code.plan_key,
                            'trial_days', v_code.trial_days);
end;
$$;
revoke all on function redeem_invite_code(text, uuid) from public, anon;
grant execute on function redeem_invite_code(text, uuid) to authenticated;

create or replace function internal_grant_access(
  p_tenant_id uuid,
  p_plan_key text,
  p_lifetime boolean,
  p_free_days int default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  if coalesce(internal_level(), 'admin') = 'support' then raise exception 'forbidden'; end if;
  if not p_lifetime and (p_free_days is null or p_free_days < 1 or p_free_days > 730) then
    raise exception 'invalid_days';
  end if;

  select id into v_plan_id from plans
   where key = p_plan_key and (tenant_id is null or tenant_id = p_tenant_id)
     and is_active limit 1;
  if v_plan_id is null then raise exception 'plan_not_found'; end if;

  if p_lifetime then
    update subscriptions
       set plan_id = v_plan_id, status = 'active', is_lifetime = true, updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants set status = 'active', trial_ends_at = null, updated_at = now()
     where id = p_tenant_id;
  else
    update subscriptions
       set plan_id = v_plan_id, status = 'trial', is_lifetime = false, updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants
       set status = 'trial',
           trial_ends_at = greatest(coalesce(trial_ends_at, now()), now())
                           + make_interval(days => p_free_days),
           updated_at = now()
     where id = p_tenant_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'access_granted',
          jsonb_build_object('plan', p_plan_key, 'lifetime', p_lifetime,
                             'free_days', p_free_days, 'reason', p_reason));
end;
$$;
revoke all on function internal_grant_access(uuid, text, boolean, int, text) from public, anon;
grant execute on function internal_grant_access(uuid, text, boolean, int, text) to authenticated;
