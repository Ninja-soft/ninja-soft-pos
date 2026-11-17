-- =============================================================================
-- PAY-01 · Vencer intents de cobro pendientes viejos
-- =============================================================================
-- mp_payment_intents.status admite 'expired' desde 20260531160000 pero nada lo
-- seteaba: los QR / links que el cliente nunca pagó quedaban 'pending' para
-- siempre (46 en prod al 2026-11-16) y ensuciaban Ventas › Cobros QR.
--
-- payment_intents_expire_sweep() pasa a 'expired' los 'pending' de más de
-- 72 horas (cupones de efectivo: 4 días) de los proveedores cuyo webhook
-- acredita un pago tardío sobre un intent vencido (actualizan con
-- status <> 'approved': Mercado Pago QR / link y su Orders API, cupón de
-- efectivo, Mobbex, MODO, dLocal Go) o que ya ignoraban los intents viejos
-- (Payway > 48 h, Clover > 24 h). Talo, Ualá Bis, Viumi, Directo, GO Cuotas,
-- Getnet, Pagos360, Nave (según el evento) y Mercado Pago Point (sólo se
-- acredita en el poll, que corta si no está 'pending') quedan afuera: vencerlos
-- perdería el pago tardío. Se suman cuando sus Edges acepten 'expired'.
--
-- Tampoco se vencen los que tienen un cobro en espera vivo (pending_charges
-- waiting/paid), una fila de venta pausada sin usar (paused_sale_payments) o
-- un link de percepción de ML vigente (ml_perception_charges link_sent). No se
-- llama al proveedor. Los triggers de mp_payment_intents no hacen nada en este
-- caso porque esos intents quedan afuera. Las filas candidatas se bloquean con
-- FOR UPDATE SKIP LOCKED para no pisar un webhook o un "dejar en espera"
-- concurrente.
--
-- Cron `payment-intents-expire` cada hora (minuto 17). Cada corrida con
-- vencimientos deja un resumen por proveedor en audit_logs (sin payload).
-- =============================================================================

create or replace function public.payment_intents_expire_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_counts jsonb;
  v_total int;
begin
  with cand as (
    select i.id
      from mp_payment_intents i
     where i.status = 'pending'
       and i.provider_key in ('mercadopago', 'mp_cupon', 'mobbex', 'modo', 'dlocalgo', 'payway', 'clover')
       and i.created_at < now() - case
             when i.provider_key = 'mp_cupon' then interval '4 days'
             else interval '72 hours'
           end
       and not exists (
             select 1 from pending_charges pc
              where pc.intent_id = i.id
                and pc.deleted_at is null
                and pc.status in ('waiting', 'paid'))
       and not exists (
             select 1 from paused_sale_payments psp
              where psp.intent_id = i.id
                and psp.status <> 'used')
       and not exists (
             select 1 from ml_perception_charges mpc
              where mpc.intent_id = i.id
                and mpc.status = 'link_sent')
     for update of i skip locked
  ),
  expired as (
    update mp_payment_intents i
       set status = 'expired', updated_at = now()
      from cand
     where i.id = cand.id
       and i.status = 'pending'
    returning i.provider_key
  )
  select coalesce(jsonb_object_agg(provider_key, n), '{}'::jsonb), coalesce(sum(n), 0)::int
    into v_counts, v_total
    from (select provider_key, count(*) as n from expired group by provider_key) s;

  if v_total > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, null, 'payment_intents', null, 'payment_intents_expired',
            jsonb_build_object('total', v_total, 'by_provider', v_counts));
  end if;

  return jsonb_build_object('total', v_total, 'by_provider', v_counts);
end;
$$;

revoke all on function public.payment_intents_expire_sweep() from public, anon, authenticated;
grant execute on function public.payment_intents_expire_sweep() to service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'payment-intents-expire') then
      perform cron.unschedule('payment-intents-expire');
    end if;
    perform cron.schedule('payment-intents-expire', '17 * * * *', 'select public.payment_intents_expire_sweep();');
  else
    raise notice 'pg_cron no disponible; se omite el job payment-intents-expire.';
  end if;
end;
$cron$;
