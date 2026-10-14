-- =============================================================================
-- 20261115200000_cobranza_cuenta_corriente  (F20-8 · ADR-120)
--
-- Suscripción por cuenta corriente con NinjaSoft (spec docs/40-cobranza-saas.md
-- §9.3, §10.1, §12.3, §14.5 y las decisiones del dueño de §22, que mandan) y el
-- rediseño de los límites del plan en la ficha del negocio.
--
--   A) Límites del plan: internal_tenant_limits (límite del plan, override,
--      efectivo y uso actual) e internal_set_limit_overrides (todos juntos, con
--      motivo y auditoría). Plan sin límite = ilimitado (Enterprise).
--   B) Cuentas para cobrar (platform_bank_accounts) con el mismo modelo que las
--      cuentas de Transferencia del POS (banco del catálogo, titular, CUIT,
--      CBU / CVU con dígitos verificadores, alias) y la configuración de cobro
--      (email y WhatsApp para comprobantes, avisos).
--   C) Condiciones por negocio: frecuencia del aviso, días antes del
--      vencimiento, destinatarios. internal_billing_set_terms ya no cambia la
--      modalidad: eso pasa por D.
--   D) Cambio de modalidad (platform_billing_mode_changes):
--        · a cuenta corriente / manual / exento: rige ya; si hay preapproval de
--          Mercado Pago queda 'pending_mp_cancel' hasta que la UI lo cancela
--          con la Edge mp_subscription_pause y lo informa;
--        · a Mercado Pago: queda 'pending_checkout' y el negocio sigue en su
--          modalidad hasta el primer débito aprobado (trigger sobre
--          platform_payments). Nunca hay dos medios cobrando a la vez.
--   E) Códigos de invitación de cuenta corriente (kind 'account'): plan, plazo,
--      descuento opcional, vencimiento y usos. Alta sin checkout de MP.
--      Altas, bajas y cambios de códigos por RPC auditada.
--   F) Avisos de cobro: cron diario que manda el aviso con los datos
--      bancarios y a dónde mandar el comprobante, idempotente por cuota.
--   G) "Ya transferí": el dueño sube el comprobante (bucket privado
--      platform-payment-proofs) y el staff lo verifica (imputa el pago por
--      billing_records → ledger, ADR-115) o lo rechaza con motivo.
--   H) Lecturas: my_billing_account (dueño o encargado) e
--      internal_billing_collection (staff).
--   I) Plantillas de email (lib/email/templates.ts).
--
-- RLS: staff con (select internal_scope()) (ADR-052), negocio con
-- (select current_tenant_id()); escritura sólo por RPC security definer.
-- Importes en centavos. Auditoría antes de responder. Baja lógica.
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Límites del plan
-- -----------------------------------------------------------------------------
create or replace function internal_tenant_limits(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub    subscriptions%rowtype;
  v_plan   plans%rowtype;
  v_ov     jsonb;
  v_lim    jsonb;
  v_month  timestamptz;
  v_rows   jsonb := '[]'::jsonb;
  v_key    text;
  v_usage  numeric;
begin
  if not coalesce((select internal_scope()), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_sub from subscriptions where tenant_id = p_tenant;
  if not found then
    raise exception 'subscription_not_found' using errcode = 'P0002';
  end if;
  select * into v_plan from plans where id = v_sub.plan_id;
  v_ov := coalesce(v_sub.limit_overrides, '{}'::jsonb);
  v_lim := coalesce(v_plan.limits -> 'limits', '{}'::jsonb);
  v_month := date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires';

  foreach v_key in array array['max_stores', 'max_registers_per_store', 'max_users', 'max_products', 'max_sales_per_month'] loop
    v_usage := case v_key
      when 'max_stores' then
        (select count(*) from stores s where s.tenant_id = p_tenant and s.deleted_at is null)
      when 'max_registers_per_store' then
        (select coalesce(max(x.n), 0) from (
           select count(*) as n
             from cash_registers r
             join stores s on s.id = r.store_id and s.deleted_at is null
            where r.tenant_id = p_tenant and r.deleted_at is null
            group by r.store_id) x)
      when 'max_users' then
        (select count(*) from tenant_users tu where tu.tenant_id = p_tenant and tu.status = 'active')
      when 'max_products' then
        (select count(*) from products p where p.tenant_id = p_tenant and p.deleted_at is null)
      when 'max_sales_per_month' then
        (select count(*) from sales s where s.tenant_id = p_tenant and s.created_at >= v_month and s.voided_at is null)
    end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'key', v_key,
      -- null = el plan no limita (ilimitado).
      'plan_value', case when jsonb_typeof(v_lim -> v_key) = 'number' then (v_lim ->> v_key)::numeric end,
      'override', case when jsonb_typeof(v_ov -> v_key) = 'number' then (v_ov ->> v_key)::numeric end,
      'usage', v_usage));
  end loop;

  return jsonb_build_object(
    'plan', jsonb_build_object('id', v_plan.id, 'key', v_plan.key, 'name', v_plan.name, 'is_custom', v_plan.tenant_id is not null),
    'rows', v_rows,
    'can_edit', coalesce(internal_level(), 'admin') <> 'support');
end;
$$;

-- Guarda todos los overrides juntos. p_overrides: {clave: número | null}; null
-- quita el override (vuelve al límite del plan). Motivo obligatorio.
create or replace function internal_set_limit_overrides(p_tenant uuid, p_overrides jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_old    jsonb;
  v_new    jsonb;
  v_key    text;
  v_val    jsonb;
begin
  if not coalesce((select internal_scope()), false) or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_overrides is null or jsonb_typeof(p_overrides) <> 'object' then
    raise exception 'invalid_overrides' using errcode = '22023';
  end if;
  select limit_overrides into v_old from subscriptions where tenant_id = p_tenant for update;
  if not found then
    raise exception 'subscription_not_found' using errcode = 'P0002';
  end if;
  v_old := coalesce(v_old, '{}'::jsonb);
  v_new := v_old;
  for v_key, v_val in select key, value from jsonb_each(p_overrides) loop
    if v_key not in ('max_stores', 'max_registers_per_store', 'max_users', 'max_products', 'max_sales_per_month') then
      raise exception 'invalid_key' using errcode = '22023', detail = v_key;
    end if;
    if jsonb_typeof(v_val) = 'null' then
      v_new := v_new - v_key;
    elsif jsonb_typeof(v_val) = 'number' and (v_val #>> '{}')::numeric >= 0
          and (v_val #>> '{}')::numeric = trunc((v_val #>> '{}')::numeric)
          and (v_val #>> '{}')::numeric <= 100000000 then
      v_new := v_new || jsonb_build_object(v_key, (v_val #>> '{}')::numeric);
    else
      raise exception 'invalid_value' using errcode = '22023', detail = v_key;
    end if;
  end loop;

  if v_new = v_old then
    return v_new;
  end if;
  update subscriptions set limit_overrides = v_new, updated_at = now() where tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'subscriptions', p_tenant, 'limit_overrides_set',
          jsonb_build_object('overrides', v_old), jsonb_build_object('overrides', v_new), v_reason);
  return v_new;
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Configuración de cobro y cuentas para cobrar
-- -----------------------------------------------------------------------------
alter table platform_billing_settings
  add column if not exists payment_proof_email text,
  add column if not exists payment_proof_whatsapp text,
  add column if not exists notices_enabled boolean not null default false,
  add column if not exists notice_lead_days_default int not null default 5,
  add column if not exists statement_frequency_default text not null default 'per_period',
  add column if not exists statement_every_days_default int not null default 7,
  add column if not exists statement_day_default int not null default 1;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_billing_settings_notice_check') then
    alter table platform_billing_settings add constraint platform_billing_settings_notice_check check (
      notice_lead_days_default between 0 and 30
      and statement_frequency_default in ('per_period', 'every_n_days', 'monthly_day')
      and statement_every_days_default between 1 and 60
      and statement_day_default between 1 and 31
      and (payment_proof_email is null or payment_proof_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
      and (payment_proof_whatsapp is null or payment_proof_whatsapp ~ '^\+?[0-9 ()-]{8,20}$'));
  end if;
end
$c$;

-- CBU / CVU: 22 dígitos con los dos dígitos verificadores (mismo algoritmo
-- que isValidCbu de lib/purchases/suppliers.ts).
create or replace function platform_cbu_valid(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d  text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  w1 int[] := array[7, 1, 3, 9, 7, 1, 3];
  w2 int[] := array[3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  s  int := 0;
  i  int;
begin
  if length(d) <> 22 then
    return false;
  end if;
  for i in 1..7 loop
    s := s + substr(d, i, 1)::int * w1[i];
  end loop;
  if (10 - s % 10) % 10 <> substr(d, 8, 1)::int then
    return false;
  end if;
  s := 0;
  for i in 1..13 loop
    s := s + substr(d, 8 + i, 1)::int * w2[i];
  end loop;
  return (10 - s % 10) % 10 = substr(d, 22, 1)::int;
end;
$$;

create table if not exists platform_bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  bank_slug     text,
  bank_name     text not null check (length(btrim(bank_name)) between 1 and 80),
  holder_name   text not null check (length(btrim(holder_name)) between 1 and 120),
  cuit          text check (cuit is null or cuit ~ '^\d{11}$'),
  cbu           text check (cbu is null or platform_cbu_valid(cbu)),
  alias         text check (alias is null or alias ~ '^[A-Za-z0-9.-]{6,20}$'),
  account_type  text not null default 'cuenta_corriente'
                  check (account_type in ('caja_ahorro', 'cuenta_corriente', 'cuenta_virtual', 'otra')),
  currency      text not null default 'ARS' check (currency = 'ARS'),
  note          text check (note is null or length(note) <= 200),
  is_default    boolean not null default false,
  is_active     boolean not null default true,
  sort          int not null default 0,
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint platform_bank_accounts_has_key check (cbu is not null or alias is not null)
);
create unique index if not exists platform_bank_accounts_default_uidx
  on platform_bank_accounts ((true)) where is_default and deleted_at is null;
create index if not exists platform_bank_accounts_created_by_idx on platform_bank_accounts (created_by);
create index if not exists platform_bank_accounts_updated_by_idx on platform_bank_accounts (updated_by);
drop trigger if exists set_updated_at_platform_bank_accounts on platform_bank_accounts;
create trigger set_updated_at_platform_bank_accounts
  before update on platform_bank_accounts
  for each row execute function set_updated_at();

alter table platform_bank_accounts enable row level security;
drop policy if exists platform_bank_accounts_staff on platform_bank_accounts;
create policy platform_bank_accounts_staff on platform_bank_accounts
  for select to authenticated using ((select internal_scope()));
revoke all on table platform_bank_accounts from anon;
revoke insert, update, delete, truncate on table platform_bank_accounts from authenticated;
grant select on table platform_bank_accounts to authenticated;

create or replace function platform_assert_super_admin()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(platform_staff_billing_role(), '') <> 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Alta o edición de una cuenta para cobrar (super_admin, §18.1).
-- p_data: {bank_slug, bank_name, holder_name, cuit, cbu, alias, account_type,
--          note, is_default, is_active, sort}
create or replace function internal_platform_bank_account_save(p_id uuid, p_data jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_id     uuid := p_id;
  v_cbu    text := nullif(regexp_replace(coalesce(p_data ->> 'cbu', ''), '\D', '', 'g'), '');
  v_cuit   text := nullif(regexp_replace(coalesce(p_data ->> 'cuit', ''), '\D', '', 'g'), '');
  v_alias  text := nullif(btrim(coalesce(p_data ->> 'alias', '')), '');
  v_def    boolean := coalesce((p_data ->> 'is_default')::boolean, false);
  v_active boolean := coalesce((p_data ->> 'is_active')::boolean, true);
begin
  perform platform_assert_super_admin();
  if v_cbu is not null and not platform_cbu_valid(v_cbu) then
    raise exception 'invalid_cbu' using errcode = '22023';
  end if;
  if v_alias is not null and v_alias !~ '^[A-Za-z0-9.-]{6,20}$' then
    raise exception 'invalid_alias' using errcode = '22023';
  end if;
  if v_cbu is null and v_alias is null then
    raise exception 'cbu_or_alias_required' using errcode = '22023';
  end if;
  if v_cuit is not null and length(v_cuit) <> 11 then
    raise exception 'invalid_cuit' using errcode = '22023';
  end if;
  if not v_active then
    v_def := false;
  end if;

  perform pg_advisory_xact_lock(hashtext('platform_bank_accounts'));
  if v_id is not null then
    select to_jsonb(a) into v_before from platform_bank_accounts a where a.id = v_id and a.deleted_at is null for update;
    if v_before is null then
      raise exception 'bank_account_not_found' using errcode = 'P0002';
    end if;
  end if;
  -- La primera cuenta activa queda por defecto.
  if v_active and not exists (select 1 from platform_bank_accounts where deleted_at is null and is_active and id is distinct from v_id) then
    v_def := true;
  end if;
  if v_def then
    update platform_bank_accounts set is_default = false, updated_by = auth.uid()
     where is_default and deleted_at is null and id is distinct from v_id;
  end if;

  if v_id is null then
    insert into platform_bank_accounts (bank_slug, bank_name, holder_name, cuit, cbu, alias, account_type, note,
                                        is_default, is_active, sort, created_by, updated_by)
    values (nullif(btrim(coalesce(p_data ->> 'bank_slug', '')), ''), btrim(coalesce(p_data ->> 'bank_name', '')),
            btrim(coalesce(p_data ->> 'holder_name', '')), v_cuit, v_cbu, v_alias,
            coalesce(nullif(p_data ->> 'account_type', ''), 'cuenta_corriente'),
            nullif(btrim(coalesce(p_data ->> 'note', '')), ''), v_def, v_active,
            coalesce((p_data ->> 'sort')::int, 0), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update platform_bank_accounts
       set bank_slug = nullif(btrim(coalesce(p_data ->> 'bank_slug', '')), ''),
           bank_name = btrim(coalesce(p_data ->> 'bank_name', '')),
           holder_name = btrim(coalesce(p_data ->> 'holder_name', '')),
           cuit = v_cuit, cbu = v_cbu, alias = v_alias,
           account_type = coalesce(nullif(p_data ->> 'account_type', ''), account_type),
           note = nullif(btrim(coalesce(p_data ->> 'note', '')), ''),
           is_default = v_def, is_active = v_active,
           sort = coalesce((p_data ->> 'sort')::int, sort),
           updated_by = auth.uid()
     where id = v_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  select null, auth.uid(), 'platform_bank_account', v_id,
         case when v_before is null then 'platform_bank_account_created' else 'platform_bank_account_updated' end,
         v_before, to_jsonb(a), v_reason
    from platform_bank_accounts a where a.id = v_id;
  return v_id;
end;
$$;

-- Baja lógica de una cuenta. Si era la de por defecto, pasa a la siguiente activa.
create or replace function internal_platform_bank_account_delete(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_row    platform_bank_accounts%rowtype;
  v_next   uuid;
begin
  perform platform_assert_super_admin();
  perform pg_advisory_xact_lock(hashtext('platform_bank_accounts'));
  select * into v_row from platform_bank_accounts where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'bank_account_not_found' using errcode = 'P0002';
  end if;
  update platform_bank_accounts
     set deleted_at = now(), is_default = false, is_active = false, updated_by = auth.uid()
   where id = p_id;
  if v_row.is_default then
    select id into v_next from platform_bank_accounts
     where deleted_at is null and is_active order by sort, created_at limit 1;
    if v_next is not null then
      update platform_bank_accounts set is_default = true, updated_by = auth.uid() where id = v_next;
    end if;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, reason)
  values (null, auth.uid(), 'platform_bank_account', p_id, 'platform_bank_account_deleted', to_jsonb(v_row), v_reason);
end;
$$;

-- Email / WhatsApp de comprobantes y avisos por defecto (super_admin).
create or replace function internal_billing_set_collection_settings(p_data jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  perform platform_assert_super_admin();
  select to_jsonb(s) into v_before from platform_billing_settings s where id;
  update platform_billing_settings
     set payment_proof_email = case when p_data ? 'payment_proof_email'
                                    then nullif(lower(btrim(coalesce(p_data ->> 'payment_proof_email', ''))), '')
                                    else payment_proof_email end,
         payment_proof_whatsapp = case when p_data ? 'payment_proof_whatsapp'
                                       then nullif(btrim(coalesce(p_data ->> 'payment_proof_whatsapp', '')), '')
                                       else payment_proof_whatsapp end,
         notices_enabled = coalesce((p_data ->> 'notices_enabled')::boolean, notices_enabled),
         notice_lead_days_default = coalesce((p_data ->> 'notice_lead_days_default')::int, notice_lead_days_default),
         statement_frequency_default = coalesce(p_data ->> 'statement_frequency_default', statement_frequency_default),
         statement_every_days_default = coalesce((p_data ->> 'statement_every_days_default')::int, statement_every_days_default),
         statement_day_default = coalesce((p_data ->> 'statement_day_default')::int, statement_day_default),
         updated_at = now(),
         updated_by = auth.uid()
   where id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  select null, auth.uid(), 'platform_billing_settings', null, 'platform_billing_settings_set', v_before, to_jsonb(s), v_reason
    from platform_billing_settings s where id;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Condiciones por negocio: avisos y destinatarios; modalidad pendiente
-- -----------------------------------------------------------------------------
alter table tenant_billing_terms
  add column if not exists pending_mode text check (pending_mode in ('mp_subscription')),
  add column if not exists pending_since timestamptz,
  add column if not exists statement_frequency text check (statement_frequency in ('per_period', 'every_n_days', 'monthly_day')),
  add column if not exists statement_every_days int check (statement_every_days between 1 and 60),
  add column if not exists statement_day int check (statement_day between 1 and 31),
  add column if not exists notice_lead_days int check (notice_lead_days between 0 and 30),
  add column if not exists send_to text[] not null default '{}',
  add column if not exists cc text[] not null default '{}';

create index if not exists tenant_billing_terms_created_by_idx on tenant_billing_terms (created_by);
create index if not exists tenant_billing_terms_updated_by_idx on tenant_billing_terms (updated_by);

-- platform_effective_billing_mode no cambia: pending_mode no cuenta hasta el
-- primer débito aprobado (trigger de D).

-- Condiciones de cobro sin cambiar la modalidad: el cambio de modalidad pasa
-- por internal_billing_change_mode (cancela o pide el preapproval de MP).
create or replace function internal_billing_set_terms(
  p_tenant        uuid,
  p_billing_mode  text,
  p_exempt_reason text,
  p_due_days      int,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_after  jsonb;
  v_mode   text;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_due_days is not null and (p_due_days < 0 or p_due_days > 60) then
    raise exception 'invalid_due_days' using errcode = '22023';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  select billing_mode into v_mode from tenant_billing_terms where tenant_id = p_tenant;
  if v_mode is distinct from p_billing_mode then
    raise exception 'use_mode_change' using errcode = '22023',
      detail = 'La modalidad se cambia con internal_billing_change_mode';
  end if;

  select to_jsonb(bt) - 'id' into v_before from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into tenant_billing_terms (tenant_id, billing_mode, due_days, created_by, updated_by)
  values (p_tenant, p_billing_mode, p_due_days, auth.uid(), auth.uid())
  on conflict (tenant_id) do update
     set due_days = excluded.due_days,
         exempt_reason = case when tenant_billing_terms.billing_mode = 'exempt' and p_exempt_reason is not null
                                   and length(btrim(p_exempt_reason)) >= 5
                              then btrim(p_exempt_reason) else tenant_billing_terms.exempt_reason end,
         updated_by = auth.uid();
  select to_jsonb(bt) - 'id' into v_after from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_billing_terms', p_tenant, 'tenant_billing_terms_set', v_before, v_after, v_reason);
end;
$$;

-- Aviso de cobro del negocio: frecuencia, días antes del vencimiento y a qué
-- emails. null = el default de la plataforma. admin, super_admin o Cobranzas.
create or replace function internal_billing_set_notice_terms(
  p_tenant      uuid,
  p_frequency   text,
  p_every_days  int,
  p_day         int,
  p_lead_days   int,
  p_send_to     text[],
  p_cc          text[],
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_after  jsonb;
  v_to     text[];
  v_cc     text[];
  v_e      text;
begin
  perform platform_assert_billing_operator();
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_frequency is not null and p_frequency not in ('per_period', 'every_n_days', 'monthly_day') then
    raise exception 'invalid_frequency' using errcode = '22023';
  end if;
  if (p_every_days is not null and p_every_days not between 1 and 60)
     or (p_day is not null and p_day not between 1 and 31)
     or (p_lead_days is not null and p_lead_days not between 0 and 30) then
    raise exception 'invalid_notice_terms' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct lower(btrim(e))) filter (where btrim(e) <> ''), '{}') into v_to from unnest(coalesce(p_send_to, '{}')) e;
  select coalesce(array_agg(distinct lower(btrim(e))) filter (where btrim(e) <> ''), '{}') into v_cc from unnest(coalesce(p_cc, '{}')) e;
  if cardinality(v_to) > 5 or cardinality(v_cc) > 5 then
    raise exception 'too_many_recipients' using errcode = '22023';
  end if;
  foreach v_e in array v_to || v_cc loop
    if v_e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'invalid_email' using errcode = '22023', detail = v_e;
    end if;
  end loop;

  select to_jsonb(bt) - 'id' into v_before from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into tenant_billing_terms (tenant_id, statement_frequency, statement_every_days, statement_day, notice_lead_days,
                                    send_to, cc, created_by, updated_by)
  values (p_tenant, p_frequency, p_every_days, p_day, p_lead_days, v_to, v_cc, auth.uid(), auth.uid())
  on conflict (tenant_id) do update
     set statement_frequency = excluded.statement_frequency,
         statement_every_days = excluded.statement_every_days,
         statement_day = excluded.statement_day,
         notice_lead_days = excluded.notice_lead_days,
         send_to = excluded.send_to,
         cc = excluded.cc,
         updated_by = auth.uid();
  select to_jsonb(bt) - 'id' into v_after from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_billing_terms', p_tenant, 'tenant_billing_notice_terms_set', v_before, v_after, v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- D) Cambio de modalidad
-- -----------------------------------------------------------------------------
create table if not exists platform_billing_mode_changes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete restrict,
  from_mode         text,
  to_mode           text not null check (to_mode in ('mp_subscription', 'account', 'manual', 'exempt')),
  -- applied: rige; pending_checkout: espera el primer débito de MP;
  -- pending_mp_cancel: rige, pero falta confirmar la baja del preapproval;
  -- cancelled: reemplazado por otro cambio antes de completarse.
  status            text not null check (status in ('applied', 'pending_checkout', 'pending_mp_cancel', 'cancelled')),
  source            text not null default 'staff' check (source in ('staff', 'invite_code', 'system')),
  mp_preapproval_id text,
  mp_cancel_status  text check (mp_cancel_status in ('cancelled', 'failed', 'not_needed')),
  mp_detail         text,
  payment_id        uuid references platform_payments(id) on delete restrict,
  reason            text,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists platform_billing_mode_changes_tenant_idx on platform_billing_mode_changes (tenant_id, created_at desc);
create index if not exists platform_billing_mode_changes_pending_idx on platform_billing_mode_changes (tenant_id) where status in ('pending_checkout', 'pending_mp_cancel');
create index if not exists platform_billing_mode_changes_payment_idx on platform_billing_mode_changes (payment_id);
create index if not exists platform_billing_mode_changes_created_by_idx on platform_billing_mode_changes (created_by);
drop trigger if exists set_updated_at_platform_billing_mode_changes on platform_billing_mode_changes;
create trigger set_updated_at_platform_billing_mode_changes
  before update on platform_billing_mode_changes
  for each row execute function set_updated_at();

alter table platform_billing_mode_changes enable row level security;
drop policy if exists platform_billing_mode_changes_staff on platform_billing_mode_changes;
create policy platform_billing_mode_changes_staff on platform_billing_mode_changes
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_billing_mode_changes_owner on platform_billing_mode_changes;
create policy platform_billing_mode_changes_owner on platform_billing_mode_changes
  for select to authenticated using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
revoke all on table platform_billing_mode_changes from anon;
revoke insert, update, delete, truncate on table platform_billing_mode_changes from authenticated;
grant select on table platform_billing_mode_changes to authenticated;

-- Modalidad guardada o derivada (sin mirar exclusiones): la que el staff ve
-- como "actual" al cambiarla.
create or replace function platform_stored_billing_mode(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(bt.billing_mode,
                  case when nullif(btrim(coalesce(s.mp_preapproval_id, '')), '') is not null then 'mp_subscription' else 'manual' end)
    from (select p_tenant as id) x
    left join subscriptions s on s.tenant_id = x.id
    left join tenant_billing_terms bt on bt.tenant_id = x.id;
$$;

-- Cambia la modalidad en cualquier sentido. Devuelve qué tiene que hacer la UI:
--   needs_mp_cancel: cancelar el preapproval con mp_subscription_pause
--                    (action 'cancel') e informar el resultado con
--                    internal_billing_mode_change_mp_result;
--   needs_checkout:  generar el checkout con mp_subscription_checkout; el
--                    negocio sigue en su modalidad hasta el primer débito.
create or replace function internal_billing_change_mode(
  p_tenant        uuid,
  p_to            text,
  p_due_days      int,
  p_exempt_reason text,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := platform_staff_billing_role();
  v_reason  text := platform_assert_reason(p_reason);
  v_terms   tenant_billing_terms%rowtype;
  v_has     boolean;
  v_from    text;
  v_pre     text;
  v_status  text;
  v_change  uuid;
  v_before  jsonb;
  v_after   jsonb;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_to is null or p_to not in ('mp_subscription', 'account', 'manual', 'exempt') then
    raise exception 'invalid_billing_mode' using errcode = '22023';
  end if;
  if p_to = 'exempt' and v_role <> 'super_admin' then
    raise exception 'forbidden_exempt' using errcode = '42501';
  end if;
  if p_to = 'exempt' and length(btrim(coalesce(p_exempt_reason, ''))) < 5 then
    raise exception 'exempt_reason_required' using errcode = '22023';
  end if;
  if p_due_days is not null and (p_due_days < 0 or p_due_days > 60) then
    raise exception 'invalid_due_days' using errcode = '22023';
  end if;
  if not exists (select 1 from tenants where id = p_tenant and deleted_at is null) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;

  perform platform_lock_tenant(p_tenant);
  select * into v_terms from tenant_billing_terms where tenant_id = p_tenant for update;
  v_has := found;
  v_from := platform_stored_billing_mode(p_tenant);
  select nullif(btrim(coalesce(mp_preapproval_id, '')), '') into v_pre from subscriptions where tenant_id = p_tenant;

  if p_to = v_from and v_terms.pending_mode is null then
    raise exception 'same_mode' using errcode = '22023';
  end if;
  if p_to = 'mp_subscription' and v_terms.pending_mode = 'mp_subscription' then
    raise exception 'mode_change_pending' using errcode = '22023';
  end if;
  v_before := case when v_has then to_jsonb(v_terms) - 'id' end;

  -- Un cambio a MP que no se completó queda reemplazado por este.
  update platform_billing_mode_changes
     set status = 'cancelled', completed_at = now()
   where tenant_id = p_tenant and status = 'pending_checkout';

  if p_to = 'mp_subscription' then
    -- La modalidad actual queda explícita: el preapproval que guarda el
    -- checkout no la cambia hasta que llegue el primer débito.
    insert into tenant_billing_terms (tenant_id, billing_mode, due_days, pending_mode, pending_since, created_by, updated_by)
    values (p_tenant, v_from, p_due_days, 'mp_subscription', now(), auth.uid(), auth.uid())
    on conflict (tenant_id) do update
       set billing_mode = v_from,
           due_days = coalesce(p_due_days, tenant_billing_terms.due_days),
           pending_mode = 'mp_subscription',
           pending_since = now(),
           updated_by = auth.uid();
    v_status := 'pending_checkout';
  else
    insert into tenant_billing_terms (tenant_id, billing_mode, exempt_reason, due_days, created_by, updated_by)
    values (p_tenant, p_to, case when p_to = 'exempt' then btrim(p_exempt_reason) end, p_due_days, auth.uid(), auth.uid())
    on conflict (tenant_id) do update
       set billing_mode = p_to,
           exempt_reason = case when p_to = 'exempt' then btrim(p_exempt_reason) end,
           due_days = coalesce(p_due_days, tenant_billing_terms.due_days),
           pending_mode = null,
           pending_since = null,
           updated_by = auth.uid();
    v_status := case when v_pre is not null then 'pending_mp_cancel' else 'applied' end;
  end if;

  insert into platform_billing_mode_changes (tenant_id, from_mode, to_mode, status, source, mp_preapproval_id,
                                             mp_cancel_status, reason, created_by, completed_at)
  values (p_tenant, v_from, p_to, v_status, 'staff', v_pre,
          case when p_to <> 'mp_subscription' and v_pre is null then 'not_needed' end,
          v_reason, auth.uid(), case when v_status = 'applied' then now() end)
  returning id into v_change;

  select to_jsonb(bt) - 'id' into v_after from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_billing_terms', v_change, 'billing_mode_change_requested', v_before,
          coalesce(v_after, '{}'::jsonb) || jsonb_build_object('from_mode', v_from, 'to_mode', p_to, 'status', v_status,
                                                                'mp_preapproval_id', v_pre, 'role', v_role),
          v_reason);

  return jsonb_build_object(
    'change_id', v_change, 'status', v_status, 'from_mode', v_from, 'to_mode', p_to,
    'needs_mp_cancel', v_status = 'pending_mp_cancel',
    'needs_checkout', v_status = 'pending_checkout',
    'mp_preapproval_id', v_pre);
end;
$$;

-- Resultado de cancelar el preapproval en Mercado Pago (lo informa la UI
-- después de llamar a mp_subscription_pause). ok: se olvida el preapproval
-- (el webhook ignora sus avisos) y el cambio queda aplicado. Falla: queda
-- pendiente para reintentar, con el detalle.
create or replace function internal_billing_mode_change_mp_result(p_change uuid, p_ok boolean, p_detail text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_staff_billing_role();
  v_ch   platform_billing_mode_changes%rowtype;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_ch from platform_billing_mode_changes where id = p_change for update;
  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_ch.status <> 'pending_mp_cancel' then
    return jsonb_build_object('status', v_ch.status);
  end if;
  if p_ok then
    update subscriptions set mp_preapproval_id = null, updated_at = now()
     where tenant_id = v_ch.tenant_id and mp_preapproval_id = v_ch.mp_preapproval_id;
    update platform_billing_mode_changes
       set status = 'applied', mp_cancel_status = 'cancelled', mp_detail = null, completed_at = now()
     where id = p_change;
  else
    update platform_billing_mode_changes
       set mp_cancel_status = 'failed', mp_detail = left(coalesce(p_detail, ''), 300)
     where id = p_change;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_ch.tenant_id, auth.uid(), 'tenant_billing_terms', p_change,
          case when p_ok then 'billing_mode_mp_cancelled' else 'billing_mode_mp_cancel_failed' end,
          jsonb_build_object('mp_preapproval_id', v_ch.mp_preapproval_id, 'detail', left(coalesce(p_detail, ''), 300)));
  return jsonb_build_object('status', case when p_ok then 'applied' else 'pending_mp_cancel' end);
end;
$$;

-- El primer débito aprobado de Mercado Pago completa el pase a MP. Nunca
-- bloquea el pago: si algo falla, se audita.
create or replace function trg_platform_payments_mode_switch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  if new.method <> 'mp_preapproval' or new.status <> 'approved' then
    return null;
  end if;
  begin
    update tenant_billing_terms
       set billing_mode = 'mp_subscription', pending_mode = null, pending_since = null, updated_by = null
     where tenant_id = new.tenant_id and pending_mode = 'mp_subscription'
    returning tenant_id into v_tenant;
    if v_tenant is not null then
      update platform_billing_mode_changes
         set status = 'applied', completed_at = now(), payment_id = new.id, mp_cancel_status = 'not_needed'
       where tenant_id = new.tenant_id and status = 'pending_checkout';
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (new.tenant_id, null, 'tenant_billing_terms', new.tenant_id, 'billing_mode_change_applied',
              jsonb_build_object('billing_mode', 'mp_subscription', 'payment_id', new.id, 'amount_cents', new.amount_cents));
    end if;
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'tenant_billing_terms', new.tenant_id, 'billing_mode_change_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate, 'payment_id', new.id));
  end;
  return null;
end;
$$;
drop trigger if exists platform_payments_mode_switch on platform_payments;
create trigger platform_payments_mode_switch after insert on platform_payments
  for each row execute function trg_platform_payments_mode_switch();

-- Para el webhook de MP: ¿hay que aplicar este aviso de preapproval a la
-- suscripción?
--   · No, si el preapproval ya no es el vigente (uno viejo que se canceló al
--     re-generar el checkout o al pasar a cuenta corriente).
--   · Con la modalidad Mercado Pago (o automática): sí, como siempre.
--   · Con otra modalidad: sólo la autorización de un pase pendiente a MP; las
--     pausas y cancelaciones no tocan el estado (la cuenta corriente manda).
create or replace function platform_mp_preapproval_applies(p_subscription uuid, p_preapproval text, p_mp_status text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when s.id is null then true
           when nullif(btrim(coalesce(s.mp_preapproval_id, '')), '') is not null
                and s.mp_preapproval_id <> coalesce(p_preapproval, '') then false
           when coalesce(bt.billing_mode, 'mp_subscription') = 'mp_subscription' then true
           when bt.pending_mode = 'mp_subscription' and p_mp_status = 'authorized' then true
           else false
         end
    from (select p_subscription as id) x
    left join subscriptions s on s.id = x.id
    left join tenant_billing_terms bt on bt.tenant_id = s.tenant_id;
$$;

-- -----------------------------------------------------------------------------
-- E) Códigos de invitación de cuenta corriente
-- -----------------------------------------------------------------------------
alter table invite_codes drop constraint if exists invite_codes_kind_check;
alter table invite_codes add constraint invite_codes_kind_check check (kind in ('lifetime', 'trial_days', 'account'));
alter table invite_codes
  add column if not exists due_days int check (due_days between 0 and 60),
  add column if not exists discount_percent numeric(5,2) check (discount_percent > 0 and discount_percent <= 100),
  add column if not exists discount_months int check (discount_months between 1 and 60),
  add column if not exists billing_cycle text check (billing_cycle in ('monthly', 'yearly')),
  add column if not exists notes text check (notes is null or length(notes) <= 300),
  add column if not exists updated_at timestamptz not null default now();
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'invite_codes_account_terms') then
    alter table invite_codes add constraint invite_codes_account_terms check (kind <> 'account' or due_days is not null);
  end if;
end
$c$;

-- Escritura sólo por RPC auditada (antes era CRUD directo con is_internal()).
drop policy if exists invite_codes_select on invite_codes;
drop policy if exists invite_codes_insert on invite_codes;
drop policy if exists invite_codes_update on invite_codes;
create policy invite_codes_select on invite_codes
  for select to authenticated using ((select internal_scope()));
revoke all on table invite_codes from anon;
revoke insert, update, delete, truncate on table invite_codes from authenticated;
grant select on table invite_codes to authenticated;

create or replace function platform_assert_invite_admin()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_staff_billing_role();
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

-- Alta de un código. p_data: {code, kind, plan_key, trial_days, max_uses,
-- valid_from, valid_until, due_days, discount_percent, discount_months,
-- billing_cycle, notes}
create or replace function internal_invite_code_create(p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_assert_invite_admin();
  v_code text := upper(btrim(coalesce(p_data ->> 'code', '')));
  v_kind text := coalesce(p_data ->> 'kind', '');
  v_plan text := btrim(coalesce(p_data ->> 'plan_key', ''));
  v_id   uuid;
begin
  if v_code !~ '^[A-Z0-9_-]{4,32}$' then
    raise exception 'invalid_code' using errcode = '22023';
  end if;
  if v_kind not in ('lifetime', 'trial_days', 'account') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if v_kind = 'lifetime' and v_role <> 'super_admin' then
    raise exception 'forbidden_lifetime' using errcode = '42501';
  end if;
  if not exists (select 1 from plans where key = v_plan and tenant_id is null and is_active) then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from invite_codes where upper(code) = v_code and deleted_at is null) then
    raise exception 'code_taken' using errcode = '23505';
  end if;
  if (p_data ->> 'valid_from') is not null and (p_data ->> 'valid_until') is not null
     and (p_data ->> 'valid_until')::date < (p_data ->> 'valid_from')::date then
    raise exception 'invalid_validity' using errcode = '22023';
  end if;

  insert into invite_codes (code, kind, plan_key, trial_days, max_uses, valid_from, valid_until, due_days,
                            discount_percent, discount_months, billing_cycle, notes, created_by)
  values (v_code, v_kind, v_plan,
          case when v_kind = 'trial_days' then coalesce((p_data ->> 'trial_days')::int, 14) end,
          nullif(p_data ->> 'max_uses', '')::int,
          nullif(p_data ->> 'valid_from', '')::date,
          nullif(p_data ->> 'valid_until', '')::date,
          case when v_kind = 'account' then coalesce(nullif(p_data ->> 'due_days', '')::int, 10) end,
          case when v_kind = 'account' then nullif(p_data ->> 'discount_percent', '')::numeric end,
          case when v_kind = 'account' and nullif(p_data ->> 'discount_percent', '') is not null
               then nullif(p_data ->> 'discount_months', '')::int end,
          case when v_kind = 'account' then coalesce(nullif(p_data ->> 'billing_cycle', ''), 'monthly') end,
          nullif(btrim(coalesce(p_data ->> 'notes', '')), ''),
          auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  select null, auth.uid(), 'invite_codes', v_id, 'invite_code_created', to_jsonb(c) from invite_codes c where c.id = v_id;
  return v_id;
end;
$$;

create or replace function internal_invite_code_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform platform_assert_invite_admin();
  select to_jsonb(c) into v_before from invite_codes c where c.id = p_id and c.deleted_at is null for update;
  if v_before is null then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  update invite_codes set is_active = coalesce(p_active, false), updated_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'invite_codes', p_id, 'invite_code_set_active', v_before,
          jsonb_build_object('is_active', coalesce(p_active, false)));
end;
$$;

create or replace function internal_invite_code_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform platform_assert_invite_admin();
  select to_jsonb(c) into v_before from invite_codes c where c.id = p_id and c.deleted_at is null for update;
  if v_before is null then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  update invite_codes set deleted_at = now(), is_active = false, updated_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (null, auth.uid(), 'invite_codes', p_id, 'invite_code_deleted', v_before);
end;
$$;

-- Canje (mismo contrato que 20260607230000) + kind 'account': el negocio queda
-- activo en cuenta corriente con el plan, el plazo y el descuento del código,
-- sin pasar por el checkout de Mercado Pago. El cron platform-billing-run
-- genera el primer cargo y el de avisos lo manda.
create or replace function redeem_invite_code(p_code text, p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code    invite_codes%rowtype;
  v_plan_id uuid;
  v_cycle   text;
  v_until   date;
  v_today   date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
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
  -- Un negocio canjea un solo código de cuenta corriente.
  if v_code.kind = 'account' and exists (
    select 1 from audit_logs a
     where a.tenant_id = p_tenant_id and a.action = 'invite_code_redeemed' and a.after_data ->> 'kind' = 'account'
  ) then
    raise exception 'code_already_redeemed';
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
  elsif v_code.kind = 'account' then
    v_cycle := coalesce(v_code.billing_cycle, 'monthly');
    -- Primero el plan (todavía en prueba: no prorratea) y después el período.
    update subscriptions set plan_id = v_plan_id, updated_at = now() where tenant_id = p_tenant_id;
    update subscriptions
       set status = 'active', is_lifetime = false, billing_cycle = v_cycle,
           cancel_at_period_end = false,
           current_period_start = now(),
           current_period_end = now() + case when v_cycle = 'yearly' then interval '12 months' else interval '1 month' end,
           updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants set status = 'active', trial_ends_at = null, updated_at = now()
     where id = p_tenant_id;

    insert into tenant_billing_terms (tenant_id, billing_mode, due_days, notes, created_by, updated_by)
    values (p_tenant_id, 'account', v_code.due_days, 'Alta con el código ' || v_code.code, auth.uid(), auth.uid())
    on conflict (tenant_id) do update
       set billing_mode = 'account', due_days = excluded.due_days, pending_mode = null, pending_since = null,
           notes = excluded.notes, updated_by = auth.uid();

    if v_code.discount_percent is not null then
      v_until := case when v_code.discount_months is not null
                      then (v_today + make_interval(months => v_code.discount_months))::date - 1 end;
      insert into tenant_discounts (tenant_id, kind, value, reason, valid_from, valid_until, created_by)
      values (p_tenant_id, 'percent', v_code.discount_percent, 'Código de invitación ' || v_code.code, v_today, v_until, auth.uid());
    end if;

    insert into platform_billing_mode_changes (tenant_id, from_mode, to_mode, status, source, mp_cancel_status,
                                               reason, created_by, completed_at)
    values (p_tenant_id, null, 'account', 'applied', 'invite_code', 'not_needed',
            'Alta con el código ' || v_code.code, auth.uid(), now());
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

  update invite_codes set used_count = used_count + 1, updated_at = now() where id = v_code.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'invite_codes', v_code.id, 'invite_code_redeemed',
          jsonb_build_object('code', v_code.code, 'kind', v_code.kind,
                             'plan', v_code.plan_key, 'trial_days', v_code.trial_days,
                             'due_days', v_code.due_days, 'discount_percent', v_code.discount_percent,
                             'discount_months', v_code.discount_months, 'billing_cycle', v_code.billing_cycle));

  return jsonb_build_object('kind', v_code.kind, 'plan', v_code.plan_key,
                            'trial_days', v_code.trial_days, 'due_days', v_code.due_days,
                            'discount_percent', v_code.discount_percent);
end;
$$;
revoke all on function redeem_invite_code(text, uuid) from public, anon;
grant execute on function redeem_invite_code(text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Avisos de cobro
-- -----------------------------------------------------------------------------
create table if not exists platform_billing_notices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  charge_id     uuid references platform_charges(id) on delete restrict,
  kind          text not null check (kind in ('notice', 'statement', 'manual')),
  notice_key    text not null unique,
  recipients    text[] not null default '{}',
  amount_cents  bigint not null check (amount_cents >= 0),
  due_date      date,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now()
);
create index if not exists platform_billing_notices_tenant_idx on platform_billing_notices (tenant_id, created_at desc);
create index if not exists platform_billing_notices_charge_idx on platform_billing_notices (charge_id);
create index if not exists platform_billing_notices_created_by_idx on platform_billing_notices (created_by);

alter table platform_billing_notices enable row level security;
drop policy if exists platform_billing_notices_staff on platform_billing_notices;
create policy platform_billing_notices_staff on platform_billing_notices
  for select to authenticated using ((select internal_scope()));
revoke all on table platform_billing_notices from anon;
revoke insert, update, delete, truncate on table platform_billing_notices from authenticated;
grant select on table platform_billing_notices to authenticated;
drop trigger if exists platform_billing_notices_no_update on platform_billing_notices;
create trigger platform_billing_notices_no_update before update or delete on platform_billing_notices
  for each row execute function platform_ledger_immutable();

create or replace function platform_html_escape(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

-- "$ 12.500,00" (espejo de formatArsCents).
create or replace function platform_format_ars(p_cents bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_cents < 0 then '-' else '' end || '$ ' ||
         replace(to_char(abs(p_cents) / 100, 'FM999,999,999,990'), ',', '.') || ',' ||
         lpad((abs(p_cents) % 100)::text, 2, '0')
$$;

-- Bloque de cuentas del email (espejo de bankBlockHtml).
create or replace function platform_bank_block_html()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a      record;
  v_out  text := '';
  v_rows text;
  row_tpl constant text := '<tr><td style="padding:10px 20px;%sfont-size:13px;line-height:18px;color:#6b7280">%s</td><td align="right" style="padding:10px 20px;%sfont-size:14px;line-height:18px;font-weight:700;color:#09051C">%s</td></tr>';
  hair   constant text := 'border-top:1px solid #ecebf3;';
begin
  for a in
    select * from platform_bank_accounts
     where deleted_at is null and is_active
     order by is_default desc, sort, created_at
  loop
    v_rows := format(row_tpl, '', 'Titular', '', platform_html_escape(a.holder_name));
    if a.cuit is not null then
      v_rows := v_rows || format(row_tpl, hair, 'CUIT', hair, platform_html_escape(a.cuit));
    end if;
    if a.cbu is not null then
      v_rows := v_rows || format(row_tpl, hair, case when a.cbu like '000%' then 'CVU' else 'CBU' end, hair, platform_html_escape(a.cbu));
    end if;
    if a.alias is not null then
      v_rows := v_rows || format(row_tpl, hair, 'Alias', hair, platform_html_escape(a.alias));
    end if;
    v_out := v_out ||
      '<p style="margin:16px 0 8px;font-size:14px;line-height:20px;font-weight:700;color:#09051C">' || platform_html_escape(a.bank_name) || '</p>' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f6fb" style="background:#f7f6fb;border-radius:16px">' ||
      v_rows || '</table>';
  end loop;
  if v_out = '' then
    return '';
  end if;
  return '<p style="margin:8px 0 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280">Datos para transferir</p>' || v_out;
end;
$$;

-- Línea "mandanos el comprobante a ..." (espejo de proofContactHtml).
create or replace function platform_proof_contact_html()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_e text;
  v_w text;
  v_parts text[] := '{}';
begin
  select nullif(btrim(coalesce(payment_proof_email, '')), ''), nullif(btrim(coalesce(payment_proof_whatsapp, '')), '')
    into v_e, v_w
    from platform_billing_settings where id;
  if v_e is null and v_w is null then
    return '';
  end if;
  if v_e is not null then
    v_parts := v_parts || ('<a href="mailto:' || platform_html_escape(v_e) || '" style="color:#09051C;font-weight:700">' || platform_html_escape(v_e) || '</a>');
  end if;
  if v_w is not null then
    v_parts := v_parts || ('<a href="https://wa.me/' || regexp_replace(v_w, '\D', '', 'g') || '" style="color:#09051C;font-weight:700">WhatsApp ' || platform_html_escape(v_w) || '</a>');
  end if;
  return '<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#6b7280">Cuando transfieras, mandanos el comprobante a ' ||
         array_to_string(v_parts, ' o ') || ' o subilo desde tu panel con el botón Ya transferí.</p>';
end;
$$;

-- Destinatarios del aviso: send_to del negocio o, si no hay, los dueños activos.
create or replace function platform_notice_recipients(p_tenant uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when cardinality(bt.send_to) > 0 then bt.send_to || coalesce(bt.cc, '{}') end
       from tenant_billing_terms bt where bt.tenant_id = p_tenant),
    (select coalesce(array_agg(distinct lower(u.email)) filter (where u.email is not null and u.email <> ''), '{}')
       from tenant_users tu join users u on u.id = tu.user_id
      where tu.tenant_id = p_tenant and tu.role = 'owner' and tu.status = 'active')
    || coalesce((select bt.cc from tenant_billing_terms bt where bt.tenant_id = p_tenant), '{}'));
$$;

-- Manda un aviso (idempotente por clave). Devuelve true si salió.
create or replace function platform_send_notice(
  p_tenant  uuid,
  p_charge  uuid,
  p_kind    text,
  p_key     text,
  p_amount  bigint,
  p_due     date,
  p_period  text,
  p_actor   uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_to    text[] := platform_notice_recipients(p_tenant);
  v_t     tenants%rowtype;
  v_vars  jsonb;
  v_r     text;
  v_id    uuid;
begin
  if cardinality(v_to) = 0 or p_amount <= 0 then
    return false;
  end if;
  insert into platform_billing_notices (tenant_id, charge_id, kind, notice_key, recipients, amount_cents, due_date, created_by)
  values (p_tenant, p_charge, p_kind, p_key, v_to, p_amount, p_due, p_actor)
  on conflict (notice_key) do nothing
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  select * into v_t from tenants where id = p_tenant;
  v_vars := jsonb_build_object(
    'negocio', platform_html_escape(v_t.name),
    'logo_url', '',
    'monto', platform_format_ars(p_amount),
    'vence', coalesce(to_char(p_due, 'DD/MM/YYYY'), 'hoy'),
    'periodo', platform_html_escape(coalesce(p_period, 'tu suscripción')),
    'referencia', 'NS-' || upper(regexp_replace(coalesce(v_t.slug, ''), '[^A-Za-z0-9-]', '', 'g')),
    'datos_bancarios', platform_bank_block_html(),
    'comprobante', platform_proof_contact_html(),
    'link', 'https://pos.soft.ninja/dashboard-team#estado-de-cuenta');
  foreach v_r in array v_to loop
    perform enqueue_system_email(
      p_tenant, v_r, 'platform_payment_notice', v_vars,
      'Aviso de cobro de NinjaPos: ' || platform_format_ars(p_amount),
      _dunning_email_html(v_t.name, 'Aviso de cobro',
        'Tu cuota de ' || platform_format_ars(p_amount) || ' vence el ' || coalesce(to_char(p_due, 'DD/MM/YYYY'), 'hoy') ||
        '. Los datos para transferir están en tu panel, en Estado de cuenta.'));
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_actor, 'platform_billing_notice', v_id, 'platform_payment_notice_sent',
          jsonb_build_object('kind', p_kind, 'amount_cents', p_amount, 'due_date', p_due, 'recipients', v_to, 'charge_id', p_charge));
  return true;
end;
$$;

-- Clave del aviso de una cuota (espejo de noticeKey de lib/billing/paymentNotice.ts).
create or replace function platform_notice_key(p_frequency text, p_lead int, p_every int, p_charge uuid, p_due date, p_today date)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when p_frequency = 'monthly_day' then null
           when p_today < p_due - greatest(coalesce(p_lead, 0), 0) then null
           when p_frequency = 'per_period' then 'notice:' || p_charge::text
           else 'notice:' || p_charge::text || ':' ||
                ((p_today - (p_due - greatest(coalesce(p_lead, 0), 0))) / greatest(coalesce(p_every, 1), 1))::text
         end
$$;

-- Cron diario: avisos de los negocios en cuenta corriente.
create or replace function platform_send_payment_notices(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set    platform_billing_settings%rowtype;
  v_today  date := platform_ar_date(p_now);
  r        record;
  c        record;
  v_freq   text;
  v_lead   int;
  v_every  int;
  v_day    int;
  v_key    text;
  v_open   bigint;
  v_sent   int := 0;
  v_errors int := 0;
  v_last   int;
  v_due    date;
begin
  select * into v_set from platform_billing_settings where id;
  if not coalesce(v_set.notices_enabled, false) then
    return jsonb_build_object('enabled', false);
  end if;
  for r in
    select t.id, bt.statement_frequency, bt.statement_every_days, bt.statement_day, bt.notice_lead_days
      from tenants t
      left join tenant_billing_terms bt on bt.tenant_id = t.id
     where t.deleted_at is null
       and platform_effective_billing_mode(t.id) = 'account'
  loop
    begin
      v_freq := coalesce(r.statement_frequency, v_set.statement_frequency_default);
      v_lead := coalesce(r.notice_lead_days, v_set.notice_lead_days_default);
      v_every := coalesce(r.statement_every_days, v_set.statement_every_days_default);
      v_day := coalesce(r.statement_day, v_set.statement_day_default);
      if v_freq = 'monthly_day' then
        select coalesce(sum(platform_movement_open_cents(l.id)), 0), min(coalesce(l.due_date, l.effective_date))
          into v_open, v_due
          from platform_ledger l where l.tenant_id = r.id and l.amount_cents > 0;
        v_last := extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))::int;
        if v_open > 0 and extract(day from v_today)::int >= least(v_day, v_last) then
          v_key := 'statement:' || r.id::text || ':' || to_char(v_today, 'YYYY-MM');
          if platform_send_notice(r.id, null, 'statement', v_key, v_open, null, 'tu saldo con NinjaSoft', null) then
            v_sent := v_sent + 1;
          end if;
        end if;
      else
        for c in
          select ch.id, ch.due_date, ch.description, platform_movement_open_cents(l.id) as open_cents
            from platform_charges ch
            join platform_ledger l on l.charge_id = ch.id and l.kind = 'charge'
           where ch.tenant_id = r.id
             and ch.status in ('open', 'partially_paid')
             and ch.voided_at is null
           order by ch.due_date
        loop
          continue when c.open_cents <= 0;
          v_key := platform_notice_key(v_freq, v_lead, v_every, c.id, c.due_date, v_today);
          continue when v_key is null;
          if platform_send_notice(r.id, c.id, 'notice', v_key, c.open_cents, c.due_date, c.description, null) then
            v_sent := v_sent + 1;
          end if;
        end loop;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.id, null, 'platform_billing_notice', null, 'platform_payment_notice_failed',
              jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate));
    end;
  end loop;
  return jsonb_build_object('enabled', true, 'sent', v_sent, 'errors', v_errors, 'today', v_today);
end;
$$;

-- Envío manual del aviso con el saldo pendiente (staff con Cobranzas o admin).
create or replace function internal_billing_send_notice(p_tenant uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_open   bigint;
  v_due    date;
  v_ok     boolean;
begin
  perform platform_assert_billing_operator();
  select coalesce(sum(platform_movement_open_cents(l.id)), 0), min(coalesce(l.due_date, l.effective_date))
    into v_open, v_due
    from platform_ledger l where l.tenant_id = p_tenant and l.amount_cents > 0;
  if v_open <= 0 then
    raise exception 'nothing_to_collect' using errcode = '22023';
  end if;
  if cardinality(platform_notice_recipients(p_tenant)) = 0 then
    raise exception 'no_recipients' using errcode = '22023';
  end if;
  v_ok := platform_send_notice(p_tenant, null, 'manual', 'manual:' || p_tenant::text || ':' || gen_random_uuid()::text,
                               v_open, v_due, 'tu saldo con NinjaSoft', auth.uid());
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_billing_notice', null, 'platform_payment_notice_manual',
          jsonb_build_object('amount_cents', v_open, 'sent', v_ok), v_reason);
  return jsonb_build_object('sent', v_ok, 'amount_cents', v_open);
end;
$$;

-- -----------------------------------------------------------------------------
-- G) Transferencias informadas por el negocio ("Ya transferí")
-- -----------------------------------------------------------------------------
create table if not exists platform_transfer_reports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  amount_cents     bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  currency         text not null default 'ARS' check (currency = 'ARS'),
  paid_on          date not null,
  bank_account_id  uuid references platform_bank_accounts(id) on delete restrict,
  reference        text check (reference is null or length(reference) <= 80),
  note             text check (note is null or length(note) <= 300),
  proof_path       text not null,
  proof_sha256     text check (proof_sha256 is null or proof_sha256 ~ '^[0-9a-f]{64}$'),
  proof_mime       text check (proof_mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reported_by      uuid references users(id),
  verified_by      uuid references users(id),
  verified_at      timestamptz,
  reject_reason    text,
  payment_id       uuid references platform_payments(id) on delete restrict,
  approved_cents   bigint check (approved_cents > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint platform_transfer_reports_path check (proof_path like tenant_id::text || '/%'),
  constraint platform_transfer_reports_reject check (status <> 'rejected' or length(btrim(coalesce(reject_reason, ''))) >= 5)
);
create index if not exists platform_transfer_reports_tenant_idx on platform_transfer_reports (tenant_id, created_at desc);
create index if not exists platform_transfer_reports_pending_idx on platform_transfer_reports (created_at) where status = 'pending';
create index if not exists platform_transfer_reports_bank_idx on platform_transfer_reports (bank_account_id);
create index if not exists platform_transfer_reports_payment_idx on platform_transfer_reports (payment_id);
create index if not exists platform_transfer_reports_reported_by_idx on platform_transfer_reports (reported_by);
create index if not exists platform_transfer_reports_verified_by_idx on platform_transfer_reports (verified_by);
-- El mismo comprobante no se informa dos veces (§17.8).
create unique index if not exists platform_transfer_reports_hash_uidx
  on platform_transfer_reports (tenant_id, proof_sha256) where proof_sha256 is not null and status in ('pending', 'approved');
drop trigger if exists set_updated_at_platform_transfer_reports on platform_transfer_reports;
create trigger set_updated_at_platform_transfer_reports
  before update on platform_transfer_reports
  for each row execute function set_updated_at();

alter table platform_transfer_reports enable row level security;
drop policy if exists platform_transfer_reports_staff on platform_transfer_reports;
create policy platform_transfer_reports_staff on platform_transfer_reports
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_transfer_reports_owner on platform_transfer_reports;
create policy platform_transfer_reports_owner on platform_transfer_reports
  for select to authenticated using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
revoke all on table platform_transfer_reports from anon;
revoke insert, update, delete, truncate on table platform_transfer_reports from authenticated;
grant select on table platform_transfer_reports to authenticated;

-- Bucket privado de comprobantes: el dueño sube en la carpeta de su negocio,
-- el dueño o encargado lee lo suyo y el staff lee todo desde el panel interno.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('platform-payment-proofs', 'platform-payment-proofs', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "platform_payment_proofs_read" on storage.objects;
drop policy if exists "platform_payment_proofs_write" on storage.objects;
create policy "platform_payment_proofs_read" on storage.objects for select to authenticated
  using (bucket_id = 'platform-payment-proofs'
         and (((storage.foldername(name))[1] = (select current_tenant_id())::text and (select is_tenant_manager()))
              or (select internal_scope())));
create policy "platform_payment_proofs_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'platform-payment-proofs'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and (select is_tenant_owner()));

-- El dueño informa una transferencia con su comprobante (ya subido al bucket).
create or replace function owner_report_transfer(
  p_amount_cents  bigint,
  p_paid_on       date,
  p_bank_account  uuid,
  p_reference     text,
  p_note          text,
  p_proof_path    text,
  p_proof_sha256  text,
  p_proof_mime    text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_today  date := platform_ar_date(now());
  v_id     uuid;
  v_t      tenants%rowtype;
  v_email  text;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_today - 120 then
    raise exception 'invalid_paid_on' using errcode = '22023';
  end if;
  if p_proof_path is null or p_proof_path not like v_tid::text || '/%' or p_proof_path like '%..%' then
    raise exception 'invalid_proof' using errcode = '22023';
  end if;
  if p_bank_account is not null and not exists (
    select 1 from platform_bank_accounts where id = p_bank_account and deleted_at is null and is_active) then
    raise exception 'bank_account_not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from platform_transfer_reports where tenant_id = v_tid and status = 'pending') >= 10 then
    raise exception 'too_many_pending' using errcode = '22023';
  end if;
  if p_proof_sha256 is not null and exists (
    select 1 from platform_transfer_reports
     where tenant_id = v_tid and proof_sha256 = lower(p_proof_sha256) and status in ('pending', 'approved')) then
    raise exception 'duplicate_proof' using errcode = '23505';
  end if;

  insert into platform_transfer_reports (tenant_id, amount_cents, paid_on, bank_account_id, reference, note,
                                         proof_path, proof_sha256, proof_mime, reported_by)
  values (v_tid, p_amount_cents, p_paid_on, p_bank_account, nullif(btrim(coalesce(p_reference, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), p_proof_path, lower(nullif(p_proof_sha256, '')), p_proof_mime, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tid, auth.uid(), 'platform_transfer_report', v_id, 'platform_transfer_reported',
          jsonb_build_object('amount_cents', p_amount_cents, 'paid_on', p_paid_on, 'bank_account_id', p_bank_account,
                             'reference', p_reference));

  -- Aviso al email que recibe los comprobantes (si está cargado).
  select nullif(btrim(coalesce(payment_proof_email, '')), '') into v_email from platform_billing_settings where id;
  if v_email is not null then
    select * into v_t from tenants where id = v_tid;
    perform enqueue_system_email(
      v_tid, v_email, 'platform_transfer_reported',
      jsonb_build_object('negocio', platform_html_escape(v_t.name), 'logo_url', '',
                         'monto', platform_format_ars(p_amount_cents), 'fecha', to_char(p_paid_on, 'DD/MM/YYYY'),
                         'referencia', platform_html_escape(coalesce(nullif(btrim(coalesce(p_reference, '')), ''), 'Sin referencia')),
                         'link', 'https://pos.soft.ninja/internal/cobranza?vista=pagos'),
      v_t.name || ' informó una transferencia',
      _dunning_email_html('NinjaSoft', 'Transferencia informada',
        v_t.name || ' informó una transferencia de ' || platform_format_ars(p_amount_cents) || '. Verificala en Cobranzas.'));
  end if;
  return v_id;
end;
$$;

-- El dueño retira un aviso pendiente (lo cargó mal).
create or replace function owner_cancel_transfer_report(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid uuid := current_tenant_id();
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update platform_transfer_reports set status = 'cancelled'
   where id = p_id and tenant_id = v_tid and status = 'pending';
  if not found then
    raise exception 'report_not_pending' using errcode = '22023';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tid, auth.uid(), 'platform_transfer_report', p_id, 'platform_transfer_report_cancelled', '{}'::jsonb);
end;
$$;

-- El staff verifica: aprobar imputa el pago (billing_records → ledger, FIFO);
-- rechazar pide motivo y le avisa al negocio. p_amount_cents permite acreditar
-- lo que efectivamente entró si difiere de lo informado.
create or replace function internal_billing_verify_transfer(
  p_report       uuid,
  p_approve      boolean,
  p_amount_cents bigint,
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_rep    platform_transfer_reports%rowtype;
  v_cents  bigint;
  v_br     uuid;
  v_pay    uuid;
  v_t      tenants%rowtype;
  v_before bigint;
  v_r      text;
begin
  select * into v_rep from platform_transfer_reports where id = p_report for update;
  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if v_rep.status <> 'pending' then
    raise exception 'report_not_pending' using errcode = '22023';
  end if;
  select * into v_t from tenants where id = v_rep.tenant_id;

  if p_approve then
    v_cents := coalesce(p_amount_cents, v_rep.amount_cents);
    if v_cents <= 0 or v_cents > 100000000000 then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;
    perform platform_lock_tenant(v_rep.tenant_id);
    v_before := platform_tenant_balance(v_rep.tenant_id);
    insert into billing_records (tenant_id, amount, currency, medium, receipt_ref, notes, recorded_by, paid_at)
    values (v_rep.tenant_id, v_cents / 100.0, 'ARS', 'bank_transfer',
            coalesce(v_rep.reference, 'TRF-' || left(v_rep.id::text, 8)),
            'Transferencia informada por el negocio · ' || v_reason, auth.uid(),
            (v_rep.paid_on::timestamp + interval '12 hours') at time zone 'America/Argentina/Buenos_Aires')
    returning id into v_br;
    select payment_id into v_pay from platform_ingest_log where billing_record_id = v_br;
    if v_pay is null then
      raise exception 'ledger_ingest_failed' using errcode = 'P0001';
    end if;
    update platform_transfer_reports
       set status = 'approved', verified_by = auth.uid(), verified_at = now(), payment_id = v_pay, approved_cents = v_cents
     where id = p_report;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (v_rep.tenant_id, auth.uid(), 'platform_transfer_report', p_report, 'platform_transfer_approved',
            jsonb_build_object('balance_cents', v_before),
            jsonb_build_object('balance_cents', platform_tenant_balance(v_rep.tenant_id), 'amount_cents', v_cents,
                               'reported_cents', v_rep.amount_cents, 'payment_id', v_pay, 'role', v_role),
            v_reason);
    foreach v_r in array platform_notice_recipients(v_rep.tenant_id) loop
      perform enqueue_system_email(
        v_rep.tenant_id, v_r, 'platform_transfer_approved',
        jsonb_build_object('negocio', platform_html_escape(v_t.name), 'logo_url', '', 'monto', platform_format_ars(v_cents),
                           'link', 'https://pos.soft.ninja/dashboard-team#estado-de-cuenta'),
        'Acreditamos tu pago de ' || platform_format_ars(v_cents),
        _dunning_email_html(v_t.name, 'Pago acreditado', 'Verificamos tu transferencia de ' || platform_format_ars(v_cents) || '. ¡Gracias!'));
    end loop;
    return jsonb_build_object('status', 'approved', 'payment_id', v_pay, 'amount_cents', v_cents);
  end if;

  update platform_transfer_reports
     set status = 'rejected', verified_by = auth.uid(), verified_at = now(), reject_reason = v_reason
   where id = p_report;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_rep.tenant_id, auth.uid(), 'platform_transfer_report', p_report, 'platform_transfer_rejected',
          jsonb_build_object('amount_cents', v_rep.amount_cents, 'role', v_role), v_reason);
  foreach v_r in array platform_notice_recipients(v_rep.tenant_id) loop
    perform enqueue_system_email(
      v_rep.tenant_id, v_r, 'platform_transfer_rejected',
      jsonb_build_object('negocio', platform_html_escape(v_t.name), 'logo_url', '', 'monto', platform_format_ars(v_rep.amount_cents),
                         'motivo', platform_html_escape(v_reason), 'link', 'https://pos.soft.ninja/dashboard-team#estado-de-cuenta'),
      'No pudimos verificar tu transferencia',
      _dunning_email_html(v_t.name, 'Comprobante rechazado', 'No pudimos verificar tu transferencia: ' || v_reason));
  end loop;
  return jsonb_build_object('status', 'rejected');
end;
$$;

-- -----------------------------------------------------------------------------
-- H) Lecturas
-- -----------------------------------------------------------------------------
create or replace function platform_public_bank_accounts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'bank_slug', a.bank_slug, 'bank_name', a.bank_name, 'holder_name', a.holder_name,
           'cuit', a.cuit, 'cbu', a.cbu, 'alias', a.alias, 'account_type', a.account_type, 'note', a.note,
           'is_default', a.is_default)
           order by a.is_default desc, a.sort, a.created_at), '[]'::jsonb)
    from platform_bank_accounts a
   where a.deleted_at is null and a.is_active;
$$;

-- Lo que ve el negocio (dueño o encargado): modalidad, pase pendiente, cómo
-- pagar, a dónde mandar el comprobante, sus transferencias informadas y los
-- cambios de modalidad (sin motivos internos ni autores).
create or replace function my_billing_account()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid uuid := current_tenant_id();
  v_set platform_billing_settings%rowtype;
  v_bt  tenant_billing_terms%rowtype;
  v_t   tenants%rowtype;
begin
  if v_tid is null or not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_set from platform_billing_settings where id;
  select * into v_bt from tenant_billing_terms where tenant_id = v_tid;
  select * into v_t from tenants where id = v_tid;
  return jsonb_build_object(
    'billing_mode', platform_effective_billing_mode(v_tid),
    'pending_mode', v_bt.pending_mode,
    'pending_since', v_bt.pending_since,
    'due_days', coalesce(v_bt.due_days, v_set.due_days_default),
    'is_owner', is_tenant_owner(),
    'reference', 'NS-' || upper(regexp_replace(coalesce(v_t.slug, ''), '[^A-Za-z0-9-]', '', 'g')),
    'payment_proof_email', v_set.payment_proof_email,
    'payment_proof_whatsapp', v_set.payment_proof_whatsapp,
    'send_to', coalesce(to_jsonb(v_bt.send_to), '[]'::jsonb),
    'bank_accounts', platform_public_bank_accounts(),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'amount_cents', r.amount_cents, 'approved_cents', r.approved_cents, 'paid_on', r.paid_on,
               'reference', r.reference, 'status', r.status, 'reject_reason', r.reject_reason,
               'created_at', r.created_at, 'verified_at', r.verified_at, 'bank_account_id', r.bank_account_id)
               order by r.created_at desc)
        from (select * from platform_transfer_reports where tenant_id = v_tid order by created_at desc limit 30) r), '[]'::jsonb),
    'mode_changes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'from_mode', m.from_mode, 'to_mode', m.to_mode, 'status', m.status,
               'created_at', m.created_at, 'completed_at', m.completed_at)
               order by m.created_at desc)
        from (select * from platform_billing_mode_changes where tenant_id = v_tid order by created_at desc limit 20) m), '[]'::jsonb));
end;
$$;

-- Lo que ve el staff: configuración de cobro, cuentas, condiciones de aviso de
-- un negocio (si se pide) y transferencias a verificar.
create or replace function internal_billing_collection(p_tenant uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set  platform_billing_settings%rowtype;
  v_out  jsonb;
begin
  if platform_staff_billing_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_set from platform_billing_settings where id;
  v_out := jsonb_build_object(
    'settings', jsonb_build_object(
      'payment_proof_email', v_set.payment_proof_email,
      'payment_proof_whatsapp', v_set.payment_proof_whatsapp,
      'notices_enabled', v_set.notices_enabled,
      'notice_lead_days_default', v_set.notice_lead_days_default,
      'statement_frequency_default', v_set.statement_frequency_default,
      'statement_every_days_default', v_set.statement_every_days_default,
      'statement_day_default', v_set.statement_day_default,
      'due_days_default', v_set.due_days_default),
    'bank_accounts', coalesce((
      select jsonb_agg(to_jsonb(a) - 'created_by' - 'updated_by' order by a.is_default desc, a.sort, a.created_at)
        from platform_bank_accounts a where a.deleted_at is null), '[]'::jsonb),
    'pending_reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'tenant_id', r.tenant_id, 'tenant_name', t.name, 'amount_cents', r.amount_cents,
               'paid_on', r.paid_on, 'reference', r.reference, 'note', r.note, 'proof_path', r.proof_path,
               'proof_mime', r.proof_mime, 'created_at', r.created_at, 'bank_account_id', r.bank_account_id,
               'reported_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = r.reported_by),
               'balance_cents', platform_tenant_balance(r.tenant_id))
               order by r.created_at)
        from platform_transfer_reports r join tenants t on t.id = r.tenant_id
       where r.status = 'pending'), '[]'::jsonb));

  if p_tenant is not null then
    v_out := v_out || jsonb_build_object(
      'tenant', jsonb_build_object(
        'stored_mode', platform_stored_billing_mode(p_tenant),
        'effective_mode', platform_effective_billing_mode(p_tenant),
        'has_preapproval', exists (select 1 from subscriptions s where s.tenant_id = p_tenant
                                    and nullif(btrim(coalesce(s.mp_preapproval_id, '')), '') is not null),
        'terms', (select to_jsonb(bt) - 'id' from tenant_billing_terms bt where bt.tenant_id = p_tenant),
        'recipients', to_jsonb(platform_notice_recipients(p_tenant)),
        'mode_changes', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', m.id, 'from_mode', m.from_mode, 'to_mode', m.to_mode, 'status', m.status, 'source', m.source,
                   'mp_preapproval_id', m.mp_preapproval_id, 'mp_cancel_status', m.mp_cancel_status,
                   'mp_detail', m.mp_detail, 'reason', m.reason, 'created_at', m.created_at, 'completed_at', m.completed_at,
                   'created_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = m.created_by))
                   order by m.created_at desc)
            from (select * from platform_billing_mode_changes where tenant_id = p_tenant order by created_at desc limit 30) m), '[]'::jsonb),
        'reports', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', r.id, 'amount_cents', r.amount_cents, 'approved_cents', r.approved_cents, 'paid_on', r.paid_on,
                   'reference', r.reference, 'status', r.status, 'reject_reason', r.reject_reason, 'proof_path', r.proof_path,
                   'proof_mime', r.proof_mime, 'created_at', r.created_at)
                   order by r.created_at desc)
            from (select * from platform_transfer_reports where tenant_id = p_tenant order by created_at desc limit 30) r), '[]'::jsonb),
        'notices', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', n.id, 'kind', n.kind, 'amount_cents', n.amount_cents, 'due_date', n.due_date,
                   'recipients', to_jsonb(n.recipients), 'created_at', n.created_at)
                   order by n.created_at desc)
            from (select * from platform_billing_notices where tenant_id = p_tenant order by created_at desc limit 20) n), '[]'::jsonb)));
  end if;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- I) Plantillas de email (defaults de lib/email/templates.ts; un override del
--    staff no se pisa)
-- -----------------------------------------------------------------------------
insert into system_email_templates (key, subject, html) values
  ('platform_payment_notice',
   $tpl$Aviso de cobro: tu cuota vence el {{vence}}$tpl$,
   $tpl$<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head><body style="margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">La cuota de {{negocio}} por {{monto}} vence el {{vence}}.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f8" style="background:#f3f2f8"><tr><td align="center" style="padding:28px 12px 40px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center" bgcolor="#09051C" style="background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center"><a href="https://pos.soft.ninja" target="_blank" style="text-decoration:none"><img src="https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" /><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" /></a></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="#fff1ea" style="width:72px;height:72px;border-radius:50%;background:#fff1ea;font-size:32px;line-height:72px;text-align:center">🧾</td></tr></table><p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#ff5a1f">Aviso de cobro</p><h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C">Tu cuota vence el {{vence}}</h1><p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280">Este es el aviso de cobro de <b>{{negocio}}</b> por <b>{{periodo}}</b>. Podés pagarlo por transferencia a cualquiera de estas cuentas.</p></td></tr><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 40px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f6fb" style="background:#f7f6fb;border-radius:16px"><tr><td style="padding:14px 20px;font-size:14px;line-height:20px;color:#6b7280">Importe</td><td align="right" style="padding:14px 20px;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{monto}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Vence</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{vence}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Referencia</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{referencia}}</td></tr></table></td></tr><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:20px 40px 0">{{datos_bancarios}}{{comprobante}}</td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#ff5a1f" style="border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)"><a href="{{link}}" target="_blank" style="display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">Ver mi estado de cuenta</a></td></tr></table><p style="margin:16px auto 0;max-width:400px;font-size:13px;line-height:1.5;color:#9ca3af">Si ya transferiste, no hace falta que hagas nada más: lo acreditamos cuando verifiquemos el comprobante.</p></td></tr><tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" /><p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Un producto de</td><td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table><p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="https://pos.soft.ninja/login" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://soft.ninja" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://www.instagram.com/ninjasoft.latam/" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">Instagram</a></p><p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">Recibiste este email porque tu negocio paga NinjaPos por cuenta corriente.</p></td></tr></table></td></tr></table></td></tr></table></body></html>$tpl$),
  ('platform_transfer_reported',
   $tpl${{negocio}} informó una transferencia de {{monto}}$tpl$,
   $tpl$<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head><body style="margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Hay un comprobante para verificar en el panel interno.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f8" style="background:#f3f2f8"><tr><td align="center" style="padding:28px 12px 40px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center" bgcolor="#09051C" style="background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center"><a href="https://pos.soft.ninja" target="_blank" style="text-decoration:none"><img src="https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" /><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" /></a></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="#fff1ea" style="width:72px;height:72px;border-radius:50%;background:#fff1ea;font-size:32px;line-height:72px;text-align:center">📥</td></tr></table><p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#ff5a1f">Pago a verificar</p><h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C">{{negocio}} informó una transferencia</h1><p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280">Subió el comprobante desde su panel. Verificalo en Cobranzas para imputar el pago.</p></td></tr><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 40px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f6fb" style="background:#f7f6fb;border-radius:16px"><tr><td style="padding:14px 20px;font-size:14px;line-height:20px;color:#6b7280">Importe</td><td align="right" style="padding:14px 20px;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{monto}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Fecha de la transferencia</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{fecha}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Referencia</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{referencia}}</td></tr></table></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#ff5a1f" style="border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)"><a href="{{link}}" target="_blank" style="display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">Verificar el pago</a></td></tr></table></td></tr><tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" /><p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Un producto de</td><td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table><p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="https://pos.soft.ninja/login" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://soft.ninja" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://www.instagram.com/ninjasoft.latam/" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">Instagram</a></p><p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">Recibiste este email porque es la dirección que recibe los comprobantes de NinjaSoft.</p></td></tr></table></td></tr></table></td></tr></table></body></html>$tpl$),
  ('platform_transfer_approved',
   $tpl$Acreditamos tu pago de {{monto}}$tpl$,
   $tpl$<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head><body style="margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Tu transferencia ya está imputada en tu cuenta.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f8" style="background:#f3f2f8"><tr><td align="center" style="padding:28px 12px 40px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center" bgcolor="#09051C" style="background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center"><a href="https://pos.soft.ninja" target="_blank" style="text-decoration:none"><img src="https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" /><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" /></a></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="#e8f7ee" style="width:72px;height:72px;border-radius:50%;background:#e8f7ee;font-size:32px;line-height:72px;text-align:center">✅</td></tr></table><p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#15803d">Pago acreditado</p><h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C">Recibimos tu pago</h1><p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280">Verificamos tu transferencia de <b>{{monto}}</b> y la imputamos en la cuenta de <b>{{negocio}}</b>. ¡Gracias!</p></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#ff5a1f" style="border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)"><a href="{{link}}" target="_blank" style="display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">Ver mi estado de cuenta</a></td></tr></table></td></tr><tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" /><p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Un producto de</td><td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table><p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="https://pos.soft.ninja/login" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://soft.ninja" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://www.instagram.com/ninjasoft.latam/" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">Instagram</a></p><p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">Recibiste este email porque tenés una cuenta en NinjaPos.</p></td></tr></table></td></tr></table></td></tr></table></body></html>$tpl$),
  ('platform_transfer_rejected',
   $tpl$No pudimos verificar tu transferencia de {{monto}}$tpl$,
   $tpl$<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head><body style="margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Revisá el comprobante que subiste.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f8" style="background:#f3f2f8"><tr><td align="center" style="padding:28px 12px 40px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center" bgcolor="#09051C" style="background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center"><a href="https://pos.soft.ninja" target="_blank" style="text-decoration:none"><img src="https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" /><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" /></a></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="#fdecec" style="width:72px;height:72px;border-radius:50%;background:#fdecec;font-size:32px;line-height:72px;text-align:center">⚠️</td></tr></table><p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#dc2626">Comprobante rechazado</p><h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C">No pudimos verificar tu transferencia</h1><p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280">Revisamos el comprobante de <b>{{monto}}</b> que informó <b>{{negocio}}</b> y no lo pudimos acreditar.</p></td></tr><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 40px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f6fb" style="background:#f7f6fb;border-radius:16px"><tr><td style="padding:14px 20px;font-size:14px;line-height:20px;color:#6b7280">Motivo</td><td align="right" style="padding:14px 20px;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{motivo}}</td></tr></table></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#ff5a1f" style="border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)"><a href="{{link}}" target="_blank" style="display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">Volver a informar el pago</a></td></tr></table><p style="margin:16px auto 0;max-width:400px;font-size:13px;line-height:1.5;color:#9ca3af">Si creés que es un error, respondé este email o escribinos por WhatsApp.</p></td></tr><tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" /><p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Un producto de</td><td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table><p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="https://pos.soft.ninja/login" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://soft.ninja" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://www.instagram.com/ninjasoft.latam/" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">Instagram</a></p><p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">Recibiste este email porque tenés una cuenta en NinjaPos.</p></td></tr></table></td></tr></table></td></tr></table></body></html>$tpl$)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- J) pg_cron: avisos todos los días a las 09:00 de Argentina (12:00 UTC).
--    Sin pg_cron (stack local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite platform-payment-notices.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-payment-notices') then
    perform cron.unschedule('platform-payment-notices');
  end if;
  perform cron.schedule('platform-payment-notices', '5 12 * * *', $$select public.platform_send_payment_notices()$$);
end
$cron$;

-- -----------------------------------------------------------------------------
-- K) Grants
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  -- Internas: sólo security definer las llama.
  foreach f in array array[
    'platform_cbu_valid(text)',
    'platform_assert_super_admin()',
    'platform_assert_invite_admin()',
    'platform_stored_billing_mode(uuid)',
    'trg_platform_payments_mode_switch()',
    'platform_mp_preapproval_applies(uuid, text, text)',
    'platform_html_escape(text)',
    'platform_format_ars(bigint)',
    'platform_bank_block_html()',
    'platform_proof_contact_html()',
    'platform_notice_recipients(uuid)',
    'platform_send_notice(uuid, uuid, text, text, bigint, date, text, uuid)',
    'platform_notice_key(text, int, int, uuid, date, date)',
    'platform_send_payment_notices(timestamptz)',
    'platform_public_bank_accounts()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- RPC del staff y del negocio (cada una valida el rol adentro).
  foreach f in array array[
    'internal_tenant_limits(uuid)',
    'internal_set_limit_overrides(uuid, jsonb, text)',
    'internal_platform_bank_account_save(uuid, jsonb, text)',
    'internal_platform_bank_account_delete(uuid, text)',
    'internal_billing_set_collection_settings(jsonb, text)',
    'internal_billing_set_terms(uuid, text, text, int, text)',
    'internal_billing_set_notice_terms(uuid, text, int, int, int, text[], text[], text)',
    'internal_billing_change_mode(uuid, text, int, text, text)',
    'internal_billing_mode_change_mp_result(uuid, boolean, text)',
    'internal_invite_code_create(jsonb)',
    'internal_invite_code_set_active(uuid, boolean)',
    'internal_invite_code_delete(uuid)',
    'internal_billing_send_notice(uuid, text)',
    'owner_report_transfer(bigint, date, uuid, text, text, text, text, text)',
    'owner_cancel_transfer_report(uuid)',
    'internal_billing_verify_transfer(uuid, boolean, bigint, text)',
    'my_billing_account()',
    'internal_billing_collection(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- El webhook (service_role) consulta si aplica un aviso de preapproval.
  execute 'grant execute on function platform_mp_preapproval_applies(uuid, text, text) to service_role';
end
$grants$;
