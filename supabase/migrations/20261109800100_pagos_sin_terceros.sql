-- =============================================================================
-- 20261109800100_pagos_sin_terceros  (F8 · ADR-099)
--
-- Pendientes de F8 que no necesitan credenciales, kits ni cobros de terceros:
--
--  A) Transferencias automáticas (ADR-061, adenda): la venta queda vinculada a
--     su espera sola. Un trigger sobre payments (sólo method = 'transfer' con
--     n° de operación) cierra la espera emparejada con ese movimiento de
--     Mercado Pago y le pone la venta. La hoja de cobro no necesita saber el id
--     de la venta y el cierre no depende de que el navegador siga abierto.
--  B) Barrido de esperas vencidas (pg_cron cada 10 minutos): las que esperan o
--     quedaron ambiguas pasan a 'expired'; las emparejadas que nadie usó 24 h
--     después del vencimiento se vinculan a la venta si existe y, si no, se
--     vencen y liberan el movimiento. Todo auditado.
--  C) Comisiones estimadas por medio de pago (feature comisiones_estimadas):
--     payment_fee_rules (medio, procesador opcional, cuotas opcionales, % +
--     fijo por cobro + IVA sobre la comisión) y la RPC payment_fees_report con
--     bruto, comisión estimada, neto estimado y propinas por medio.
--
-- Aditiva. No recrea create_sale ni ninguna función existente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) La venta cierra su espera de transferencia
-- -----------------------------------------------------------------------------
create or replace function _payments_link_transfer_watch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update transfer_watches w
     set status = 'closed', sale_id = new.sale_id
   where w.tenant_id = new.tenant_id
     and w.mp_payment_id = btrim(new.reference)
     and w.status = 'matched'
  returning w.id into v_id;

  if v_id is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'transfer_watch', v_id, 'transfer_watch_closed',
            jsonb_build_object('sale_id', new.sale_id, 'payment_id', new.id,
                               'mp_payment_id', btrim(new.reference), 'amount', new.amount,
                               'origin', 'payment'));
  end if;
  return null;
end;
$$;
revoke all on function _payments_link_transfer_watch() from public, anon, authenticated;

drop trigger if exists payments_link_transfer_watch on payments;
create trigger payments_link_transfer_watch
  after insert on payments
  for each row
  when (new.method = 'transfer' and new.reference is not null)
  execute function _payments_link_transfer_watch();

-- -----------------------------------------------------------------------------
-- B) Barrido de esperas vencidas
-- -----------------------------------------------------------------------------
create or replace function transfer_watches_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired int := 0;
  v_linked  int := 0;
  v_freed   int := 0;
begin
  -- 1) Esperando o ambiguas, pasado el vencimiento.
  with x as (
    update transfer_watches w
       set status = 'expired', candidates = '[]'::jsonb
     where w.status in ('waiting', 'ambiguous')
       and w.expires_at < now()
    returning w.id, w.tenant_id, w.amount
  ), a as (
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    select x.tenant_id, null, 'transfer_watch', x.id, 'transfer_watch_expired',
           jsonb_build_object('amount', x.amount, 'origin', 'sweep')
      from x
    returning 1
  )
  select count(*) into v_expired from a;

  -- 2) Emparejadas sin cerrar 24 h después del vencimiento: si una venta usó
  --    el movimiento, se vincula; si no, se vence y el movimiento se libera.
  with m as (
    select w.id, w.tenant_id, w.mp_payment_id,
           (select p.sale_id
              from payments p
             where p.tenant_id = w.tenant_id
               and p.method = 'transfer'
               and btrim(p.reference) = w.mp_payment_id
             order by p.created_at
             limit 1) as sale_id
      from transfer_watches w
     where w.status = 'matched'
       and w.expires_at < now() - interval '24 hours'
     for update of w skip locked
  ), l as (
    update transfer_watches w
       set status = 'closed', sale_id = m.sale_id
      from m
     where w.id = m.id and m.sale_id is not null
    returning w.id, w.tenant_id, m.sale_id, m.mp_payment_id
  ), la as (
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    select l.tenant_id, null, 'transfer_watch', l.id, 'transfer_watch_closed',
           jsonb_build_object('sale_id', l.sale_id, 'mp_payment_id', l.mp_payment_id, 'origin', 'sweep')
      from l
    returning 1
  ), f as (
    update transfer_watches w
       set status = 'expired', mp_payment_id = null,
           candidates = jsonb_build_array(jsonb_build_object('released_mp_payment_id', m.mp_payment_id))
      from m
     where w.id = m.id and m.sale_id is null
    returning w.id, w.tenant_id, m.mp_payment_id
  ), fa as (
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    select f.tenant_id, null, 'transfer_watch', f.id, 'transfer_watch_expired',
           jsonb_build_object('released_mp_payment_id', f.mp_payment_id, 'origin', 'sweep')
      from f
    returning 1
  )
  select (select count(*) from la), (select count(*) from fa) into v_linked, v_freed;

  return jsonb_build_object('expired', v_expired, 'linked', v_linked, 'released', v_freed);
end;
$$;
revoke all on function transfer_watches_sweep() from public, anon, authenticated;
grant execute on function transfer_watches_sweep() to service_role;

create index if not exists transfer_watches_open_expires_idx
  on transfer_watches (expires_at) where status in ('waiting', 'ambiguous', 'matched');

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el barrido de esperas de transferencia.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'transfer-watches-sweep') then
    perform cron.unschedule('transfer-watches-sweep');
  end if;
  perform cron.schedule('transfer-watches-sweep', '*/10 * * * *', $$select public.transfer_watches_sweep()$$);
end;
$cron$;

-- -----------------------------------------------------------------------------
-- C) Comisiones estimadas por medio de pago
-- -----------------------------------------------------------------------------
create table if not exists payment_fee_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  method        text not null
                  check (method in ('debit', 'credit', 'qr', 'transfer', 'other', 'directo')),
  provider_key  text references payment_providers(key) on delete set null,
  installments  int check (installments is null or installments between 1 and 99),
  fee_pct       numeric(6,3) not null default 0 check (fee_pct >= 0 and fee_pct <= 100),
  fixed_fee     numeric(12,2) not null default 0 check (fixed_fee >= 0 and fixed_fee <= 1000000),
  vat_on_fee    boolean not null default true,
  note          text check (note is null or char_length(note) <= 120),
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
-- Una regla viva por combinación (medio, procesador, cuotas).
create unique index if not exists payment_fee_rules_uniq
  on payment_fee_rules (tenant_id, method, coalesce(provider_key, ''), coalesce(installments, 0))
  where deleted_at is null;
create index if not exists payment_fee_rules_provider_idx
  on payment_fee_rules (provider_key) where provider_key is not null;
create index if not exists payment_fee_rules_created_by_idx
  on payment_fee_rules (created_by) where created_by is not null;

drop trigger if exists set_updated_at_payment_fee_rules on payment_fee_rules;
create trigger set_updated_at_payment_fee_rules
  before update on payment_fee_rules
  for each row execute function set_updated_at();

alter table payment_fee_rules enable row level security;
drop policy if exists payment_fee_rules_select on payment_fee_rules;
create policy payment_fee_rules_select on payment_fee_rules
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists payment_fee_rules_insert on payment_fee_rules;
create policy payment_fee_rules_insert on payment_fee_rules
  for insert with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists payment_fee_rules_update on payment_fee_rules;
create policy payment_fee_rules_update on payment_fee_rules
  for update using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
-- Sin DELETE: baja lógica con deleted_at.

drop trigger if exists role_write_guard on payment_fee_rules;
create trigger role_write_guard before insert or update or delete on payment_fee_rules
  for each row execute function trg_role_write_guard('manage');

-- Gating real del plan y auditoría de cada cambio.
create or replace function _payment_fee_rules_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not tenant_has_feature_for(new.tenant_id, 'comisiones_estimadas') then
    raise exception 'feature_not_in_plan: comisiones_estimadas' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  elsif new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_immutable' using errcode = '42501';
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  return new;
end;
$$;
revoke all on function _payment_fee_rules_guard() from public, anon, authenticated;

drop trigger if exists payment_fee_rules_guard on payment_fee_rules;
create trigger payment_fee_rules_guard
  before insert or update on payment_fee_rules
  for each row execute function _payment_fee_rules_guard();

create or replace function _payment_fee_rules_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'payment_fee_rule', new.id,
          case
            when tg_op = 'INSERT' then 'payment_fee_rule_created'
            when new.deleted_at is not null and old.deleted_at is null then 'payment_fee_rule_deleted'
            else 'payment_fee_rule_updated'
          end,
          case when tg_op = 'UPDATE' then
            jsonb_build_object('method', old.method, 'provider_key', old.provider_key,
                               'installments', old.installments, 'fee_pct', old.fee_pct,
                               'fixed_fee', old.fixed_fee, 'vat_on_fee', old.vat_on_fee)
          end,
          jsonb_build_object('method', new.method, 'provider_key', new.provider_key,
                             'installments', new.installments, 'fee_pct', new.fee_pct,
                             'fixed_fee', new.fixed_fee, 'vat_on_fee', new.vat_on_fee,
                             'deleted', new.deleted_at is not null));
  return null;
end;
$$;
revoke all on function _payment_fee_rules_audit() from public, anon, authenticated;

drop trigger if exists payment_fee_rules_audit on payment_fee_rules;
create trigger payment_fee_rules_audit
  after insert or update on payment_fee_rules
  for each row execute function _payment_fee_rules_audit();

comment on table payment_fee_rules is
  'ADR-099: comisión estimada que cobra cada procesador por medio, procesador (opcional) y cuotas (opcional). La usa payment_fees_report.';

-- Reporte: bruto, comisión estimada y neto por medio, procesador y cuotas, y
-- propinas por medio. Dueño o encargado, con el plan. Misma regla de sucursal
-- que sales_report (report_store_filter).
--
-- La regla que aplica a cada grupo es la más específica: procesador y cuotas
-- iguales > sólo procesador > sólo cuotas > la general del medio.
-- comisión = bruto × % / 100 + fijo × cobros; IVA 21 % sobre la comisión si
-- vat_on_fee. Espejo puro en lib/payments/feeEstimate.ts.
create or replace function payment_fees_report(
  p_from     timestamptz,
  p_to       timestamptz,
  p_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_stores uuid[];
  v_rows   jsonb;
  v_tips   jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(member_role_in(v_tenant), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'comisiones_estimadas') then
    raise exception 'feature_not_in_plan: comisiones_estimadas' using errcode = '42501';
  end if;
  v_stores := report_store_filter(p_store_id);

  with s as (
    select sa.id
      from sales sa
     where sa.tenant_id = v_tenant
       and sa.status = 'completed'
       and sa.created_at >= p_from
       and sa.created_at < p_to
       and (v_stores is null or sa.store_id = any (v_stores))
  ), pay as (
    select p.method,
           case when p.reference ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
             (select i.provider_key from mp_payment_intents i
               where i.id = p.reference::uuid and i.tenant_id = v_tenant)
           end as provider_key,
           case when p.method in ('debit', 'credit')
                 and coalesce(p.card_voucher ->> 'cuotas', p.card_voucher ->> 'installments', '') ~ '^[0-9]{1,2}$'
                then greatest(1, coalesce(p.card_voucher ->> 'cuotas', p.card_voucher ->> 'installments')::int)
           end as installments,
           p.amount
      from payments p
      join s on s.id = p.sale_id
     where p.tenant_id = v_tenant
  ), g as (
    select method, provider_key, installments, count(*)::int as n, sum(amount) as gross
      from pay
     group by method, provider_key, installments
  ), r as (
    select g.*, rule.id as rule_id, coalesce(rule.fee_pct, 0) as fee_pct,
           coalesce(rule.fixed_fee, 0) as fixed_fee, coalesce(rule.vat_on_fee, false) as vat_on_fee
      from g
      left join lateral (
        select fr.id, fr.fee_pct, fr.fixed_fee, fr.vat_on_fee
          from payment_fee_rules fr
         where fr.tenant_id = v_tenant
           and fr.deleted_at is null
           and fr.method = g.method
           and (fr.provider_key is null or fr.provider_key = g.provider_key)
           and (fr.installments is null or fr.installments = g.installments)
         order by (case when fr.provider_key is not null then 2 else 0 end
                   + case when fr.installments is not null then 1 else 0 end) desc,
                  fr.created_at
         limit 1
      ) rule on true
  ), c as (
    select r.*,
           round(r.gross * r.fee_pct / 100 + r.fixed_fee * r.n, 2) as fee
      from r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'method', c.method,
           'provider_key', c.provider_key,
           'installments', c.installments,
           'count', c.n,
           'gross', c.gross,
           'rule_id', c.rule_id,
           'fee_pct', c.fee_pct,
           'fixed_fee', c.fixed_fee,
           'vat_on_fee', c.vat_on_fee,
           'fee', c.fee,
           'vat', case when c.vat_on_fee then round(c.fee * 0.21, 2) else 0 end,
           'net', c.gross - c.fee - case when c.vat_on_fee then round(c.fee * 0.21, 2) else 0 end
         ) order by c.gross desc), '[]'::jsonb)
    into v_rows
    from c;

  select coalesce(jsonb_agg(jsonb_build_object('method', t.method, 'count', t.n, 'amount', t.amount)
                            order by t.amount desc), '[]'::jsonb)
    into v_tips
    from (
      select coalesce(sa.tip_method, 'other') as method, count(*)::int as n, sum(sa.tip_amount) as amount
        from sales sa
       where sa.tenant_id = v_tenant
         and sa.status = 'completed'
         and sa.created_at >= p_from
         and sa.created_at < p_to
         and (v_stores is null or sa.store_id = any (v_stores))
         and coalesce(sa.tip_amount, 0) > 0
       group by 1
    ) t;

  return jsonb_build_object('rows', v_rows, 'tips', v_tips);
end;
$$;
revoke all on function payment_fees_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function payment_fees_report(timestamptz, timestamptz, uuid) to authenticated;
