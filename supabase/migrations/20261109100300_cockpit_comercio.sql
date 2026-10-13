-- =============================================================================
-- 20261109100300_cockpit_comercio  (F16 · H76, ADR-091)
--
-- commerce_cockpit(): una sola lectura para el cockpit de comercio unificado.
-- Responde el criterio de H76: qué canal vende, qué pedidos faltan surtir,
-- qué pagos fallaron y qué stock está comprometido; más facturas bloqueadas,
-- devoluciones a revisar, cajas sin señal y marcas de riesgo pendientes.
-- Las alertas con SLA se arman en el front (lib/commerce/cockpitAlerts.ts)
-- sobre estos números, como las del monitor de sucursales (ADR-080).
--
-- Canal de una venta (derivado, sin columna nueva en sales):
--   retiro     → la venta entregó una reserva (stock_reservations.sale_id)
--   salon      → cobró una mesa (table_orders.sale_id)
--   whatsapp / telefono / qr → pedido de delivery con ese canal
--   delivery / takeaway      → pedido de delivery o take away
--   link       → cobro en espera por QR o link (pending_charges.sale_id)
--   offline    → venta hecha sin conexión (sales.offline_client_id)
--   mostrador  → el resto
--
-- Alcance: dueño o encargado (is_tenant_manager), sucursales del usuario
-- (report_store_filter). Los pedidos de delivery no tienen sucursal: se
-- cuentan sólo en la vista consolidada (p_store_id null y alcance total).
-- Gating: feature `cockpit_comercio`. Solo lectura: no audita.
-- =============================================================================

create or replace function commerce_cockpit(
  p_store_id uuid default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null
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
  v_to     timestamptz := coalesce(p_to, now());
  v_from   timestamptz;
  v_all    boolean;
  v_risk   boolean;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'cockpit_comercio') then
    raise exception 'feature_not_in_plan: cockpit_comercio' using errcode = 'check_violation';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_stores := report_store_filter(p_store_id);
  v_all := v_stores is null;
  v_from := coalesce(p_from,
                     date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                       at time zone 'America/Argentina/Buenos_Aires');
  if v_to <= v_from then
    raise exception 'invalid_range';
  end if;
  if v_to - v_from > interval '92 days' then
    raise exception 'range_too_long';
  end if;
  v_risk := tenant_has_feature_for(v_tenant, 'prevencion_fraude');

  return jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'scope', case when v_all then 'all' else 'stores' end,

    -- Ventas por canal.
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object('channel', x.channel, 'sales', x.n, 'total', x.total)
                       order by x.total desc)
        from (
          select ch.channel, count(*) as n, coalesce(sum(s.total), 0) as total
            from sales s
            cross join lateral (
              select case
                when exists (select 1 from stock_reservations r where r.sale_id = s.id) then 'retiro'
                when exists (select 1 from table_orders t where t.sale_id = s.id) then 'salon'
                when d.id is not null and d.channel in ('whatsapp', 'telefono', 'qr') then d.channel
                when d.id is not null and d.order_type in ('delivery', 'takeaway') then d.order_type
                when exists (select 1 from pending_charges pc where pc.sale_id = s.id) then 'link'
                when s.offline_client_id is not null then 'offline'
                else 'mostrador'
              end as channel
                from (select 1) one
                left join lateral (
                  select o.id, o.channel, o.order_type from delivery_orders o where o.sale_id = s.id limit 1
                ) d on true
            ) ch
           where s.tenant_id = v_tenant
             and s.status = 'completed'
             and s.created_at >= v_from and s.created_at < v_to
             and (v_all or s.store_id = any (v_stores))
           group by ch.channel
        ) x
    ), '[]'::jsonb),

    -- Ventas por sucursal.
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'store_id', st.id, 'name', st.name, 'short_name', st.short_name, 'color', st.color,
               'sales', coalesce(a.n, 0), 'total', coalesce(a.total, 0))
             order by coalesce(a.total, 0) desc, st.name)
        from stores st
        left join (
          select s.store_id, count(*) as n, sum(s.total) as total
            from sales s
           where s.tenant_id = v_tenant and s.status = 'completed'
             and s.created_at >= v_from and s.created_at < v_to
           group by s.store_id
        ) a on a.store_id = st.id
       where st.tenant_id = v_tenant and st.deleted_at is null
         and (v_all or st.id = any (v_stores))
    ), '[]'::jsonb),

    -- Pedidos por surtir.
    'orders', jsonb_build_object(
      'delivery_open', case when v_all then (
        select count(*) from delivery_orders o
         where o.tenant_id = v_tenant and o.sale_id is null
           and o.status not in ('entregado', 'cancelado')) end,
      'delivery_late', case when v_all then (
        select count(*) from delivery_orders o
         where o.tenant_id = v_tenant and o.sale_id is null
           and o.status not in ('entregado', 'cancelado')
           and o.promised_at is not null and o.promised_at < now()) end,
      'delivery_oldest_at', case when v_all then (
        select min(o.created_at) from delivery_orders o
         where o.tenant_id = v_tenant and o.sale_id is null
           and o.status not in ('entregado', 'cancelado')) end,
      'reservations_open', (
        select count(*) from stock_reservations r
         where r.tenant_id = v_tenant and r.status = 'reservada' and r.expires_at > now()
           and (v_all or r.store_id = any (v_stores))),
      'reservations_ready', (
        select count(*) from stock_reservations r
         where r.tenant_id = v_tenant and r.status = 'preparada' and r.expires_at > now()
           and (v_all or r.store_id = any (v_stores))),
      'reservations_expiring', (
        select count(*) from stock_reservations r
         where r.tenant_id = v_tenant and r.status in ('reservada', 'preparada')
           and r.expires_at > now() and r.expires_at <= now() + interval '24 hours'
           and (v_all or r.store_id = any (v_stores))),
      'reservations_old_unprepared', (
        select count(*) from stock_reservations r
         where r.tenant_id = v_tenant and r.status = 'reservada' and r.expires_at > now()
           and r.created_at < now() - interval '4 hours'
           and (v_all or r.store_id = any (v_stores))),
      'transfers_pending', (
        select count(*) from stock_transfers t
         where t.tenant_id = v_tenant and t.deleted_at is null
           and t.status in ('pending_approval', 'scheduled')
           and (v_all or t.origin_store_id = any (v_stores) or t.dest_store_id = any (v_stores))),
      'transfers_late', (
        select count(*) from stock_transfers t
         where t.tenant_id = v_tenant and t.deleted_at is null
           and t.status in ('pending_approval', 'scheduled')
           and t.scheduled_for is not null
           and t.scheduled_for < (now() at time zone 'America/Argentina/Buenos_Aires')::date
           and (v_all or t.origin_store_id = any (v_stores) or t.dest_store_id = any (v_stores))),
      'transfers_in_transit', (
        select count(*) from stock_transfers t
         where t.tenant_id = v_tenant and t.deleted_at is null
           and t.status in ('in_transit', 'partially_received')
           and (v_all or t.origin_store_id = any (v_stores) or t.dest_store_id = any (v_stores)))
    ),

    -- Pagos.
    'payments', jsonb_build_object(
      'rejected', (
        select count(*) from terminal_transactions t
         where t.tenant_id = v_tenant and t.status in ('declined', 'error', 'timeout')
           and t.created_at >= v_from and t.created_at < v_to
           and (v_all or t.store_id = any (v_stores)))
        + (
        select count(*) from mp_payment_intents i
         where i.tenant_id = v_tenant and i.status = 'rejected'
           and i.created_at >= v_from and i.created_at < v_to
           and (v_all or i.secret_store_id = any (v_stores))),
      'paid_not_completed', (
        select count(*) from pending_charges pc
         where pc.tenant_id = v_tenant and pc.deleted_at is null
           and (pc.status = 'paid' or pc.needs_review)
           and (v_all or pc.store_id = any (v_stores))),
      'waiting', (
        select count(*) from pending_charges pc
         where pc.tenant_id = v_tenant and pc.deleted_at is null and pc.status = 'waiting'
           and (v_all or pc.store_id = any (v_stores))),
      'disputes_open', (
        select count(*) from payment_disputes d
         where d.tenant_id = v_tenant and d.status in ('open', 'in_review')
           and (v_all or d.scope_store_id is null or d.scope_store_id = any (v_stores)))
    ),

    -- Facturación.
    'fiscal', jsonb_build_object(
      'blocked', (
        select count(*) from fiscal_documents f
         where f.tenant_id = v_tenant
           and (f.status in ('rechazado', 'requiere_accion') or f.dead_letter_at is not null)
           and f.status <> 'cancelado'
           and (v_all or f.store_id is null or f.store_id = any (v_stores))),
      'pending_late', (
        select count(*) from fiscal_documents f
         where f.tenant_id = v_tenant and f.status in ('pendiente', 'enviando')
           and f.dead_letter_at is null
           and f.created_at < now() - interval '1 hour'
           and (v_all or f.store_id is null or f.store_id = any (v_stores)))
    ),

    -- Devoluciones.
    'returns', (
      select jsonb_build_object(
               'count', count(*),
               'total', coalesce(sum(r.total), 0),
               'review_items', coalesce(sum(ri.review_items), 0))
        from sale_returns r
        join sales s on s.id = r.sale_id
        left join lateral (
          select count(*) as review_items from sale_return_items i
           where i.return_id = r.id and i.restock = 'review'
        ) ri on true
       where r.tenant_id = v_tenant
         and r.created_at >= v_from and r.created_at < v_to
         and (v_all or s.store_id = any (v_stores))
    ),

    -- Stock comprometido y roto.
    'stock', jsonb_build_object(
      'reserved_units', (
        select coalesce(sum(i.qty), 0)
          from stock_reservation_items i
          join stock_reservations r on r.id = i.reservation_id
         where r.tenant_id = v_tenant and r.status in ('reservada', 'preparada') and r.expires_at > now()
           and (v_all or r.store_id = any (v_stores))),
      'in_transit_units', (
        select coalesce(sum(greatest(coalesce(i.qty_dispatched, 0) - i.qty_received, 0)), 0)
          from stock_transfer_items i
          join stock_transfers t on t.id = i.transfer_id
         where t.tenant_id = v_tenant and t.deleted_at is null
           and t.status in ('in_transit', 'partially_received')
           and (v_all or t.origin_store_id = any (v_stores) or t.dest_store_id = any (v_stores))),
      'negative', (
        select count(*) from product_stock ps
         where ps.tenant_id = v_tenant and ps.qty < 0
           and (v_all or ps.store_id = any (v_stores))),
      'out_with_sales', (
        select count(*) from product_stock ps
         where ps.tenant_id = v_tenant and ps.qty <= 0
           and (v_all or ps.store_id = any (v_stores))
           and exists (
             select 1 from sale_items si
             join sales s on s.id = si.sale_id
              where si.product_id = ps.product_id
                and si.variant_id is not distinct from ps.variant_id
                and s.store_id = ps.store_id and s.status = 'completed'
                and s.created_at >= now() - interval '7 days')),
      'below_min', (
        select count(*) from product_stock ps
         where ps.tenant_id = v_tenant and ps.min_qty is not null and ps.qty > 0 and ps.qty < ps.min_qty
           and (v_all or ps.store_id = any (v_stores)))
    ),

    -- Cajas.
    'registers', jsonb_build_object(
      'open', (
        select count(*) from cash_shifts cs
         where cs.tenant_id = v_tenant and cs.status = 'open'
           and (v_all or cs.store_id = any (v_stores))),
      'silent', (
        select count(*) from cash_shifts cs
          left join register_heartbeats h on h.cash_register_id = cs.cash_register_id
         where cs.tenant_id = v_tenant and cs.status = 'open'
           and (v_all or cs.store_id = any (v_stores))
           and (h.last_ping_at is null or h.last_ping_at < now() - interval '10 minutes'))
    ),

    -- Riesgo (sólo con prevención de fraude).
    'risk', case when v_risk then jsonb_build_object(
      'flags_pending', (
        select count(*) from risk_flags f
         where f.tenant_id = v_tenant and f.status = 'pendiente'
           and (v_all or f.store_id is null or f.store_id = any (v_stores)))
      ) end
  );
end;
$$;
revoke all on function commerce_cockpit(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function commerce_cockpit(uuid, timestamptz, timestamptz) to authenticated;
