-- =============================================================================
-- 20261227100200_caja_controles_cierre  (F23 · H156, ADR-158) · BASE
--
--   1) Cierre con contado 0 y esperado positivo (T11): no se puede cerrar así
--      sin confirmarlo con un motivo. cash_shift_confirm_zero_close() guarda la
--      confirmación en el turno (vale 30 minutos) y un trigger BEFORE UPDATE en
--      cash_shifts rechaza el cierre sin ella ('close_zero_needs_confirmation').
--      close_cash_shift NO cambia (ADR-150: validación previa + RPC de
--      confirmación). El cierre forzado (cash_force_close, con supervisor y
--      motivo) no la pide.
--   2) Conciliación del Z con motivo: cash_z_closures.review_* y
--      cash_z_review(): el dueño o un encargado revisa la diferencia de un Z
--      (error de conteo, faltante o sobrante real, retiro sin registrar, otro)
--      con el motivo. Queda en audit_logs; revisar de nuevo guarda el anterior.
--
-- Seguridad: las columnas nuevas sólo se escriben por las RPC (SECURITY
-- DEFINER); el cliente no puede tocarlas por REST. Sin feature nueva (BASE:
-- es parte de la caja).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Cierre con contado 0.
-- -----------------------------------------------------------------------------
alter table cash_shifts add column if not exists zero_close_confirmed_at timestamptz;
alter table cash_shifts add column if not exists zero_close_confirmed_by uuid references users(id);
alter table cash_shifts add column if not exists zero_close_reason text;
alter table cash_shifts drop constraint if exists cash_shifts_zero_close_reason_check;
alter table cash_shifts add constraint cash_shifts_zero_close_reason_check
  check (zero_close_reason is null or char_length(zero_close_reason) <= 300);
create index if not exists cash_shifts_zero_close_by_idx
  on cash_shifts(zero_close_confirmed_by) where zero_close_confirmed_by is not null;

comment on column cash_shifts.zero_close_confirmed_at is
  'ADR-158 (H156): confirmación de cerrar con $0 contados y esperado positivo (vale 30 minutos). Sólo por cash_shift_confirm_zero_close.';

create or replace function cash_shift_confirm_zero_close(p_shift_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_shift  cash_shifts%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  select * into v_shift from cash_shifts where id = p_shift_id and tenant_id = v_tenant for update;
  if v_shift.id is null then
    raise exception 'shift_not_found';
  end if;
  if v_shift.status <> 'open' then
    raise exception 'shift_not_open';
  end if;
  if v_shift.opened_by is distinct from auth.uid() and not is_tenant_manager() then
    raise exception 'shift_not_owned' using errcode = '42501';
  end if;
  update cash_shifts
     set zero_close_confirmed_at = now(), zero_close_confirmed_by = auth.uid(), zero_close_reason = left(v_reason, 300)
   where id = v_shift.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data, store_id)
  values (v_tenant, auth.uid(), 'cash_shifts', v_shift.id, 'cash_shift_zero_close_confirmed', left(v_reason, 300),
          jsonb_build_object('cash_register_id', v_shift.cash_register_id), v_shift.store_id);
end;
$$;
revoke all on function cash_shift_confirm_zero_close(uuid, text) from public, anon;
grant execute on function cash_shift_confirm_zero_close(uuid, text) to authenticated;

create or replace function trg_cash_shifts_zero_close()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- La confirmación sólo la escribe la RPC.
  if current_user in ('authenticated', 'anon')
     and (new.zero_close_confirmed_at is distinct from old.zero_close_confirmed_at
          or new.zero_close_confirmed_by is distinct from old.zero_close_confirmed_by
          or new.zero_close_reason is distinct from old.zero_close_reason) then
    raise exception 'shift_immutable' using errcode = '42501';
  end if;
  if old.status = 'open' and new.status = 'closed'
     and coalesce(new.closing_amount, 0) = 0
     and coalesce(new.expected_amount, 0) > 0
     and coalesce(current_setting('ninja.force_close_shift', true), '') <> old.id::text
     and (new.zero_close_confirmed_at is null or new.zero_close_confirmed_at < now() - interval '30 minutes') then
    raise exception 'close_zero_needs_confirmation' using errcode = 'check_violation',
      detail = 'expected:' || new.expected_amount::text;
  end if;
  return new;
end;
$$;

drop trigger if exists cash_shifts_zero_close on cash_shifts;
create trigger cash_shifts_zero_close
  before update on cash_shifts
  for each row execute function trg_cash_shifts_zero_close();

-- -----------------------------------------------------------------------------
-- 2) Conciliación del Z con motivo.
-- -----------------------------------------------------------------------------
alter table cash_z_closures add column if not exists review_kind text;
alter table cash_z_closures add column if not exists review_reason text;
alter table cash_z_closures add column if not exists reviewed_at timestamptz;
alter table cash_z_closures add column if not exists reviewed_by uuid references users(id);
alter table cash_z_closures drop constraint if exists cash_z_closures_review_check;
alter table cash_z_closures add constraint cash_z_closures_review_check
  check ((review_kind is null or review_kind in ('conteo', 'faltante_real', 'sobrante_real', 'retiro_sin_registrar', 'otro'))
         and (review_reason is null or char_length(review_reason) between 3 and 300)
         and ((review_kind is null) = (reviewed_at is null)));
create index if not exists cash_z_closures_reviewed_by_idx
  on cash_z_closures(reviewed_by) where reviewed_by is not null;

comment on column cash_z_closures.review_kind is
  'ADR-158 (H156): revisión de la diferencia del Z por el dueño o un encargado (conteo, faltante_real, sobrante_real, retiro_sin_registrar, otro). Sólo por cash_z_review.';

create or replace function trg_cash_z_closures_review_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.review_kind is distinct from old.review_kind
          or new.review_reason is distinct from old.review_reason
          or new.reviewed_at is distinct from old.reviewed_at
          or new.reviewed_by is distinct from old.reviewed_by) then
    raise exception 'z_review_via_rpc' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists cash_z_closures_review_guard on cash_z_closures;
create trigger cash_z_closures_review_guard
  before update on cash_z_closures
  for each row execute function trg_cash_z_closures_review_guard();

create or replace function cash_z_review(p_id uuid, p_kind text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  z        cash_z_closures%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('conteo', 'faltante_real', 'sobrante_real', 'retiro_sin_registrar', 'otro') then
    raise exception 'invalid_review_kind';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  select * into z from cash_z_closures where id = p_id and tenant_id = v_tenant for update;
  if z.id is null then
    raise exception 'z_not_found';
  end if;
  if z.store_id is not null and not user_can_access_store(z.store_id) then
    raise exception 'store_not_allowed' using errcode = '42501';
  end if;
  update cash_z_closures
     set review_kind = p_kind, review_reason = left(v_reason, 300), reviewed_at = now(), reviewed_by = auth.uid()
   where id = z.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'cash_z_closures', z.id, 'cash_z_reviewed', left(v_reason, 300),
          case when z.reviewed_at is not null then
            jsonb_build_object('review_kind', z.review_kind, 'review_reason', z.review_reason,
                               'reviewed_at', z.reviewed_at, 'reviewed_by', z.reviewed_by) end,
          jsonb_build_object('review_kind', p_kind, 'z_number', z.z_number, 'difference', z.difference),
          z.store_id);
end;
$$;
revoke all on function cash_z_review(uuid, text, text) from public, anon;
grant execute on function cash_z_review(uuid, text, text) to authenticated;
