-- =============================================================================
-- PAY-28 · Transición de mp_payment_intents + auditoría en una transacción
-- (ADR-191)
-- =============================================================================
-- applyOrderToIntent (_shared/mpIntents.ts: mp_orders_webhook, mp_qr, mp_point,
-- mp_cupon, pending_charges_sync) actualizaba el intent y DESPUÉS insertaba
-- audit_logs en otra llamada: si la segunda fallaba, el webhook respondía 200
-- con el intent acreditado y sin auditoría (y el reintento ya no la escribía,
-- porque sale por "ya acreditado").
--
-- _mp_intent_transition hace las dos cosas en una transacción:
--   * update del intent con la MISMA condición de antes:
--       p_only_pending = false → status <> 'approved' (acreditar)
--       p_only_pending = true  → status = 'pending'   (rechazo / vencimiento)
--     mp_payment_id = coalesce(p_mp_payment_id, mp_payment_id).
--   * si cambió una fila y viene p_audit_action, insert en audit_logs con el
--     payload que arma la Edge (el mismo de siempre). Si el insert falla, la
--     función falla y el update se revierte: la Edge estricta responde 503 y
--     MP reintenta las dos cosas.
-- Devuelve true si cambió el intent.
--
-- Sólo service_role (las Edges). SECURITY DEFINER con search_path fijo; sin
-- EXECUTE para public / anon / authenticated (SEC-15). Aditiva: no cambia
-- tablas ni otras funciones. Las Edges caen al camino de dos pasos si la
-- función todavía no existe (PGRST202), así el orden de despliegue no rompe.
-- =============================================================================

create or replace function public._mp_intent_transition(
  p_intent         uuid,
  p_status         text,
  p_mp_payment_id  text,
  p_only_pending   boolean,
  p_audit_action   text default null,
  p_actor          uuid default null,
  p_audit_after    jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  if p_intent is null or p_only_pending is null then
    raise exception 'mp_intent_transition_invalid_args' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('approved', 'rejected', 'cancelled', 'expired') then
    raise exception 'mp_intent_transition_invalid_status' using errcode = '22023';
  end if;
  if p_audit_action is not null
     and p_audit_action not in ('mp_order_approved', 'mp_order_amount_mismatch') then
    raise exception 'mp_intent_transition_invalid_action' using errcode = '22023';
  end if;

  update mp_payment_intents i
     set status = p_status,
         mp_payment_id = coalesce(p_mp_payment_id, i.mp_payment_id)
   where i.id = p_intent
     and (case when p_only_pending then i.status = 'pending' else i.status <> 'approved' end)
  returning i.tenant_id into v_tenant;

  if not found then
    return false;
  end if;

  if p_audit_action is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, p_actor, 'mp_payment_intents', p_intent, p_audit_action, p_audit_after);
  end if;

  return true;
end;
$$;

comment on function public._mp_intent_transition(uuid, text, text, boolean, text, uuid, jsonb) is
  'PAY-28 (ADR-191): transición de mp_payment_intents + audit_logs en una transacción. Sólo service_role (Edges de Mercado Pago).';

revoke all on function public._mp_intent_transition(uuid, text, text, boolean, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public._mp_intent_transition(uuid, text, text, boolean, text, uuid, jsonb)
  to service_role;
