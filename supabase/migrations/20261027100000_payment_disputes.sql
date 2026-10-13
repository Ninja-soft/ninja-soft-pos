-- =============================================================================
-- 20261027100000_payment_disputes  (ADR-064)
--
-- Contracargos, reclamos y devoluciones de Mercado Pago: se detectan en la
-- sincronización con la API (Edge `settlements`, a mano y por cron) y por los
-- avisos de MP (topic_chargebacks_wh / topic_claims_integration_wh en la Edge
-- `mp_webhook`), se guardan en payment_disputes y avisan al dueño y a los
-- encargados.
--
--  A) Feature `alertas_contracargos` (CLAUDE.md §6): BASE (is_basic = true,
--     grupo pagos). Quien tiene Mercado Pago conectado recibe los avisos y ve
--     las marcas en Ventas en cualquier plan: es plata del negocio en riesgo.
--     Las vistas de conciliación (estados, KPI, filtros, línea de tiempo) son
--     parte de `conciliacion_procesadores` (ADR-061), que ya está gateada.
--     Gating real: _payment_disputes_upsert exige
--     tenant_has_feature_for(tenant, 'alertas_contracargos').
--  B) Tipo de notificación 'disputas' (check NOT VALID, patrón de cobros).
--  C) payment_disputes: una fila por devolución, contracargo o reclamo, con
--     el pago del procesador, el cobro y la venta del POS, monto, estado,
--     motivo, plazo para presentar documentación, cobertura, foto cruda,
--     primera vez visto, resuelto, avisado y visto por el dueño.
--     RLS (ADR-052): `tenant_id = current_tenant_id() or internal_scope()` +
--     RESTRICTIVE de dueño o encargado (igual que settlement_lines). Sin
--     policies de escritura: RPC SECURITY DEFINER y service_role.
--  D) _payment_disputes_upsert (service_role): vincula con el cobro y la
--     venta, decide el origen de una devolución (pos si la venta está anulada
--     o tiene una devolución registrada; si no, provider), audita y notifica.
--  E) payment_dispute_ack: el dueño o encargado la marca como vista.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature BASE
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('alertas_contracargos', 'Alertas de contracargos y devoluciones',
   'Avisa al dueño y a los encargados cuando Mercado Pago informa un contracargo, un reclamo o una devolución que no se hizo desde el POS, y los marca en Ventas',
   'pagos', true, 23)
on conflict (key) do nothing;

-- Planes globales: incluida en todos (BASE). Los planes a medida la toman
-- por is_basic salvo que la apaguen explícitamente.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('alertas_contracargos', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'alertas_contracargos');

-- -----------------------------------------------------------------------------
-- B) Tipo de notificación
-- -----------------------------------------------------------------------------
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support','cobros','disputas'))
  not valid;

-- -----------------------------------------------------------------------------
-- C) Tabla
-- -----------------------------------------------------------------------------
create table if not exists payment_disputes (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  provider_key           text not null,
  kind                   text not null check (kind in ('refund', 'chargeback', 'claim')),
  dispute_key            text not null,
  provider_payment_id    text not null,
  provider_case_id       text,
  scope_store_id         uuid references stores(id) on delete set null,
  payment_id             uuid references payments(id) on delete set null,
  sale_id                uuid references sales(id) on delete set null,
  intent_id              uuid references mp_payment_intents(id) on delete set null,
  settlement_line_id     uuid references settlement_lines(id) on delete set null,
  amount                 numeric(14,2) not null default 0,
  currency               text,
  status                 text not null default 'open'
                           check (status in ('open', 'in_review', 'won', 'lost', 'refunded', 'closed')),
  provider_status        text,
  provider_status_detail text,
  reason                 text,
  refund_source          text,
  -- Devolución hecha desde el POS (venta anulada o con devolución) o desde
  -- Mercado Pago (sólo esas avisan).
  origin                 text not null default 'provider' check (origin in ('provider', 'pos')),
  documentation_status   text,
  documentation_deadline timestamptz,
  coverage_applied       boolean,
  coverage_eligible      boolean,
  occurred_at            timestamptz not null default now(),
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  resolved_at            timestamptz,
  notified_at            timestamptz,
  reminded_at            timestamptz,
  acknowledged_at        timestamptz,
  acknowledged_by        uuid references public.users(id) on delete set null,
  raw                    jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create unique index if not exists payment_disputes_key_uniq
  on payment_disputes (tenant_id, provider_key, dispute_key);
create index if not exists payment_disputes_tenant_idx
  on payment_disputes (tenant_id, first_seen_at desc);
create index if not exists payment_disputes_open_idx
  on payment_disputes (tenant_id) where resolved_at is null and deleted_at is null;
create index if not exists payment_disputes_sale_idx
  on payment_disputes (sale_id) where sale_id is not null;
create index if not exists payment_disputes_payment_idx
  on payment_disputes (payment_id) where payment_id is not null;
create index if not exists payment_disputes_provider_payment_idx
  on payment_disputes (tenant_id, provider_payment_id);
create index if not exists payment_disputes_intent_idx
  on payment_disputes (intent_id) where intent_id is not null;
create index if not exists payment_disputes_line_idx
  on payment_disputes (settlement_line_id) where settlement_line_id is not null;
create index if not exists payment_disputes_store_idx
  on payment_disputes (scope_store_id) where scope_store_id is not null;
create index if not exists payment_disputes_ack_by_idx
  on payment_disputes (acknowledged_by) where acknowledged_by is not null;

drop trigger if exists set_updated_at_payment_disputes on payment_disputes;
create trigger set_updated_at_payment_disputes
  before update on payment_disputes
  for each row execute function set_updated_at();

alter table payment_disputes enable row level security;
drop policy if exists pd_select on payment_disputes;
create policy pd_select on payment_disputes
  for select using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists pd_managers on payment_disputes;
create policy pd_managers on payment_disputes
  as restrictive for select using (is_tenant_manager() or internal_scope());

comment on table payment_disputes is
  'ADR-064: contracargos, reclamos y devoluciones informados por el procesador. Escritura sólo por RPC (service_role y payment_dispute_ack).';

-- -----------------------------------------------------------------------------
-- D) Upsert desde las Edges (service_role)
--    p_items: DisputeInput[] (supabase/functions/_shared/paymentDisputes.ts).
--    Devuelve { inserted, updated, notified, reminded }.
-- -----------------------------------------------------------------------------
-- Monto en pesos con formato argentino ($ 1.234,56) para los avisos.
create or replace function _ars(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$ ' || translate(to_char(round(coalesce(p, 0), 2), 'FM999,999,999,990.00'), ',.', '.,');
$$;
revoke all on function _ars(numeric) from public, anon, authenticated;

create or replace function _payment_disputes_notify(
  p_tenant uuid, p_severity text, p_title text, p_body text, p_url text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_n    int := 0;
begin
  foreach v_role in array array['owner', 'manager']
  loop
    insert into notifications (target_tenant_id, target_role, type, severity, title, body,
                               action_label, action_url, expires_at)
    values (p_tenant, v_role, 'disputas', p_severity, left(p_title, 200), left(p_body, 600),
            'Ver', p_url, now() + interval '30 days');
    v_n := v_n + 1;
  end loop;
  return v_n;
exception when others then
  -- Una notificación nunca rompe la sincronización.
  raise warning '_payment_disputes_notify: %', sqlerrm;
  return 0;
end;
$$;
revoke all on function _payment_disputes_notify(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function _payment_disputes_upsert(
  p_tenant uuid,
  p_items  jsonb,
  p_scope  uuid default null,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_it       jsonb;
  v_prev     payment_disputes%rowtype;
  v_key      text;
  v_kind     text;
  v_status   text;
  v_pid      text;
  v_ref      text;
  v_ref_id   uuid;
  v_line     uuid;
  v_pay      uuid;
  v_sale     uuid;
  v_intent   uuid;
  v_sale_no  bigint;
  v_voided   boolean;
  v_returned boolean;
  v_origin   text;
  v_amount   numeric;
  v_resolved boolean;
  v_deadline timestamptz;
  v_id       uuid;
  v_ins      int := 0;
  v_upd      int := 0;
  v_not      int := 0;
  v_rem      int := 0;
  v_url      text;
  v_label    text;
  v_title    text;
  v_body     text;
  v_sev      text;
  v_r        record;
begin
  if p_tenant is null or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_args';
  end if;
  if not tenant_has_feature_for(p_tenant, 'alertas_contracargos') then
    raise exception 'feature_not_in_plan: alertas_contracargos' using errcode = '42501';
  end if;
  if jsonb_array_length(p_items) > 2000 then
    raise exception 'too_many_items';
  end if;

  for v_it in select * from jsonb_array_elements(p_items)
  loop
    v_key  := left(btrim(coalesce(v_it ->> 'dispute_key', '')), 120);
    v_kind := coalesce(v_it ->> 'kind', '');
    v_pid  := left(btrim(coalesce(v_it ->> 'provider_payment_id', '')), 80);
    v_status := coalesce(v_it ->> 'status', '');
    if v_key = '' or v_pid = '' or v_kind not in ('refund', 'chargeback', 'claim')
       or v_status not in ('open', 'in_review', 'won', 'lost', 'refunded', 'closed') then
      continue;
    end if;
    v_amount := round(greatest(coalesce((v_it ->> 'amount')::numeric, 0), 0), 2);
    v_resolved := coalesce((v_it ->> 'resolved')::boolean, false);
    v_deadline := nullif(v_it ->> 'documentation_deadline', '')::timestamptz;
    v_ref := nullif(left(btrim(coalesce(v_it ->> 'external_reference', '')), 80), '');
    v_ref_id := case when v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_ref::uuid end;

    -- Vínculo con el POS (todo validado contra el negocio).
    v_line := null; v_pay := null; v_sale := null; v_intent := null;
    select l.id, l.payment_id, l.sale_id, l.intent_id
      into v_line, v_pay, v_sale, v_intent
      from settlement_lines l
     where l.tenant_id = p_tenant and l.provider_key = coalesce(v_it ->> 'provider_key', 'mercadopago')
       and l.external_id = v_pid
     limit 1;
    if v_intent is null then
      select i.id into v_intent from mp_payment_intents i
       where i.tenant_id = p_tenant
         and (i.mp_payment_id = v_pid
              or i.id = v_ref_id)
       order by i.created_at desc
       limit 1;
    end if;
    if v_pay is null and v_intent is not null then
      select p.id, p.sale_id into v_pay, v_sale from payments p
       where p.tenant_id = p_tenant and p.reference = v_intent::text
       limit 1;
    end if;
    if v_pay is null then
      select p.id, p.sale_id into v_pay, v_sale from payments p
       where p.tenant_id = p_tenant and p.reference = v_pid
       limit 1;
    end if;
    if v_pay is not null and v_sale is null then
      select p.sale_id into v_sale from payments p where p.id = v_pay and p.tenant_id = p_tenant;
    end if;

    -- Origen: una devolución con la venta anulada o devuelta en el POS no avisa.
    v_sale_no := null; v_voided := false; v_returned := false;
    if v_sale is not null then
      select s.number, s.status = 'voided' into v_sale_no, v_voided
        from sales s where s.id = v_sale and s.tenant_id = p_tenant;
      v_returned := exists (select 1 from sale_returns r where r.sale_id = v_sale and r.tenant_id = p_tenant);
    end if;
    v_origin := case when v_kind = 'refund' and (coalesce(v_voided, false) or v_returned) then 'pos' else 'provider' end;

    select * into v_prev from payment_disputes
     where tenant_id = p_tenant and provider_key = coalesce(v_it ->> 'provider_key', 'mercadopago')
       and dispute_key = v_key
     for update;

    if not found then
      insert into payment_disputes (
        tenant_id, provider_key, kind, dispute_key, provider_payment_id, provider_case_id, scope_store_id,
        payment_id, sale_id, intent_id, settlement_line_id, amount, currency, status, provider_status,
        provider_status_detail, reason, refund_source, origin, documentation_status, documentation_deadline,
        coverage_applied, coverage_eligible, occurred_at, resolved_at, raw
      ) values (
        p_tenant, coalesce(v_it ->> 'provider_key', 'mercadopago'), v_kind, v_key, v_pid,
        nullif(left(v_it ->> 'provider_case_id', 80), ''), p_scope,
        v_pay, v_sale, v_intent, v_line, v_amount, left(v_it ->> 'currency', 5), v_status,
        left(v_it ->> 'provider_status', 40), left(v_it ->> 'provider_status_detail', 60),
        left(v_it ->> 'reason', 200), left(v_it ->> 'refund_source', 40), v_origin,
        left(v_it ->> 'documentation_status', 40), v_deadline,
        (v_it ->> 'coverage_applied')::boolean, (v_it ->> 'coverage_eligible')::boolean,
        coalesce(nullif(v_it ->> 'occurred_at', '')::timestamptz, now()),
        case when v_resolved then now() end,
        v_it -> 'raw'
      )
      returning id into v_id;
      v_ins := v_ins + 1;

      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (p_tenant, p_actor, 'payment_disputes', v_id, 'payment_dispute_detected',
              jsonb_build_object('kind', v_kind, 'status', v_status, 'amount', v_amount,
                                 'provider_payment_id', v_pid, 'sale_id', v_sale, 'origin', v_origin));

      -- Aviso: contracargos y reclamos siempre (salvo que ya lleguen cerrados
      -- sin pérdida); devoluciones hechas desde Mercado Pago.
      v_sev := null;
      v_label := case when v_sale_no is not null then 'la venta #' || v_sale_no::text else 'un cobro sin venta en el POS' end;
      if v_kind = 'chargeback' and v_status <> 'won' and v_status <> 'closed'
         and (not v_resolved
              or coalesce(nullif(v_it ->> 'occurred_at', '')::timestamptz, now()) > now() - interval '15 days') then
        v_sev := 'critical';
        v_title := 'Contracargo de Mercado Pago';
        v_body := 'El comprador desconoció un pago de ' || _ars(v_amount) || ' en ' || v_label || '.'
                  || case when v_deadline is not null
                          then ' Tenés hasta el ' || to_char(v_deadline at time zone 'America/Argentina/Buenos_Aires', 'DD/MM')
                               || ' para presentar la documentación en Mercado Pago.'
                          else ' Revisá en Mercado Pago si tenés que presentar documentación.' end;
      elsif v_kind = 'claim' and v_status = 'open' then
        v_sev := 'warning';
        v_title := 'Reclamo abierto en Mercado Pago';
        v_body := 'El comprador abrió un reclamo por ' || _ars(v_amount) || ' en ' || v_label
                  || '. Mercado Pago retiene la plata hasta que se resuelva.';
      elsif v_kind = 'refund' and v_origin = 'provider' and v_status in ('refunded', 'open')
            -- Sin aluvión de avisos al traer un período viejo por primera vez.
            and coalesce(nullif(v_it ->> 'occurred_at', '')::timestamptz, now()) > now() - interval '15 days' then
        v_sev := 'warning';
        v_title := 'Devolución hecha desde Mercado Pago';
        v_body := 'Mercado Pago devolvió ' || _ars(v_amount) || ' de ' || v_label
                  || ' y la venta sigue vigente en el POS. Si corresponde, registrá la devolución o anulá la venta.';
      end if;
      if v_sev is not null then
        v_url := case when v_sale is not null then '/ventas?venta=' || v_sale::text || '&tab=cobros'
                      else '/reportes/conciliacion?vista=procesadores&filtro=disputas' end;
        if _payment_disputes_notify(p_tenant, v_sev, v_title, v_body, v_url) > 0 then
          update payment_disputes set notified_at = now() where id = v_id;
          v_not := v_not + 1;
        end if;
      end if;
    else
      update payment_disputes set
        provider_case_id       = coalesce(nullif(left(v_it ->> 'provider_case_id', 80), ''), provider_case_id),
        scope_store_id         = coalesce(scope_store_id, p_scope),
        payment_id             = coalesce(v_pay, payment_id),
        sale_id                = coalesce(v_sale, sale_id),
        intent_id              = coalesce(v_intent, intent_id),
        settlement_line_id     = coalesce(v_line, settlement_line_id),
        amount                 = case when v_amount > 0 then v_amount else amount end,
        currency               = coalesce(left(v_it ->> 'currency', 5), currency),
        status                 = v_status,
        provider_status        = coalesce(left(v_it ->> 'provider_status', 40), provider_status),
        provider_status_detail = coalesce(left(v_it ->> 'provider_status_detail', 60), provider_status_detail),
        reason                 = coalesce(left(v_it ->> 'reason', 200), reason),
        refund_source          = coalesce(left(v_it ->> 'refund_source', 40), refund_source),
        documentation_status   = coalesce(left(v_it ->> 'documentation_status', 40), documentation_status),
        documentation_deadline = coalesce(v_deadline, documentation_deadline),
        coverage_applied       = coalesce((v_it ->> 'coverage_applied')::boolean, coverage_applied),
        coverage_eligible      = coalesce((v_it ->> 'coverage_eligible')::boolean, coverage_eligible),
        resolved_at            = case when v_resolved then coalesce(resolved_at, now()) else null end,
        last_seen_at           = now(),
        raw                    = coalesce(v_it -> 'raw', raw)
       where id = v_prev.id;
      v_upd := v_upd + 1;

      if v_prev.status is distinct from v_status then
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
        values (p_tenant, p_actor, 'payment_disputes', v_prev.id, 'payment_dispute_updated',
                jsonb_build_object('status', v_prev.status),
                jsonb_build_object('status', v_status, 'kind', v_kind, 'provider_payment_id', v_pid));
        -- Resultado de un contracargo: avisa.
        if v_kind = 'chargeback' and v_status in ('won', 'lost') then
          v_url := case when coalesce(v_sale, v_prev.sale_id) is not null
                        then '/ventas?venta=' || coalesce(v_sale, v_prev.sale_id)::text || '&tab=cobros'
                        else '/reportes/conciliacion?vista=procesadores&filtro=disputas' end;
          v_not := v_not + least(1, _payment_disputes_notify(
            p_tenant,
            case when v_status = 'won' then 'success' else 'critical' end,
            case when v_status = 'won' then 'Contracargo resuelto a tu favor' else 'Contracargo resuelto en contra' end,
            case when v_status = 'won'
                 then 'Mercado Pago resolvió el contracargo de ' || _ars(coalesce(nullif(v_amount, 0), v_prev.amount)) || ' a tu favor: te devuelve la plata.'
                 else 'Mercado Pago resolvió el contracargo de ' || _ars(coalesce(nullif(v_amount, 0), v_prev.amount)) || ' en contra: la plata se descuenta de tu cuenta.' end,
            v_url));
        end if;
      end if;
    end if;
  end loop;

  -- Recordatorio: contracargos abiertos con el plazo de documentación en los
  -- próximos 2 días, una sola vez.
  for v_r in
    select d.id, d.amount, d.documentation_deadline, d.sale_id, s.number as sale_no
      from payment_disputes d
      left join sales s on s.id = d.sale_id
     where d.tenant_id = p_tenant and d.kind = 'chargeback' and d.resolved_at is null
       and d.deleted_at is null and d.reminded_at is null
       and coalesce(d.documentation_status, 'pending') = 'pending'
       -- Recién avisado (el aviso ya dice el plazo): no repetir en la misma corrida.
       and (d.notified_at is null or d.notified_at < now() - interval '12 hours')
       and d.documentation_deadline between now() and now() + interval '2 days'
  loop
    perform _payment_disputes_notify(
      p_tenant, 'critical', 'Vence el plazo de un contracargo',
      'Tenés hasta el ' || to_char(v_r.documentation_deadline at time zone 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
        || ' para presentar la documentación del contracargo de ' || _ars(v_r.amount)
        || case when v_r.sale_no is not null then ' (venta #' || v_r.sale_no::text || ')' else '' end || ' en Mercado Pago.',
      case when v_r.sale_id is not null then '/ventas?venta=' || v_r.sale_id::text || '&tab=cobros'
           else '/reportes/conciliacion?vista=procesadores&filtro=disputas' end);
    update payment_disputes set reminded_at = now() where id = v_r.id;
    v_rem := v_rem + 1;
  end loop;

  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'notified', v_not, 'reminded', v_rem);
end;
$$;
revoke all on function _payment_disputes_upsert(uuid, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function _payment_disputes_upsert(uuid, jsonb, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- E) Marcar como vista (dueño o encargado del negocio actual)
-- -----------------------------------------------------------------------------
create or replace function payment_dispute_ack(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
begin
  if v_uid is null or v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update payment_disputes
     set acknowledged_at = now(), acknowledged_by = v_uid
   where id = p_id and tenant_id = v_tenant and acknowledged_at is null;
  if not found then
    return;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, v_uid, 'payment_disputes', p_id, 'payment_dispute_acknowledged', '{}'::jsonb);
end;
$$;
revoke all on function payment_dispute_ack(uuid) from public, anon;
grant execute on function payment_dispute_ack(uuid) to authenticated;
