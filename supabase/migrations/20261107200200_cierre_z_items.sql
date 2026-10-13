-- =============================================================================
-- 20261107200200_cierre_z_items  (F11 · H30b, ADR-085)
--
-- Último pendiente del snapshot del Cierre Z: los ítems vendidos resumidos.
--
--   * cash_z_closures.items_summary (jsonb): una fila por producto o variante
--     (o ítem libre, por nombre) vendido en las ventas COMPLETADAS del turno:
--     { product_id, variant_id, name, qty, total }, ordenado por importe.
--     Máximo 200 líneas; el resto se suma en una línea "Otros productos"
--     (other = true) para que el Z no crezca sin límite.
--   * Lo arma un trigger BEFORE INSERT (SECURITY DEFINER, lee todas las
--     ventas del turno sin depender de la RLS del que cierra). No se recrea
--     close_cash_shift (lo recrean otras ramas; última definición
--     20261015120000): el trigger completa la columna en la misma fila que
--     inserta, así el Z sigue siendo append-only e inmutable.
--   * Los Z ya cerrados quedan con items_summary null (no se reescriben: el
--     Z es inmutable). La UI muestra "sin detalle" en esos.
-- =============================================================================

alter table cash_z_closures
  add column if not exists items_summary jsonb;

comment on column cash_z_closures.items_summary is
  'Ítems vendidos resumidos del turno (F11/H30b, ADR-085): [{product_id, variant_id, name, qty, total, other?}]. Lo arma el trigger czc_items_summary.';

create or replace function trg_czc_items_summary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_rest  jsonb;
begin
  if new.items_summary is not null then
    return new;
  end if;

  with lines as (
    select si.product_id,
           si.variant_id,
           min(si.product_name) as name,
           sum(si.quantity) as qty,
           sum(si.subtotal) as total
      from sale_items si
      join sales s on s.id = si.sale_id
     where s.cash_shift_id = new.cash_shift_id
       and s.tenant_id = new.tenant_id
       and s.status = 'completed'
     group by si.product_id, si.variant_id,
              case when si.product_id is null then si.product_name end
  ),
  ranked as (
    select l.*, row_number() over (order by l.total desc, l.qty desc, l.name) as rn
      from lines l
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
               'product_id', product_id, 'variant_id', variant_id, 'name', name,
               'qty', qty, 'total', round(total, 2))
             order by rn) filter (where rn <= 200), '[]'::jsonb),
    case when count(*) filter (where rn > 200) > 0 then
      jsonb_build_object('product_id', null, 'variant_id', null, 'name', 'Otros productos',
                         'qty', sum(qty) filter (where rn > 200),
                         'total', round(sum(total) filter (where rn > 200), 2),
                         'other', true)
    end
    into v_lines, v_rest
    from ranked;

  new.items_summary := coalesce(v_lines, '[]'::jsonb)
                       || case when v_rest is null then '[]'::jsonb else jsonb_build_array(v_rest) end;
  return new;
end;
$$;
revoke all on function trg_czc_items_summary() from public, anon, authenticated;

drop trigger if exists czc_items_summary on cash_z_closures;
create trigger czc_items_summary
  before insert on cash_z_closures
  for each row execute function trg_czc_items_summary();
