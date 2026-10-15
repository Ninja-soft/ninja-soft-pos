-- =============================================================================
-- Tesorería ordenada, fase 1 (F22 · ADR-150): dos arreglos chicos de la
-- auditoría (docs/46-tesoreria.md §1.4). SIN APLICAR.
--
--   A) acc_sync_sale_return: una devolución reintegrada por Mercado Pago
--      (refund_method = 'mercadopago', agregado en 20261030100100_reintegro_mp)
--      se acreditaba a la Caja del POS porque el CASE mandaba todo lo que no
--      era saldo a favor ni cuenta corriente a 'cash'. Ahora va a la cuenta del
--      cobro de Mercado Pago ('*:mercadopago': cualquier medio cobrado por MP,
--      en la plantilla "Mercado Pago a cobrar"), la misma que se debitó al
--      cobrar. Recreada desde su única definición (20261029100200, sin cambios
--      posteriores en producción); sólo cambia el CASE del reintegro.
--
--   B) _treasury_move: sin fecha, el movimiento tomaba current_date, que en
--      la base (TimeZone = UTC) es el día siguiente entre las 21 y las 24 de
--      Argentina. Ahora toma la fecha argentina, como la Contabilidad
--      (acc_ar_date). Recreada desde su única definición (20261022100300).
--      cheque_transition, la anulación de la orden de pago y acc_period_close
--      tienen el mismo problema con current_date: quedan para H150.
--
-- Los asientos ya generados no cambian (son inmutables). Un negocio con una
-- devolución por MP ya contabilizada la corrige regenerando el mes abierto
-- (Contabilidad > Resumen > Regenerar) o con un contra-asiento manual.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Devolución reintegrada por Mercado Pago
-- -----------------------------------------------------------------------------
create or replace function acc_sync_sale_return(p_tenant uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r sale_returns%rowtype;
  s sales%rowtype;
  cfg acc_settings%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_items jsonb;
  v_acc numeric;
  v_rest numeric;
  v_cost numeric;
  v record;
begin
  select * into r from sale_returns where id = p_id and tenant_id = p_tenant;
  if not found or coalesce(r.total, 0) <= 0 then
    return;
  end if;
  select * into cfg from acc_settings where tenant_id = p_tenant;
  if acc_ar_date(r.created_at) < cfg.start_date or acc_entry_of(p_tenant, 'sale_return', r.id, 'return') is not null then
    return;
  end if;
  select * into s from sales where id = r.sale_id;

  select coalesce(jsonb_agg(jsonb_build_object('amount', ri.subtotal, 'rate', pr.tax_rate)), '[]'::jsonb)
    into v_items
    from sale_return_items ri
    join sale_items si on si.id = ri.sale_item_id
    left join products pr on pr.id = si.product_id
   where ri.return_id = r.id;
  for v in select * from acc_vat_split(r.total, v_items, cfg.vat_mode, cfg.default_vat_rate) loop
    v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'devoluciones_ventas', '*', s.store_id), v.net, 'Devolución');
    if v.vat <> 0 then
      v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'iva_df', acc_rate_text(v.rate), s.store_id),
                                     v.vat, 'IVA ' || acc_rate_text(v.rate) || ' %');
    end if;
  end loop;

  v_acc := least(coalesce(r.account_credited, 0), r.total);
  v_rest := r.total - v_acc;
  if v_acc > 0 then
    v_lines := v_lines || acc_line(acc_account_for(p_tenant, 'cobro', 'account', s.store_id), -v_acc, 'A cuenta corriente');
  end if;
  if v_rest > 0 then
    v_lines := v_lines || acc_line(
      acc_account_for(p_tenant, 'cobro',
                      case r.refund_method when 'store_credit' then 'store_credit'
                                           when 'account' then 'account'
                                           when 'mercadopago' then '*:mercadopago'
                                           else 'cash' end,
                      s.store_id),
      -v_rest, case when r.refund_method = 'mercadopago' then 'Reintegro por Mercado Pago' else 'Reintegro' end);
  end if;

  if cfg.cmv_mode = 'perpetual' then
    select round(coalesce(sum(ri.quantity * coalesce(pr.cost, 0)), 0), 2) into v_cost
      from sale_return_items ri
      join sale_items si on si.id = ri.sale_item_id
      join products pr on pr.id = si.product_id
     where ri.return_id = r.id and ri.restock = 'stock';
    if v_cost > 0 then
      v_lines := v_lines
        || acc_line(acc_account_for(p_tenant, 'mercaderias', '*', s.store_id), v_cost, 'Reingreso de mercadería')
        || acc_line(acc_account_for(p_tenant, 'cmv', '*', s.store_id), -v_cost, 'Costo de lo devuelto');
    end if;
  end if;

  perform acc_post(p_tenant, acc_ar_date(r.created_at), 'sale_return', r.id, 'return',
                   'Devolución #' || r.number || ' de la venta #' || s.number, s.store_id, v_lines);
end;
$$;
revoke all on function acc_sync_sale_return(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Fecha por defecto de los movimientos de tesorería en hora argentina
-- -----------------------------------------------------------------------------
create or replace function _treasury_move(p_tenant uuid, p_account uuid, p_date date, p_amount numeric,
                                          p_type text, p_description text, p_reference_type text default null,
                                          p_reference_id uuid default null, p_cheque uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into treasury_movements (tenant_id, account_id, movement_date, amount, type, description,
                                  reference_type, reference_id, cheque_id, created_by)
  values (p_tenant, p_account,
          coalesce(p_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
          round(p_amount, 2), p_type,
          nullif(trim(coalesce(p_description, '')), ''), p_reference_type, p_reference_id, p_cheque, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function _treasury_move(uuid, uuid, date, numeric, text, text, text, uuid, uuid)
  from public, anon, authenticated;
